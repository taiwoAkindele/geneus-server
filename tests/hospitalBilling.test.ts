import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, Staff } from '#shared';
import { buildApp } from '../src/app.ts';
import { findRecord, insertRecord } from '../src/db/records.ts';
import { config, signer, addStaff, clientId, envelopeFor, registerScratchFacility, scratchDatabase, upload, type ScratchDatabase } from './postgres.ts';

describe('hospital department billing and Paystack reconciliation', () => {
  let db: ScratchDatabase; let app: FastifyInstance; let facility: FacilityRegistrationResult; let other: FacilityRegistrationResult;
  let cashier: Staff; let nurse: Staff;
  const secret = 'sk_live_FictionalBillingTestKey'; const master = 'ab'.repeat(32);
  let calls = 0;
  const account = (id: string) => ({ id: Number(id), account_number: id === '101' ? '9910000001' : '9910000002', account_name: `Test department ${id}`, active: true, currency: 'NGN', bank: { name: 'Test bank' } });
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    const path = new URL(String(url)).pathname;
    let data: unknown;
    if (path === '/transaction') data = [];
    else if (path === '/virtual_terminal') data = { code: 'VT_DENTAL', active: true, currency: 'NGN', paymentMethods: [{ type: 'dedicated_nuban', account_number: '9910000003', account_name: 'Test hospital / Dental', bank: 'Test bank' }] };
    else if (path.startsWith('/virtual_terminal/')) data = { code: path.split('/').at(-1), active: true, currency: 'NGN', paymentMethods: [{ type: 'dedicated_nuban', account_number: '9910000004', account_name: 'Test hospital / GS', bank: 'Test bank' }] };
    else if (path === '/dedicated_account') data = [account('101'), account('102')];
    else if (path.startsWith('/dedicated_account/')) data = account(path.split('/').at(-1)!);
    else {
      const reference = decodeURIComponent(path.split('/').at(-1)!);
      const requestMode = String((options?.headers as Record<string, string>)?.authorization).includes('sk_test_') ? 'test' : 'live';
      data = { reference, status: 'success', amount: reference === 'race' ? 50000 : 120000, currency: 'NGN', domain: reference === 'wrong-mode' ? 'test' : requestMode, paid_at: new Date().toISOString(),
        authorization: { channel: 'dedicated_nuban', receiver_bank_account_number: reference === 'unlinked' ? '9999999999' : '9910000001', sender_name: 'Fictional Payer' } };
    }
    return new Response(JSON.stringify({ status: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const post = (path: string, body: Record<string, unknown>, credential = facility.device.credential) => app.inject({ method: 'POST', url: `/billing/${path}`, headers: { authorization: `Bearer ${credential}` }, payload: body });
  const notify = (reference: string, valid = true) => {
    // The received amount is deliberately false: only server verification supplies the ledger amount.
    const raw = JSON.stringify({ event: 'charge.success', data: { reference, amount: 1 } });
    const signature = createHmac('sha512', valid ? secret : 'wrong').update(raw).digest('hex');
    return app.inject({ method: 'POST', url: `/billing/paystack/${facility.facility.id}/webhook`, headers: { 'content-type': 'application/json', 'x-paystack-signature': signature }, payload: raw });
  };
  const patient = (n = '000001') => `${facility.facility.id}-${n}-K2`;
  const match = (source: string, chargeId: string, amountMinor: number, requestId = randomUUID(), patientId = patient()) => post(`transfers/${encodeURIComponent(source)}/match`, {
    actorStaffId: cashier.id, patientId, allocations: [{ chargeId, amountMinor }], requestId,
  });
  before(async () => {
    db = await scratchDatabase(); facility = await registerScratchFacility(db.sql); other = await registerScratchFacility(db.sql);
    cashier = await addStaff(db.sql, facility, { role: 'cashier' }); nurse = await addStaff(db.sql, facility, { role: 'nurse' });
    app = buildApp({ config: { ...config, billingEncryptionKey: master }, sql: db.sql, signer, paystackFetch: fetcher }, { logger: false, rateLimit: false });
    const envelope = { ...envelopeFor(facility), createdBy: facility.admin.id };
    for (const id of ['pharmacy', 'oncology', 'dental', 'gs']) await insertRecord(db.sql, 'billing_department', { ...envelope, id, type: 'billing_department', name: id });
    for (const n of ['000001', '000002']) await insertRecord(db.sql, 'patient', { ...envelope, id: patient(n), patientId: patient(n), type: 'patient', fullName: `Test Patient ${n}`, address: 'Test address', sex: 'female', ageYears: 30 });
    for (const departmentId of ['pharmacy', 'oncology']) {
      await insertRecord(db.sql, 'fee_item', { ...envelope, id: `fee:${departmentId}`, type: 'fee_item', name: departmentId, departmentId, category: 'procedure', amountMinor: 100000, currency: 'NGN', chargeWhen: 'when_ordered' });
      for (const n of ['000001', '000002']) await insertRecord(db.sql, 'charge', { ...envelope, id: `charge:${departmentId}:${n}`, type: 'charge', patientId: patient(n), feeItemId: `fee:${departmentId}`, departmentId, category: 'procedure', description: 'Test service', listPriceMinor: 100000, amountMinor: 100000, currency: 'NGN' });
    }
  });
  after(async () => { if (app) await app.close(); if (db) await db.drop(); });
  it('connects only with management permission, and never returns or stores plaintext keys', async () => {
    assert.equal((await post('connection', { actorStaffId: cashier.id, secretKey: secret })).statusCode, 403);
    const response = await post('connection', { actorStaffId: facility.admin.id, secretKey: secret });
    assert.equal(response.statusCode, 200); assert(!response.body.includes(secret));
    const [saved] = await db.sql`SELECT encrypted_secret FROM billing_connections WHERE facility_id = ${facility.facility.id}`;
    assert(saved.encrypted_secret !== secret); assert(!saved.encrypted_secret.includes(secret));
    const state = await post('connection/status', { actorStaffId: facility.admin.id });
    assert.equal(state.json().mode, 'live'); assert(!state.body.includes(secret));
  });
  it('links multiple department accounts within the hospital connection and retains account ownership', async () => {
    for (const [providerAccountId, departmentId] of [['101', 'pharmacy'], ['102', 'oncology']]) {
      const response = await post('accounts/link', { actorStaffId: facility.admin.id, providerAccountId, departmentId });
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().departmentId, departmentId);
    }
    assert.equal((await post('accounts/link', { actorStaffId: facility.admin.id, providerAccountId: '101', departmentId: 'oncology' })).statusCode, 409);
    assert.equal((await post('connection/status', { actorStaffId: facility.admin.id }, other.device.credential)).statusCode, 403);
  });
  it('rejects invalid signatures without querying Paystack or creating receipts', async () => {
    const before = calls; assert.equal((await notify('forged', false)).statusCode, 401); assert.equal(calls, before);
    const [row] = await db.sql`SELECT count(*)::int AS n FROM incoming_transfers`; assert.equal(row.n, 0);
  });
  it('creates named department payment points and links existing virtual terminals without patient checkout', async () => {
    const created = await post('accounts/create-terminal', { actorStaffId: facility.admin.id, departmentId: 'dental', notificationPhone: '+2348012345678' });
    assert.equal(created.statusCode, 200, created.body); assert.equal(created.json().departmentId, 'dental');
    const existing = await post('accounts/link', { actorStaffId: facility.admin.id, providerAccountId: 'VT_GS', departmentId: 'gs' });
    assert.equal(existing.statusCode, 200, existing.body); assert.equal(existing.json().departmentId, 'gs');
  });
  it('verifies transfer data and records one department receipt across concurrent webhook retries', async () => {
    const responses = await Promise.all([notify('verified'), notify('verified')]);
    for (const response of responses) assert.equal(response.statusCode, 200, response.body);
    const rows = await db.sql`SELECT * FROM incoming_transfers WHERE provider_reference = 'verified'`;
    assert.equal(rows.length, 1); assert.equal(rows[0].amount_minor, 120000); assert.equal(rows[0].department_id, 'pharmacy');
  });
  it('rejects wrong-mode transactions and retains unlinked-account receipts for reconciliation', async () => {
    assert.equal((await notify('wrong-mode')).statusCode, 409); assert.equal((await notify('unlinked')).statusCode, 200);
    const [row] = await db.sql`SELECT * FROM incoming_transfers WHERE provider_reference = 'unlinked'`; assert.equal(row.department_id, null);
  });
  it('requires a patient bill in the receiving department, facility and currency', async () => {
    const [source] = await db.sql`SELECT id FROM incoming_transfers WHERE provider_reference = 'verified'`;
    assert.equal((await match(source.id, 'charge:oncology:000001', 1000)).statusCode, 409);
    assert.equal((await match(source.id, 'charge:pharmacy:000001', 1000, randomUUID(), patient('000002'))).statusCode, 409);
    const refused = await post(`transfers/${encodeURIComponent(source.id)}/match`, { actorStaffId: nurse.id, patientId: patient(), allocations: [{ chargeId: 'charge:pharmacy:000001', amountMinor: 1000 }], requestId: randomUUID() });
    assert.equal(refused.statusCode, 403);
  });
  it('allocates once on retry, issues a valid receipt, and refuses changing an existing request', async () => {
    const [source] = await db.sql`SELECT id FROM incoming_transfers WHERE provider_reference = 'verified'`;
    const requestId = randomUUID(); const first = await match(source.id, 'charge:pharmacy:000001', 20000, requestId);
    assert.equal(first.statusCode, 200, first.body); assert.match(first.json().receiptNumber, /-R-\d{6}-[A-Z0-9]{2}$/);
    const again = await match(source.id, 'charge:pharmacy:000001', 20000, requestId);
    assert.equal(again.json().id, first.json().id);
    assert.equal((await match(source.id, 'charge:pharmacy:000001', 10000, requestId)).statusCode, 409);
    const payment = await findRecord(db.sql, 'payment', first.json().id); assert(payment);
  });
  it('serializes simultaneous allocations so a transfer cannot be spent twice', async () => {
    assert.equal((await notify('race')).statusCode, 200);
    const [source] = await db.sql`SELECT id FROM incoming_transfers WHERE provider_reference = 'race'`;
    const responses = await Promise.all([match(source.id, 'charge:pharmacy:000001', 50000), match(source.id, 'charge:pharmacy:000002', 50000, randomUUID(), patient('000002'))]);
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
    const [row] = await db.sql`SELECT sum(amount_minor)::int AS n FROM payments WHERE incoming_transfer_id = ${source.id}`;
    assert.equal(row.n, 50000);
  });
  it('refuses a device forging a provider receipt or verified payment link', async () => {
    const env = { ...envelopeFor(facility), createdBy: facility.admin.id };
    const result = await upload(app, facility.device.credential, { transactionId: 500, mutations: [{ clientId: clientId(), op: 'put', table: 'incoming_transfer', id: 'forged', data: { ...env, type: 'incoming_transfer', provider: 'paystack', providerReference: 'fake', amountMinor: 1000, currency: 'NGN', receivedOn: new Date().toISOString() } }] });
    assert.equal(result.rejected[0]?.category, 'authorization');
  });
  it('records attributed discounts and rejects reductions exceeding the current debt', async () => {
    const make = (id: string, amountMinor: number, by = facility.admin.id) => ({ clientId: clientId(), op: 'put' as const, table: 'billing_adjustment' as const, id, data: { ...envelopeFor(facility), createdBy: by, type: 'billing_adjustment', patientId: patient(), chargeId: 'charge:oncology:000001', kind: 'discount', amountMinor, reason: 'Approved staff concession' } });
    const denied = await upload(app, facility.device.credential, { transactionId: 600, mutations: [make('adj:cashier', 10000, cashier.id)] });
    assert.equal(denied.rejected[0]?.category, 'authorization');
    const saved = await upload(app, facility.device.credential, { transactionId: 601, mutations: [make('adj:one', 25000)] });
    assert.equal(saved.rejected.length, 0);
    const excessive = await upload(app, facility.device.credential, { transactionId: 602, mutations: [make('adj:two', 80000)] });
    assert.equal(excessive.rejected[0]?.category, 'conflict');
  });
  it('keeps test-mode receipts visible without allowing them to settle real bills', async () => {
    const key = 'sk_test_FictionalTestOnly';
    assert.equal((await post('connection', { actorStaffId: facility.admin.id, secretKey: key })).statusCode, 200);
    const imported = await post('transfers/import', { actorStaffId: cashier.id, reference: 'test-only' });
    assert.equal(imported.statusCode, 200, imported.body);
    const [source] = await db.sql`SELECT * FROM incoming_transfers WHERE provider_reference = 'test-only'`;
    assert.equal(source.mode, 'test');
    assert.equal((await match(source.id, 'charge:pharmacy:000001', 1)).statusCode, 409);
  });
});
