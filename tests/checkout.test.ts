import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { billKey, type CheckoutStart, type FacilityRegistrationResult } from '#shared';
import { buildApp } from '../src/app.ts';
import { confirmCheckout, reconcileCheckouts } from '../src/billing/checkout.ts';
import { sealPaystackSecret } from '../src/billing/paystack.ts';
import { insertRecord } from '../src/db/records.ts';
import { createDocumentLink } from '../src/patientDocuments/links.ts';
import { loadBill } from '../src/patientDocuments/documentData.ts';
import { config, envelopeFor, registerScratchFacility, scratchDatabase, signer, type ScratchDatabase } from './postgres.ts';

const masterKey = '12'.repeat(32);
const liveKey = 'sk_live_FictionalCheckoutKey';
const sandboxKey = 'sk_test_FictionalCheckoutKey';
const checkoutConfig = { ...config, billingEncryptionKey: masterKey };

type Verification = {
  status: string;
  amount: number;
  currency: string;
  domain: 'test' | 'live';
  reference: string;
};

describe('patient bill checkout', () => {
  let db: ScratchDatabase;
  let facility: FacilityRegistrationResult;
  let app: FastifyInstance;
  let patientId: string;
  let cashSequence = 700_000;
  const starts = new Map<string, Record<string, unknown>>();
  const verifications = new Map<string, Verification>();
  const authorization = new Map<string, string>();

  const http: typeof fetch = async (url, init) => {
    const address = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const headers = init?.headers as Record<string, string>;
    let data: unknown;

    if (address.pathname === '/transaction/initialize') {
      const reference = String(body.reference);
      starts.set(reference, body);
      data = { reference, authorization_url: `https://checkout.paystack.com/${reference}` };
    } else if (address.pathname.startsWith('/transaction/verify/')) {
      const reference = decodeURIComponent(address.pathname.split('/').at(-1)!);
      authorization.set(reference, headers.authorization);
      data = {
        ...verifications.get(reference),
        reference,
        ...(verifications.has(reference) ? {} : { status: 'pending', amount: 0, currency: 'NGN', domain: 'live' }),
        paid_at: '2026-11-22T00:00:00.000Z',
      };
    } else if (address.pathname === '/api/v1/auth/login') {
      return Response.json({ requestSuccessful: true, responseBody: { accessToken: 'synthetic-token', expiresIn: 3600 } });
    } else if (address.pathname.endsWith('/init-transaction')) {
      const reference = String(body.paymentReference);
      starts.set(reference, body);
      return Response.json({ requestSuccessful: true, responseBody: {
        paymentReference: reference,
        checkoutUrl: `https://checkout.monnify.com/${reference}`,
      } });
    } else if (address.pathname.endsWith('/query')) {
      const reference = address.searchParams.get('paymentReference')!;
      const verification = verifications.get(reference);
      return Response.json({ requestSuccessful: true, responseBody: {
        paymentReference: reference,
        paymentStatus: verification?.status === 'success' ? 'PAID' : 'PENDING',
        amountPaid: String((verification?.amount ?? 0) / 100),
        currencyCode: verification?.currency ?? 'NGN',
        paidOn: '2026-11-22T00:00:00.000Z',
      } });
    } else {
      throw new Error(`Unexpected synthetic provider call: ${address.pathname}`);
    }

    return Response.json({ status: true, data });
  };

  const connect = async (mode: 'test' | 'live' = 'live', provider = 'paystack') => {
    let credentials = mode === 'live' ? liveKey : sandboxKey;

    if (provider === 'monnify') {
      credentials = JSON.stringify({
        apiKey: mode === 'live' ? 'MK_PROD_Fictional1' : 'MK_TEST_Fictional1',
        secretKey: 'FictionalMonnifySecret0001',
        contractCode: '1234567890',
      });
    }

    const sealed = sealPaystackSecret(credentials, masterKey, facility.facility.id);
    await db.sql`INSERT INTO billing_connections (facility_id, provider, encrypted_secret, mode, updated_by)
      VALUES (${facility.facility.id}, ${provider}, ${sealed}, ${mode}, ${facility.admin.id})
      ON CONFLICT (facility_id) DO UPDATE SET provider = EXCLUDED.provider,
        encrypted_secret = EXCLUDED.encrypted_secret, mode = EXCLUDED.mode`;
  };

  const makeBill = async (amounts = [10_000], currency = 'NGN') => {
    const billId = randomUUID();
    const charges = [];

    for (const [index, amountMinor] of amounts.entries()) {
      const charge = {
        ...envelopeFor(facility),
        id: `charge:${randomUUID()}`,
        type: 'charge' as const,
        patientId,
        feeItemId: 'fee:synthetic',
        category: 'laboratory' as const,
        description: `Synthetic item ${index + 1}`,
        listPriceMinor: amountMinor,
        amountMinor,
        currency,
        billId,
        createdOn: new Date(Date.now() - (amounts.length - index) * 1000).toISOString(),
      };

      await insertRecord(db.sql, 'charge', charge);
      charges.push(charge);
    }

    const key = billKey(charges[0]);
    const link = await createDocumentLink(db.sql, {
      facilityId: facility.facility.id,
      kind: 'bill',
      subject: key,
      patientId,
      createdBy: facility.admin.id,
    });
    const api = `/public/documents/bill/${link.token}`;

    return { api, key, charges };
  };

  const start = async (api: string): Promise<CheckoutStart> => {
    const response = await app.inject({ method: 'POST', url: `${api}/pay`, payload: {} });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  const markPaid = (checkout: CheckoutStart, extra: Partial<Verification> = {}) => {
    verifications.set(checkout.reference, {
      status: 'success',
      reference: checkout.reference,
      amount: checkout.amountMinor,
      currency: checkout.currency,
      domain: 'live',
      ...extra,
    });
  };

  const receiveCash = async (chargeId: string, amountMinor: number) => {
    await insertRecord(db.sql, 'payment', {
      ...envelopeFor(facility),
      id: `payment:${randomUUID()}`,
      type: 'payment',
      patientId,
      receiptNumber: `${facility.facility.id}-R-${cashSequence++}-K2`,
      method: 'cash',
      amountMinor,
      currency: 'NGN',
      allocations: [{ chargeId, amountMinor }],
    });
  };

  before(async () => {
    db = await scratchDatabase();
    facility = await registerScratchFacility(db.sql);
    patientId = `${facility.facility.id}-000001-K2`;
    await insertRecord(db.sql, 'patient', {
      ...envelopeFor(facility),
      id: patientId,
      type: 'patient',
      patientId,
      fullName: 'Synthetic Checkout Patient',
      address: 'Synthetic address',
      sex: 'female',
      ageYears: 30,
    });
    await insertRecord(db.sql, 'fee_item', {
      ...envelopeFor(facility),
      id: 'fee:synthetic',
      type: 'fee_item',
      name: 'Synthetic checkout fee',
      category: 'laboratory',
      amountMinor: 10_000,
      currency: 'NGN',
      chargeWhen: 'when_ordered',
      exemptions: [],
    });
    await db.sql`UPDATE facilities SET email = 'hospital@example.org' WHERE id = ${facility.facility.id}`;
    app = buildApp({ config: checkoutConfig, sql: db.sql, signer, paystackFetch: http }, {
      logger: false,
      rateLimit: false,
    });
    await connect();
  });

  after(async () => {
    await app?.close();
    await db?.drop();
  });

  it('starts from the accepted bill balance and falls back to the hospital contact email', async () => {
    const bill = await makeBill([12_000, 8_000]);
    const page = await app.inject({ method: 'GET', url: bill.api });
    assert.equal(page.json().bill.payable, true);
    const checkout = await start(bill.api);
    assert.equal(checkout.amountMinor, 20_000);
    assert.equal(starts.get(checkout.reference)?.email, 'hospital@example.org');
    const callback = new URL(String(starts.get(checkout.reference)?.callback_url));
    assert.equal(callback.searchParams.get('checkout'), checkout.reference);
    assert.ok(callback.pathname.startsWith('/p/b/'));
    const [session] = await db.sql`SELECT charge_ids FROM checkout_sessions WHERE reference = ${checkout.reference}`;
    assert.deepEqual(new Set(session.charge_ids), new Set(bill.charges.map((charge) => charge.id)));
  });

  it('settles once under concurrent return checks and queues one automatic receipt', async () => {
    const bill = await makeBill();
    const checkout = await start(bill.api);
    markPaid(checkout);
    const outcomes = await Promise.all(Array.from({ length: 4 }, () =>
      app.inject({ method: 'GET', url: `${bill.api}/checkout/${checkout.reference}` })));
    assert.ok(outcomes.every((response) => response.statusCode === 200 && response.json().status === 'paid'));
    const payments = await db.sql`SELECT id, method, amount_minor FROM payments WHERE reference = ${checkout.reference}`;
    assert.equal(payments.length, 1);
    assert.equal(payments[0].method, 'online');
    assert.equal(payments[0].amount_minor, checkout.amountMinor);
    assert.equal((await loadBill(db.sql, facility.facility.id, bill.key))?.totals.dueMinor, 0);
    const queued = await db.sql`SELECT * FROM patient_receipt_queue WHERE payment_id = ${payments[0].id}`;
    assert.equal(queued.length, 1);
    const pdf = await app.inject({ method: 'GET', url: `${bill.api}/checkout/${checkout.reference}/receipt` });
    assert.equal(pdf.statusCode, 200, pdf.body);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
  });

  it('allocates oldest first and holds money paid in cash while checkout was open', async () => {
    const bill = await makeBill([6_000, 4_000]);
    const checkout = await start(bill.api);
    await receiveCash(bill.charges[0].id, 3_000);
    markPaid(checkout);
    const state = await confirmCheckout(db.sql, checkoutConfig, checkout.reference, http);
    assert.equal(state?.heldMinor, 3_000);
    const [payment] = await db.sql`SELECT allocations, amount_minor FROM payments WHERE reference = ${checkout.reference}`;
    assert.equal(payment.amount_minor, 7_000);
    assert.deepEqual(payment.allocations, [
      { chargeId: bill.charges[0].id, amountMinor: 3_000 },
      { chargeId: bill.charges[1].id, amountMinor: 4_000 },
    ]);
    const [source] = await db.sql`SELECT amount_minor, channel FROM incoming_transfers WHERE provider_reference = ${checkout.reference}`;
    assert.equal(source.amount_minor, 10_000);
    assert.equal(source.channel, 'checkout');
  });

  it('holds the full amount when the bill was settled during checkout', async () => {
    const bill = await makeBill();
    const checkout = await start(bill.api);
    await receiveCash(bill.charges[0].id, checkout.amountMinor);
    markPaid(checkout);
    const state = await confirmCheckout(db.sql, checkoutConfig, checkout.reference, http);
    assert.equal(state?.status, 'paid');
    assert.equal(state?.heldMinor, checkout.amountMinor);
    assert.equal((await db.sql`SELECT id FROM payments WHERE reference = ${checkout.reference}`).length, 0);
  });

  it('never applies a checkout to charges added after it started', async () => {
    const bill = await makeBill();
    const checkout = await start(bill.api);
    await receiveCash(bill.charges[0].id, checkout.amountMinor);
    await insertRecord(db.sql, 'charge', {
      ...bill.charges[0],
      id: `charge:${randomUUID()}`,
      createdOn: new Date().toISOString(),
    });
    markPaid(checkout);
    assert.equal((await confirmCheckout(db.sql, checkoutConfig, checkout.reference, http))?.heldMinor, checkout.amountMinor);
    assert.equal((await loadBill(db.sql, facility.facility.id, bill.key))?.totals.dueMinor, 10_000);
  });

  it('refuses mismatched amounts, currency and provider mode without recording any money', async () => {
    for (const change of [{ amount: 1 }, { currency: 'USD' }, { domain: 'test' as const }]) {
      const bill = await makeBill();
      const checkout = await start(bill.api);
      markPaid(checkout, change);
      const response = await app.inject({ method: 'GET', url: `${bill.api}/checkout/${checkout.reference}` });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal((await db.sql`SELECT id FROM incoming_transfers WHERE provider_reference = ${checkout.reference}`).length, 0);
    }
  });

  it('records sandbox money separately and leaves real charges unpaid', async () => {
    await connect('test');
    const bill = await makeBill();
    const checkout = await start(bill.api);
    markPaid(checkout, { domain: 'test' });
    const state = await confirmCheckout(db.sql, checkoutConfig, checkout.reference, http);
    assert.equal(state?.status, 'failed');
    assert.equal((await loadBill(db.sql, facility.facility.id, bill.key))?.totals.dueMinor, checkout.amountMinor);
    assert.equal((await db.sql`SELECT id FROM payments WHERE reference = ${checkout.reference}`).length, 0);
    const [source] = await db.sql`SELECT mode FROM incoming_transfers WHERE provider_reference = ${checkout.reference}`;
    assert.equal(source.mode, 'test');
    await connect();
  });

  it('uses the original encrypted connection even after hospital settings change', async () => {
    const bill = await makeBill();
    const checkout = await start(bill.api);
    await connect('test');
    markPaid(checkout);
    assert.equal((await confirmCheckout(db.sql, checkoutConfig, checkout.reference, http))?.status, 'paid');
    assert.equal(authorization.get(checkout.reference), `Bearer ${liveKey}`);
    await connect();
  });

  it('accepts the original signed webhook after the hospital switches providers', async () => {
    const bill = await makeBill();
    const checkout = await start(bill.api);
    await connect('live', 'monnify');
    markPaid(checkout);
    const payload = { event: 'charge.success', data: { reference: checkout.reference } };
    const signature = createHmac('sha512', liveKey).update(JSON.stringify(payload)).digest('hex');
    const response = await app.inject({
      method: 'POST',
      url: `/billing/paystack/${facility.facility.id}/webhook`,
      headers: { 'x-paystack-signature': signature },
      payload,
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await loadBill(db.sql, facility.facility.id, bill.key))?.totals.dueMinor, 0);
    await connect();
  });

  it('requires a valid signed webhook and verifies it directly before settlement', async () => {
    const bill = await makeBill();
    const checkout = await start(bill.api);
    markPaid(checkout);
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: checkout.reference } });
    const signature = createHmac('sha512', liveKey).update(raw).digest('hex');
    const url = `/billing/paystack/${facility.facility.id}/webhook`;
    const refused = await app.inject({ method: 'POST', url, payload: JSON.parse(raw) });
    assert.equal(refused.statusCode, 401);
    const response = await app.inject({ method: 'POST', url, headers: { 'x-paystack-signature': signature }, payload: JSON.parse(raw) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await loadBill(db.sql, facility.facility.id, bill.key))?.totals.dueMinor, 0);
  });

  it('does not expose another link checkout or receipt', async () => {
    const bill = await makeBill();
    const other = await makeBill();
    const checkout = await start(bill.api);
    markPaid(checkout);
    await confirmCheckout(db.sql, checkoutConfig, checkout.reference, http);
    for (const suffix of ['', '/receipt']) {
      const response = await app.inject({ method: 'GET', url: `${other.api}/checkout/${checkout.reference}${suffix}` });
      assert.equal(response.statusCode, 404);
    }
    await db.sql`UPDATE patient_document_links SET stopped_on = now(), stopped_by = ${facility.admin.id}
      WHERE subject = ${bill.key}`;
    assert.equal((await app.inject({ method: 'POST', url: `${bill.api}/pay`, payload: {} })).statusCode, 404);
  });

  it('rechecks expired sessions for late payments and recovers missed callbacks', async () => {
    const bill = await makeBill();
    const checkout = await start(bill.api);
    await db.sql`UPDATE checkout_sessions SET expires_on = now() - interval '1 minute' WHERE reference = ${checkout.reference}`;
    assert.equal((await confirmCheckout(db.sql, checkoutConfig, checkout.reference, http))?.status, 'expired');
    markPaid(checkout);
    await db.sql`UPDATE checkout_sessions SET checked_on = NULL WHERE reference = ${checkout.reference}`;
    await reconcileCheckouts(db.sql, checkoutConfig, { warn: () => undefined }, http);
    assert.equal((await loadBill(db.sql, facility.facility.id, bill.key))?.totals.dueMinor, 0);
  });

  it('supports Monnify checkout, direct verification and its paymentReference webhook', async () => {
    await connect('live', 'monnify');
    const bill = await makeBill();
    const checkout = await start(bill.api);
    assert.equal(starts.get(checkout.reference)?.amount, '100.00');
    markPaid(checkout);
    const raw = JSON.stringify({
      eventType: 'SUCCESSFUL_TRANSACTION',
      eventData: { transactionReference: 'MNFY|synthetic', paymentReference: checkout.reference },
    });
    const signature = createHmac('sha512', 'FictionalMonnifySecret0001').update(raw).digest('hex');
    const response = await app.inject({
      method: 'POST',
      url: `/billing/monnify/${facility.facility.id}/webhook`,
      headers: { 'monnify-signature': signature },
      payload: JSON.parse(raw),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await loadBill(db.sql, facility.facility.id, bill.key))?.totals.dueMinor, 0);
    await connect();
  });

  it('refuses paid bills and unsupported currencies before opening a checkout', async () => {
    const paid = await makeBill();
    await receiveCash(paid.charges[0].id, 10_000);
    assert.equal((await app.inject({ method: 'POST', url: `${paid.api}/pay`, payload: {} })).statusCode, 409);
    const foreign = await makeBill([10_000], 'USD');
    assert.equal((await app.inject({ method: 'GET', url: foreign.api })).json().bill.payable, false);
    assert.equal((await app.inject({ method: 'POST', url: `${foreign.api}/pay`, payload: {} })).statusCode, 409);
  });
});
