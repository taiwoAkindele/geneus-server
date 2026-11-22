import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult } from '#shared';
import { buildApp } from '../src/app.ts';
import { resetMonnifyTokens } from '../src/billing/providers/monnify.ts';
import { issuePinSetupCode } from '../src/staff/pinSetupCodes.ts';
import {
  config,
  signer,
  registerScratchFacility,
  scratchDatabase,
  type ScratchDatabase,
} from './postgres.ts';

// Fictional keys and provider replies only. Monnify replies follow its documentation; plan step 0 confirms them in the sandbox.
describe('payment providers: one central account, switching provider, Monnify verification', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let facility: FacilityRegistrationResult;
  const master = 'ef'.repeat(32);
  const paystackKey = 'sk_test_FictionalProviderRoutes';
  const monnify = {
    apiKey: 'MK_TEST_FICTIONALROUTES',
    secretKey: 'FictionalMonnifySecret01',
    contractCode: '1234567890',
  };
  const bvn = '22222222222';
  let paystackRefusal = false;
  let monnifyStatus = 'PAID';
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher: typeof fetch = async (url, init) => {
    const { hostname, pathname } = new URL(String(url));
    if (hostname === 'api.paystack.co') {
      if (paystackRefusal && pathname === '/dedicated_account' && init?.method === 'POST') {
        return json(
          { status: false, message: 'Dedicated NUBAN is not available for your business' },
          403,
        );
      }
      if (pathname === '/transaction') {
        return json({ status: true, data: [] });
      }
      if (pathname === '/customer') {
        return json({ status: true, data: { customer_code: 'CUS_fictional' } });
      }
      if (pathname === '/dedicated_account') {
        return json({
          status: true,
          data: {
            id: 501,
            account_number: '9930000501',
            account_name: 'PAYSTACK-TEST/Fictional',
            active: true,
            currency: 'NGN',
            bank: { name: 'Test Bank' },
          },
        });
      }
      return json({ status: false, message: 'Not found' }, 404);
    }
    if (hostname === 'sandbox.monnify.com') {
      if (pathname === '/api/v1/auth/login') {
        return json({
          requestSuccessful: true,
          responseBody: { accessToken: 'token', expiresIn: 3600 },
        });
      }
      if (pathname.startsWith('/api/v2/bank-transfer/reserved-accounts')) {
        return json({
          requestSuccessful: true,
          responseBody: {
            accountReference: `geneus-${facility.facility.id}`,
            accountName: 'Fictional Hospital',
            currencyCode: 'NGN',
            status: 'ACTIVE',
            accounts: [
              {
                bankCode: '035',
                bankName: 'Wema Bank',
                accountNumber: '6000000777',
                accountName: 'Fictional Hospital',
              },
            ],
          },
        });
      }
      if (pathname.startsWith('/api/v2/transactions/')) {
        const reference = decodeURIComponent(pathname.split('/').at(-1)!);
        return json({
          requestSuccessful: true,
          responseBody: {
            transactionReference: reference,
            paymentStatus: monnifyStatus,
            amountPaid: '7500.50',
            currencyCode: 'NGN',
            paidOn: '2026-11-21 10:15:00.000',
            product: { type: 'RESERVED_ACCOUNT', reference: `geneus-${facility.facility.id}` },
            paymentSourceInformation: [{ accountName: 'Fictional Payer' }],
          },
        });
      }
    }
    return json({ status: false, message: 'Unexpected host' }, 404);
  };
  let session: string | undefined;
  const post = async (path: string, body: Record<string, unknown>) => {
    if (!session) {
      const proof = await issuePinSetupCode(db.sql, {
        facilityId: facility.facility.id,
        staffId: facility.admin.id,
        issuedBy: facility.admin.id,
        issuedFrom: facility.device.deviceId,
      });
      assert.ok(proof.ok);
      const response = await app.inject({
        method: 'POST',
        url: '/staff/session/enrol',
        headers: { authorization: `Bearer ${facility.device.credential}` },
        payload: { staffId: facility.admin.id, pin: '246810', setupCode: proof.code },
      });
      assert.equal(response.statusCode, 200, response.body);
      session = response.json().token;
    }
    return app.inject({
      method: 'POST',
      url: `/billing/${path}`,
      headers: {
        authorization: `Bearer ${facility.device.credential}`,
        'x-staff-session': session!,
        'x-actor-staff-id': facility.admin.id,
      },
      payload: body,
    });
  };
  const monnifyWebhook = (reference: string, secret = monnify.secretKey, provider = 'monnify') => {
    const raw = JSON.stringify({
      eventType: 'SUCCESSFUL_TRANSACTION',
      eventData: {
        transactionReference: reference,
        amountPaid: 1,
        product: { type: 'RESERVED_ACCOUNT' },
      },
    });
    return app.inject({
      method: 'POST',
      url: `/billing/${provider}/${facility.facility.id}/webhook`,
      headers: {
        'content-type': 'application/json',
        'monnify-signature': createHmac('sha512', secret).update(raw).digest('hex'),
      },
      payload: raw,
    });
  };

  before(async () => {
    resetMonnifyTokens();
    db = await scratchDatabase();
    facility = await registerScratchFacility(db.sql);
    app = buildApp(
      {
        config: { ...config, billingEncryptionKey: master },
        sql: db.sql,
        signer,
        paystackFetch: fetcher,
      },
      { logger: false, rateLimit: false },
    );
  });
  after(async () => {
    if (app) {
      await app.close();
    }
    if (db) {
      await db.drop();
    }
  });

  it('lists the supported providers with their fields and no secrets', async () => {
    const response = await post('providers', {});
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().providers.map((p: { id: string }) => p.id),
      ['paystack', 'monnify'],
    );
  });
  it('shows the provider’s refusal reason without naming the provider', async () => {
    assert.equal(
      (await post('connection', { provider: 'paystack', credentials: { secretKey: paystackKey } }))
        .statusCode,
      200,
    );
    paystackRefusal = true;
    const refused = await post('accounts/create', {
      details: { email: 'accounts@hospital.test', phone: '+2348031234567' },
    });
    paystackRefusal = false;
    assert.equal(refused.statusCode, 502);
    assert.deepEqual(refused.json(), {
      error: 'provider_refused',
      message:
        'The provider refused this operation: Dedicated NUBAN is not available for your business.',
    });
  });
  it('creates the hospital’s Paystack dedicated account as its central account', async () => {
    const created = await post('accounts/create', {
      details: { email: 'accounts@hospital.test', phone: '+2348031234567' },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().accountNumber, '9930000501');
    assert.equal(
      (await post('connection/status', {})).json().receivingAccountId,
      created.json().id,
    );
  });
  it('switches to Monnify: keys stored encrypted, the old account no longer central, the old webhook refused', async () => {
    const response = await post('connection', { provider: 'monnify', credentials: monnify });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { configured: true, provider: 'monnify', mode: 'test' });
    const [saved] =
      await db.sql`SELECT provider, encrypted_secret, receiving_account_id FROM billing_connections WHERE facility_id = ${facility.facility.id}`;
    assert.equal(saved.provider, 'monnify');
    assert.equal(saved.receiving_account_id, null);
    assert(
      !saved.encrypted_secret.includes(monnify.secretKey) &&
        !saved.encrypted_secret.includes(monnify.apiKey),
    );
    const status = (await post('connection/status', {})).json();
    assert.equal(status.provider, 'monnify');
    assert.equal(status.webhookPath, `/billing/monnify/${facility.facility.id}/webhook`);
    const paystackHook = await app.inject({
      method: 'POST',
      url: `/billing/paystack/${facility.facility.id}/webhook`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    assert.equal(paystackHook.statusCode, 409);
  });
  it('creates one Monnify reserved account; the BVN reaches Monnify only', async () => {
    const created = await post('accounts/create', {
      details: { bank: '035', email: 'accounts@hospital.test', bvn },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().accountNumber, '6000000777');
    assert.equal(created.json().bankName, 'Wema Bank');
    const [account] =
      await db.sql`SELECT provider, provider_account_id FROM billing_receiving_accounts WHERE id = ${created.json().id}`;
    assert.equal(account.provider, 'monnify');
    assert.equal(account.provider_account_id, `geneus-${facility.facility.id}`);
    const stored = JSON.stringify([
      ...(await db.sql`SELECT * FROM billing_receiving_accounts`),
      ...(await db.sql`SELECT metadata FROM audit_events`),
    ]);
    assert(!stored.includes(bvn), 'the BVN is never stored or audited');
  });
  it('records a Monnify transfer once, after verifying it, against the hospital’s account', async () => {
    assert.equal((await monnifyWebhook('MNFY|ROUTES|1', 'wrong-secret-000000000')).statusCode, 401);
    assert.equal(
      (await monnifyWebhook('MNFY|ROUTES|1', monnify.secretKey, 'unknownpay')).statusCode,
      404,
    );
    const responses = await Promise.all([
      monnifyWebhook('MNFY|ROUTES|1'),
      monnifyWebhook('MNFY|ROUTES|1'),
    ]);
    for (const r of responses) {
      assert.equal(r.statusCode, 200, r.body);
    }
    const rows =
      await db.sql`SELECT * FROM incoming_transfers WHERE provider_reference = 'MNFY|ROUTES|1'`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, 'monnify');
    assert.equal(rows[0].amount_minor, 750050);
    assert.equal(rows[0].mode, 'test');
    assert.equal(rows[0].receiving_account, '6000000777');
    assert.equal(rows[0].payer_name, 'Fictional Payer');
  });
  it('refuses a reference Monnify does not report as paid', async () => {
    monnifyStatus = 'PENDING';
    const response = await post('transfers/import', { reference: 'MNFY|ROUTES|2' });
    monnifyStatus = 'PAID';
    assert.equal(response.statusCode, 409);
    assert.equal(
      (
        await db.sql`SELECT count(*)::int AS n FROM incoming_transfers WHERE provider_reference = 'MNFY|ROUTES|2'`
      )[0].n,
      0,
    );
  });
});
