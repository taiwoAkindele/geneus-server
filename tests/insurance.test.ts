import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { POLICY_VERSION, PayerContractTerms, computeAllocation, serviceDateOf, type FacilityRegistrationResult, type Staff, type UploadMutation } from '#shared';
import { insertRecord } from '../src/db/records.ts';
import { buildSyncConfig } from '../src/sync/syncConfig.ts';
import { availableOnCharge } from '../src/billing/ledger.ts';
import { chargePositions, chargesById } from '../src/insurance/coverage.ts';
import { addStaff, asDevice, clientId, envelopeFor, lastCodeSentTo, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

/**
 * Slice 1 of docs/INSURANCE-HMO-PLAN.md against a disposable PostgreSQL
 * database. Every payer, plan and price here is synthetic.
 */
describe('insurance foundation', () => {
  let db: ScratchDatabase; let app: FastifyInstance; let f: FacilityRegistrationResult;
  let officer: Staff; let supervisor: Staff; let cashier: Staff; let desk: Staff;
  const tokens = new Map<string, string>();
  const TZ = 'Africa/Lagos';
  const VERSIONS = { insuranceWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: POLICY_VERSION } as const;
  const day = (offset: number) => serviceDateOf(new Date(Date.now() + offset * 86_400_000).toISOString(), TZ)!;
  const patient = (n: string) => `${f.facility.id}-${n}-K2`;
  const balance = (chargeId: string) => availableOnCharge(db.sql as never, f.facility.id, chargeId);

  const login = async (staffId: string, email: string) => {
    const code = await app.inject({ method: 'POST', url: '/workforce/access/code', headers: asDevice(f.device.credential), payload: { staffId } });
    assert.equal(code.statusCode, 202, code.body);
    const verified = await app.inject({ method: 'POST', url: '/workforce/access/verify', headers: asDevice(f.device.credential), payload: { staffId, code: lastCodeSentTo(email) } });
    assert.equal(verified.statusCode, 200, verified.body);
    tokens.set(staffId, verified.json().token);
  };
  const call = (path: string, payload: unknown, staffId?: string) => app.inject({
    method: 'POST', url: path, payload: payload as object,
    headers: { ...asDevice(f.device.credential), ...(staffId && tokens.get(staffId) ? { 'x-workforce-access': tokens.get(staffId)! } : {}) },
  });
  const put = (table: UploadMutation['table'], record: Record<string, unknown>): UploadMutation => ({ clientId: clientId(), op: 'put', table, id: String(record.id), data: record });
  const send = (mutations: UploadMutation[], versions: Record<string, unknown> = VERSIONS) => upload(app, f.device.credential, { ...versions, transactionId: 1, mutations } as never);
  const envelope = (by: Staff) => ({ ...envelopeFor(f), createdBy: by.id, schemaVersion: 5 });
  const token = (versions: Record<string, unknown> = VERSIONS) => app.inject({ method: 'POST', url: '/sync/token', headers: asDevice(f.device.credential), payload: { ...versions, clinicalWorkflowVersion: 1, pendingMutationCount: 0 } });
  const ready = async () => { const r = await token(); assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().insuranceWorkflowVersion, 1); };
  const charge = async (id: string, feeItemId: string, category: string, listPriceMinor: number, patientNo = '000001') => {
    await insertRecord(db.sql, 'charge', { ...envelope(desk), id, type: 'charge', patientId: patient(patientNo), feeItemId, category, description: 'Synthetic service', listPriceMinor, amountMinor: listPriceMinor, currency: 'NGN' });
    return id;
  };
  let receipt = 100_000;
  const pay = (id: string, chargeId: string, amountMinor: number, versions: Record<string, unknown> = VERSIONS, patientNo = '000001') => send([put('payment', {
    ...envelope(cashier), id, type: 'payment', patientId: patient(patientNo), receiptNumber: `${f.facility.id}-R-${String(receipt++)}-K2`,
    method: 'cash', amountMinor, currency: 'NGN', allocations: [{ chargeId, amountMinor }],
  })], versions);
  const terms = (tariff: number, overrides: Partial<PayerContractTerms> = {}) => ({
    payerId: 'payer:synthetic-a', effectiveFrom: '2020-01-01', currency: 'NGN',
    arrangements: { categories: { consultation: 'per_service', registration: 'capitation', procedure: 'per_diem' }, items: {} },
    tariff: { 'fee:consult': { unitMinor: tariff }, 'fee:capt': { unitMinor: 1_000 } },
    plans: [{ planCode: 'GOLD', name: 'Synthetic gold', rules: {
      categories: { consultation: { coverage: 'covered', copay: { kind: 'percent', basisPoints: 1_000 } }, registration: { coverage: 'covered', copay: { kind: 'none' } }, procedure: { coverage: 'covered', copay: { kind: 'none' } } },
      items: { 'fee:nobill': { coverage: 'excluded', patientLiability: 'not_billable' } },
    } }],
    ...overrides,
  });
  const activate = (contractVersionId: string, extra: Record<string, unknown> = {}) =>
    call('/insurance/contracts/activate', { contractVersionId, acknowledgeUnsupported: true, requestKey: randomUUID(), ...extra }, f.admin.id);
  const confirm = (chargeIds: string[], extra: Record<string, unknown> = {}) =>
    call('/insurance/allocations/confirm', { chargeIds, requestKey: randomUUID(), basis: 'routine_bulk', ...extra }, officer.id);
  const details = async (chargeId: string) => db.sql<Record<string, number & string & object>[]>`
    SELECT d.* FROM coverage_allocation_details d JOIN coverage_allocations a ON a.id = d.allocation_id WHERE a.charge_id = ${chargeId} ORDER BY a.created_on`;
  const refund = (chargeId: string, amountMinor: number, id = `refund:${randomUUID()}`, patientNo = '000001') =>
    call('/billing/refunds', { id, patientId: patient(patientNo), method: 'cash', currency: 'NGN', allocations: [{ chargeId, amountMinor }], reason: 'Synthetic overpayment' }, supervisor.id);
  const cover = (id: string, patientNo: string) => put('patient_cover', { ...envelope(desk), id, type: 'patient_cover', patientId: patient(patientNo), payerId: 'payer:synthetic-a', planCode: 'GOLD', enrolleeNumber: `SYN-${patientNo}`, relationship: 'principal', active: true });
  const check = (id: string, coverId: string, patientNo: string, result = 'verified') => put('cover_check', { ...envelope(desk), id, type: 'cover_check', patientId: patient(patientNo), coverId, method: 'portal', reference: 'SYN-REF', result, coversFrom: day(-1), coversTo: day(1) });

  before(async () => {
    db = await scratchDatabase(); f = await registerScratchFacility(db.sql); app = testApp(db.sql);
    officer = await addStaff(db.sql, f, { role: 'insurance_officer' }); supervisor = await addStaff(db.sql, f, { role: 'supervisor' });
    cashier = await addStaff(db.sql, f, { role: 'cashier' }); desk = await addStaff(db.sql, f, { role: 'records_officer' });
    for (const [s, email] of [[officer, 'officer@example.org'], [supervisor, 'supervisor@example.org'], [cashier, 'cashier@example.org']] as const) {
      await db.sql`INSERT INTO staff_contacts (facility_id, staff_id, email, verified_on) VALUES (${f.facility.id}, ${s.id}, ${email}, now())`;
    }
    const admin = { ...envelopeFor(f), schemaVersion: 5 };
    for (const n of ['000001', '000002', '000003']) await insertRecord(db.sql, 'patient', { ...admin, id: patient(n), patientId: patient(n), type: 'patient', fullName: `Synthetic patient ${n}`, address: 'Synthetic address', sex: 'female', ageYears: 30 });
    for (const [id, category, amountMinor] of [['fee:consult', 'consultation', 5_000], ['fee:capt', 'registration', 1_500], ['fee:proc', 'procedure', 20_000], ['fee:nobill', 'consultation', 3_000]] as const) {
      await insertRecord(db.sql, 'fee_item', { ...admin, id, type: 'fee_item', name: id, category, amountMinor, currency: 'NGN', chargeWhen: 'when_ordered' });
    }
    await login(officer.id, 'officer@example.org'); await login(supervisor.id, 'supervisor@example.org');
    await login(cashier.id, 'cashier@example.org'); await login(f.admin.id, 'admin@example.org');
  });
  after(async () => { if (app) await app.close(); if (db) await db.drop(); });

  describe('off until enabled, then protected by verified staff and granular permissions', () => {
    it('keeps insurance and refunds off for a hospital an operator has not enabled', async () => {
      const response = await call('/insurance/contracts/list', {}, officer.id);
      assert.equal(response.json().error, 'insurance_not_enabled');
      assert.equal((await call('/billing/refunds', { id: `refund:${randomUUID()}`, patientId: patient('000001'), method: 'cash', currency: 'NGN', allocations: [{ chargeId: 'x', amountMinor: 1 }], reason: 'Synthetic' }, supervisor.id)).json().error, 'insurance_not_enabled');
      const t = await token();
      assert.equal(t.statusCode, 200, t.body);
      assert.equal(t.json().insuranceWorkflowVersion, undefined, 'a capable device gets no insurance records yet');
      await db.sql`UPDATE facilities SET insurance_enabled = true WHERE id = ${f.facility.id}`;
    });
    it('refuses contract access to a staff id the device merely asserts', async () => {
      const response = await app.inject({ method: 'POST', url: '/insurance/contracts/list', headers: { ...asDevice(f.device.credential), 'x-actor-staff-id': officer.id }, payload: {} });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'private_verification_required');
      assert.equal((await call('/insurance/contracts/list', {}, officer.id)).statusCode, 200);
    });
    it('never gives contract access to supervisors or cashiers, and refunds only to those allowed', async () => {
      for (const who of [supervisor.id, cashier.id]) {
        assert.equal((await call('/insurance/contracts/list', {}, who)).statusCode, 403);
        assert.equal((await call('/insurance/allocations/preview', { chargeIds: ['x'] }, who)).statusCode, 403);
        assert.equal((await call('/insurance/contracts/end', { contractVersionId: 'x', endsOn: day(0), reason: 'x', requestKey: randomUUID() }, who)).statusCode, 403);
      }
      assert.equal((await call('/billing/refunds', { id: `refund:${randomUUID()}`, patientId: patient('000001'), method: 'cash', currency: 'NGN', allocations: [{ chargeId: 'x', amountMinor: 1 }], reason: 'Synthetic' }, cashier.id)).statusCode, 403);
    });
    it('keeps the officer from activating and the administrator from reading contracts', async () => {
      assert.equal((await call('/insurance/contracts/activate', { contractVersionId: 'x', requestKey: randomUUID() }, officer.id)).statusCode, 403);
      assert.equal((await call('/insurance/contracts/list', {}, f.admin.id)).statusCode, 403);
    });
  });

  describe('contracts, activation and confidentiality', () => {
    it('saves a payer and a draft, naming unsupported terms', async () => {
      const payer = await call('/insurance/payers/save', { id: 'payer:synthetic-a', name: 'Synthetic HMO A', kind: 'hmo', code: 'SYNA', active: true }, officer.id);
      assert.equal(payer.statusCode, 200, payer.body);
      const unknown = await call('/insurance/contracts/draft', { terms: { ...terms(4_000), tariff: { 'fee:missing': { unitMinor: 1 } } } }, officer.id);
      assert.equal(unknown.json().error, 'unknown_fee_items');
      const draft = await call('/insurance/contracts/draft', { terms: terms(4_000) }, officer.id);
      assert.equal(draft.statusCode, 200, draft.body);
      assert.deepEqual(draft.json().unsupported, [{ scope: 'category', key: 'procedure', feature: 'per_diem' }]);
      assert.equal((await call('/insurance/contracts/draft', { terms: terms(4_000) }, officer.id)).json().error, 'stale_draft', 'a second editor must see the current revision');
    });
    it('refuses activation without a recorded hospital time zone', async () => {
      await ready();
      assert.equal((await activate('contract:payer:synthetic-a:v1')).json().error, 'timezone_required');
      await db.sql`UPDATE facilities SET time_zone = ${TZ} WHERE id = ${f.facility.id}`;
    });
    it('refuses activation while a device has unsent work, including a revoked one, until it is named', async () => {
      await db.sql`UPDATE workforce_client_versions SET pending_mutation_count = 3, recorded_on = now() WHERE device_id = ${f.device.deviceId}`;
      const pending = await activate('contract:payer:synthetic-a:v1');
      assert.equal(pending.json().error, 'devices_not_ready');
      assert.ok(pending.json().details.devices[0].reasons.includes('unsent_changes'));
      await ready();
      const lost = `device-${randomUUID().slice(0, 8)}`;
      await db.sql`INSERT INTO devices (id, facility_id, schema_version, created_by, created_on, device_id, enrolled_by, status, enrolled_on, revoked_on)
        VALUES (${lost}, ${f.facility.id}, 5, ${f.admin.id}, now(), ${f.device.deviceId}, ${f.admin.id}, 'revoked', now(), now())`;
      await db.sql`INSERT INTO workforce_client_versions (device_id, facility_id, contract_version, schema_version, policy_version, pending_mutation_count, recorded_on, insurance_version)
        VALUES (${lost}, ${f.facility.id}, 1, 5, ${POLICY_VERSION}, 2, now(), 1)`;
      const revoked = await activate('contract:payer:synthetic-a:v1');
      assert.equal(revoked.json().error, 'devices_not_ready', 'revoking a device does not make its unsent work disappear silently');
      assert.deepEqual(revoked.json().details.devices.map((d: { deviceId: string; reasons: string[] }) => [d.deviceId, d.reasons]), [[lost, ['revoked_with_unsent_changes']]]);
      const unacknowledged = await activate('contract:payer:synthetic-a:v1', { acceptRevokedDevices: [lost], acknowledgeUnsupported: false });
      assert.equal(unacknowledged.json().error, 'unsupported_arrangements');
      const key = randomUUID();
      const activated = await activate('contract:payer:synthetic-a:v1', { acceptRevokedDevices: [lost], requestKey: key });
      assert.equal(activated.statusCode, 200, activated.body);
      assert.deepEqual(activated.json().scheduleIds, ['cover_schedule:contract:payer:synthetic-a:v1:GOLD']);
      assert.deepEqual(activated.json().acceptedRevokedDevices, [lost]);
      assert.deepEqual((await activate('contract:payer:synthetic-a:v1', { acceptRevokedDevices: [lost], requestKey: key })).json(), activated.json(), 'a replay returns the same answer');
      assert.equal((await activate('contract:payer:synthetic-a:v1', { requestKey: key })).statusCode, 409, 'a reused key with a different body is refused');
      const [audit] = await db.sql`SELECT metadata FROM audit_events WHERE metadata->>'context' = 'insurance_contract_activated'`;
      assert.equal(audit.metadata.acceptedRevokedDevices, lost, 'the acceptance is audited');
      await assert.rejects(db.sql`UPDATE payer_contract_versions SET terms = '{}' WHERE id = 'contract:payer:synthetic-a:v1'`, 'an active version is frozen');
    });
    it('keeps tariffs and payer shares off every device', async () => {
      const config = buildSyncConfig();
      for (const secret of ['payer_contract_versions', 'coverage_allocation_details', 'insurance_requests', 'payer_share', 'contract_adjustment', 'tariff', 'insurance_enabled']) assert.ok(!config.includes(secret), secret);
      const published = (await db.sql<{ tablename: string }[]>`SELECT tablename FROM pg_publication_tables WHERE pubname = 'powersync'`).map((r) => r.tablename);
      for (const secret of ['payer_contract_versions', 'coverage_allocation_details', 'insurance_requests']) assert.ok(!published.includes(secret), secret);
      assert.ok(published.includes('cover_schedules') && published.includes('coverage_allocations'));
      const [schedule] = await db.sql<{ items: unknown; categories: unknown }[]>`SELECT items, categories FROM cover_schedules`;
      const synced = JSON.stringify(schedule);
      assert.ok(synced.includes('"amountMinor":400') && !synced.includes('4000'), 'the schedule carries the patient amount, never the tariff');
    });
  });

  describe('cover at the desk and the patient balance', () => {
    it('bills a patient without cover exactly as before', async () => {
      await charge('charge:cash', 'fee:consult', 'consultation', 5_000, '000003');
      assert.equal(await balance('charge:cash'), 5_000);
    });
    it('leaves unchecked cover undetermined: nothing to reduce, and a payment is kept but flagged', async () => {
      await send([cover('cover:one', '000001')]);
      await charge('charge:pending', 'fee:consult', 'consultation', 5_000);
      assert.equal(await balance('charge:pending'), 0);
      const waiver = await send([put('billing_adjustment', { ...envelope(supervisor), id: 'adj:pending', type: 'billing_adjustment', patientId: patient('000001'), chargeId: 'charge:pending', kind: 'waiver', amountMinor: 100, reason: 'Synthetic' })]);
      assert.equal(waiver.rejected.length, 1, 'the payer part cannot be waived on the patient account');
      const old = await pay('pay:old-device', 'charge:pending', 5_000, { facilityContractVersion: 1, schemaVersion: 5, policyVersion: 13 });
      assert.equal(old.rejected.length, 0, 'money that changed hands is always kept');
      const [flag] = await db.sql`SELECT * FROM audit_events WHERE entity_id = 'pay:old-device' AND metadata->>'context' = 'insurance_payment_review'`;
      assert.ok(flag, 'the overpayment is flagged with its device and cashier');
      assert.equal(flag.actor_staff_id, cashier.id);
    });
    it('refuses insurance records from a device without the insurance workflow', async () => {
      const response = await app.inject({ method: 'POST', url: '/sync/upload', headers: asDevice(f.device.credential), payload: { facilityContractVersion: 1, schemaVersion: 5, policyVersion: 13, transactionId: 1, mutations: [check('check:old', 'cover:one', '000001')] } });
      assert.equal(response.statusCode, 400);
    });
    it('a verified check gives the estimated co-pay of the tariff', async () => {
      const result = await send([check('check:one', 'cover:one', '000001')]);
      assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
      await charge('charge:consult', 'fee:consult', 'consultation', 5_000);
      assert.equal(await balance('charge:consult'), 400);
      const preview = await call('/insurance/allocations/preview', { chargeIds: ['charge:consult'] }, officer.id);
      assert.deepEqual(preview.json().items[0].split, { arrangement: 'per_service', patientShareMinor: 400, payerShareMinor: 3_600, contractAdjustmentMinor: 1_000, capitationCoveredMinor: 0, tariffTotalMinor: 4_000 });
    });
  });

  describe('self-pay is never assumed and never overrides the contract', () => {
    it('the till cannot record self-pay while the contract rule is unrecorded, and the attempt is kept as a refusal', async () => {
      const result = await send([put('coverage_election', { ...envelope(cashier), id: 'el:till', type: 'coverage_election', patientId: patient('000001'), kind: 'self_pay', coverId: 'cover:one', chargeIds: ['charge:pending'], reason: 'patient_choice', patientAgreed: true })]);
      assert.equal(result.rejected.length, 1);
      assert.match(result.rejected[0].reason, /not recorded/);
    });
    it('an excluded service marked not billable can never be put on the patient', async () => {
      await charge('charge:nobill', 'fee:nobill', 'consultation', 3_000);
      const response = await confirm(['charge:nobill'], { basis: 'exception', decision: 'self_pay', reason: 'Synthetic attempt' });
      assert.deepEqual(response.json().outcomes, [{ chargeId: 'charge:nobill', outcome: 'skipped', reason: 'patient_liability_not_permitted' }]);
    });
  });

  describe('confirmation writes reproducible, immutable snapshots that match their charges', () => {
    it('confirms a routine charge and stores the inputs that reproduce it', async () => {
      const response = await confirm(['charge:consult']);
      assert.equal(response.json().outcomes[0].outcome, 'confirmed', response.body);
      const [row] = await details('charge:consult');
      assert.equal(row.patient_share_minor + row.payer_share_minor + row.contract_adjustment_minor + row.capitation_covered_minor, row.list_price_minor);
      const inputs = row.inputs as unknown as { termsSlice: PayerContractTerms; planCode: string; units: number; listPriceMinor: number; feeItemId: string; category: 'consultation'; currency: string };
      const again = computeAllocation({ terms: PayerContractTerms.parse(inputs.termsSlice), planCode: inputs.planCode, units: inputs.units, charge: { feeItemId: inputs.feeItemId, category: inputs.category, listPriceMinor: inputs.listPriceMinor, currency: inputs.currency } });
      assert.ok(again.ok && again.split.payerShareMinor === row.payer_share_minor && again.split.patientShareMinor === row.patient_share_minor);
      await assert.rejects(db.sql`UPDATE coverage_allocation_details SET payer_share_minor = 0 WHERE allocation_id = ${row.allocation_id}`);
    });
    it('refuses a snapshot whose price or patient share disagrees with its charge, whatever wrote it', async () => {
      await charge('charge:forged', 'fee:consult', 'consultation', 5_000);
      const insert = (id: string, listPrice: number, patientShare: number, projectionShare = patientShare) => db.sql.begin(async (tx) => {
        await tx`INSERT INTO coverage_allocations (id, facility_id, schema_version, created_by, created_on, device_id, patient_id, charge_id, state, payer_id, arrangement, patient_share_minor, currency, basis)
          VALUES (${id}, ${f.facility.id}, 5, ${officer.id}, now(), ${f.device.deviceId}, ${patient('000001')}, 'charge:forged', 'finalised', 'payer:synthetic-a', 'per_service', ${projectionShare}, 'NGN', 'exception')`;
        await tx`INSERT INTO coverage_allocation_details (allocation_id, facility_id, calculation_version, inputs, list_price_minor, patient_share_minor, payer_share_minor, contract_adjustment_minor, capitation_covered_minor, request_key)
          VALUES (${id}, ${f.facility.id}, 1, '{}', ${listPrice}, ${patientShare}, ${listPrice - patientShare}, 0, 0, 'forged-key')`;
      });
      await assert.rejects(insert('alloc:forged-price', 9_000, 400), /match its charge/, 'a list price other than the charge');
      await assert.rejects(insert('alloc:forged-share', 5_000, 400, 100), /match its charge/, 'a patient share other than the synced projection');
      assert.equal((await db.sql`SELECT 1 FROM coverage_allocations WHERE charge_id = 'charge:forged'`).length, 0);
    });
    it('a later contract version changes estimates, never confirmed snapshots', async () => {
      await charge('charge:later', 'fee:consult', 'consultation', 5_000);
      assert.equal((await pay('pay:later', 'charge:later', 400)).rejected.length, 0);
      assert.equal((await call('/insurance/contracts/draft', { terms: terms(5_000, { selfPayElection: 'not_allowed' }) }, officer.id)).statusCode, 200);
      await ready();
      assert.equal((await activate('contract:payer:synthetic-a:v2', { acceptRevokedDevices: (await db.sql`SELECT id FROM devices WHERE status = 'revoked'`).map((r) => r.id) })).statusCode, 200);
      assert.equal((await details('charge:consult'))[0].patient_share_minor, 400, 'the confirmed snapshot keeps version 1');
      assert.equal(await balance('charge:later'), 100, 'collected 400 on the old estimate; 100 is now due, not silently adjusted');
      assert.equal((await confirm(['charge:later'])).json().outcomes[0].outcome, 'confirmed');
      assert.equal(await balance('charge:later'), 100);
    });
    it('a contract that prohibits self-pay cannot be overridden by an officer reason', async () => {
      const response = await confirm(['charge:pending'], { basis: 'exception', decision: 'self_pay', reason: 'Patient asked' });
      assert.equal(response.json().outcomes[0].reason, 'self_pay_prohibited_by_payer');
    });
    it('a correction supersedes the snapshot and keeps both', async () => {
      assert.equal((await confirm(['charge:consult'])).json().outcomes[0].reason, 'already_confirmed');
      assert.equal((await confirm(['charge:consult'], { basis: 'exception', reason: 'Synthetic re-check against version 2' })).json().outcomes[0].outcome, 'confirmed');
      const rows = await db.sql`SELECT id, supersedes FROM coverage_allocations WHERE charge_id = 'charge:consult' ORDER BY created_on`;
      assert.equal(rows.length, 2);
      assert.equal(rows[1].supersedes, rows[0].id);
    });
    it('capitation is covered without a receivable, and per diem is never calculated', async () => {
      await charge('charge:capt', 'fee:capt', 'registration', 1_500);
      await charge('charge:proc', 'fee:proc', 'procedure', 20_000);
      const outcomes = Object.fromEntries((await confirm(['charge:capt', 'charge:proc'], { basis: 'exception', reason: 'Synthetic review' })).json().outcomes.map((o: { chargeId: string }) => [o.chargeId, o]));
      assert.equal(outcomes['charge:capt'].outcome, 'confirmed');
      assert.equal(outcomes['charge:proc'].reason, 'undetermined:unsupported_arrangement');
      const [capt] = await details('charge:capt');
      assert.equal(capt.payer_share_minor, 0);
      assert.equal(capt.capitation_covered_minor, 1_000);
      assert.equal((await details('charge:proc')).length, 0);
    });
    it('two officers confirming at once write one snapshot', async () => {
      await charge('charge:race', 'fee:consult', 'consultation', 5_000);
      const [a, b] = await Promise.all([confirm(['charge:race']), confirm(['charge:race'])]);
      assert.deepEqual([a.json().outcomes[0].outcome, b.json().outcomes[0].outcome].sort(), ['confirmed', 'skipped']);
      assert.equal((await db.sql`SELECT 1 FROM coverage_allocations WHERE charge_id = 'charge:race'`).length, 1);
    });
    it('a repeated request key replays instead of confirming twice', async () => {
      await charge('charge:replay', 'fee:consult', 'consultation', 5_000);
      const body = { chargeIds: ['charge:replay'], requestKey: randomUUID(), basis: 'routine_bulk' };
      const [a, b] = await Promise.all([call('/insurance/allocations/confirm', body, officer.id), call('/insurance/allocations/confirm', body, officer.id)]);
      assert.deepEqual(a.json(), b.json());
      assert.equal((await db.sql`SELECT 1 FROM coverage_allocations WHERE charge_id = 'charge:replay'`).length, 1);
    });
  });

  describe('credits and refunds', () => {
    it('refuses to refund while responsibility can still change', async () => {
      await charge('charge:estimate', 'fee:consult', 'consultation', 5_000);
      await pay('pay:estimate', 'charge:estimate', 1_000);
      assert.equal((await refund('charge:estimate', 100)).json().error, 'responsibility_not_final');
    });
    it('refunds a confirmed credit without altering the payment, never more than the credit', async () => {
      assert.equal((await confirm(['charge:estimate'], { basis: 'exception', reason: 'Synthetic overpaid visit' })).json().outcomes[0].outcome, 'confirmed');
      assert.equal(await balance('charge:estimate'), -500);
      assert.equal((await refund('charge:estimate', 600)).json().error, 'exceeds_credit');
      const id = `refund:${randomUUID()}`;
      const done = await refund('charge:estimate', 300, id);
      assert.equal(done.statusCode, 201, done.body);
      assert.match(done.json().refundNumber, /-F-\d{6}$/);
      assert.equal((await refund('charge:estimate', 300, id)).statusCode, 200, 'a retry returns the same refund');
      assert.equal((await db.sql`SELECT amount_minor FROM payments WHERE id = 'pay:estimate'`)[0].amount_minor, 1_000, 'the payment stays exactly as received');
      assert.equal(await balance('charge:estimate'), -200);
    });
    it('two refunds of the same credit at once: one succeeds', async () => {
      const [a, b] = await Promise.all([refund('charge:estimate', 200), refund('charge:estimate', 200)]);
      assert.deepEqual([a.statusCode, b.statusCode].sort(), [201, 409]);
      assert.equal(await balance('charge:estimate'), 0);
    });
    it('refunds an ordinary cash overpayment too, which could not be recorded before', async () => {
      await pay('pay:cash-over', 'charge:cash', 6_000, VERSIONS, '000003');
      assert.equal((await refund('charge:cash', 1_000, undefined, '000003')).statusCode, 201);
      assert.equal(await balance('charge:cash'), 0);
    });
  });

  describe('one charge reconciled from start to finish', () => {
    it('charge → cover → check → estimate → overpayment → confirmation → credit → refund, every figure accounted for', async () => {
      const position = async (id: string) => (await chargePositions(db.sql as never, f.facility.id, await chargesById(db.sql as never, f.facility.id, [id]))).get(id)!;
      // 1. A 5,000 consultation for a patient whose cover is not yet recorded: a cash bill.
      await charge('charge:recon', 'fee:consult', 'consultation', 5_000, '000002');
      assert.deepEqual([(await position('charge:recon')).estimate.state, await balance('charge:recon')], ['self_pay', 5_000]);
      // 2. Cover recorded: undetermined; the patient owes nothing for it yet, and nothing is receivable.
      await send([cover('cover:recon', '000002')]);
      let p = await position('charge:recon');
      assert.deepEqual([p.estimate.state, p.baseMinor, p.undeterminedMinor, p.balanceMinor], ['undetermined', 0, 5_000, 0]);
      // 3. Verified: version 2 is in force (tariff 5,000, 10% co-pay) — the estimate is 500.
      await send([check('check:recon', 'cover:recon', '000002')]);
      p = await position('charge:recon');
      assert.deepEqual([p.estimate.state, p.baseMinor, p.final, p.balanceMinor], ['estimated', 500, false, 500]);
      // 4. The patient pays 2,000 at the till: 1,500 more than the estimate. Kept and flagged.
      assert.equal((await pay('pay:recon', 'charge:recon', 2_000, VERSIONS, '000002')).rejected.length, 0);
      assert.ok((await db.sql`SELECT 1 FROM audit_events WHERE entity_id = 'pay:recon' AND metadata->>'context' = 'insurance_payment_review'`).length);
      assert.equal(await balance('charge:recon'), -1_500);
      // 5. Not routine (overpaid), so the officer confirms it as an exception.
      assert.equal((await confirm(['charge:recon'])).json().outcomes[0].reason, 'not_routine');
      assert.equal((await confirm(['charge:recon'], { basis: 'exception', reason: 'Overpaid at the till' })).json().outcomes[0].outcome, 'confirmed');
      const [snapshot] = await details('charge:recon');
      assert.deepEqual([snapshot.list_price_minor, snapshot.patient_share_minor, snapshot.payer_share_minor, snapshot.contract_adjustment_minor, snapshot.capitation_covered_minor], [5_000, 500, 4_500, 0, 0]);
      p = await position('charge:recon');
      assert.deepEqual([p.estimate.state, p.baseMinor, p.final, p.balanceMinor, p.money.receivedMinor], ['finalised', 500, true, -1_500, 2_000]);
      // 6. The 1,500 credit is refunded in two parts; the payment is untouched.
      assert.equal((await refund('charge:recon', 1_000, undefined, '000002')).statusCode, 201);
      assert.equal((await refund('charge:recon', 600, undefined, '000002')).json().error, 'exceeds_credit');
      assert.equal((await refund('charge:recon', 500, undefined, '000002')).statusCode, 201);
      p = await position('charge:recon');
      assert.deepEqual([p.balanceMinor, p.money.receivedMinor, p.money.refundedMinor], [0, 2_000, 1_500]);
      // Patient paid 2,000 − refunded 1,500 = 500 = patient share; the HMO owes 4,500; 500 + 4,500 = the 5,000 list price.
      assert.equal(p.money.receivedMinor - p.money.refundedMinor + snapshot.payer_share_minor + snapshot.contract_adjustment_minor, 5_000);
    });
  });

  describe('ending a contract', () => {
    it('ends cover from today without changing any confirmed split', async () => {
      const before = await details('charge:consult');
      const past = await call('/insurance/contracts/end', { contractVersionId: 'contract:payer:synthetic-a:v2', endsOn: day(-1), reason: 'Synthetic', requestKey: randomUUID() }, f.admin.id);
      assert.equal(past.json().error, 'end_in_past');
      const ended = await call('/insurance/contracts/end', { contractVersionId: 'contract:payer:synthetic-a:v2', endsOn: day(0), reason: 'Synthetic contract ended', requestKey: randomUUID() }, f.admin.id);
      assert.equal(ended.statusCode, 200, ended.body);
      assert.equal((await call('/insurance/contracts/end', { contractVersionId: 'contract:payer:synthetic-a:v2', endsOn: day(1), reason: 'Again', requestKey: randomUUID() }, f.admin.id)).json().error, 'already_ended');
      assert.deepEqual(await details('charge:consult'), before, 'confirmed splits are snapshots');
      const [schedule] = await db.sql`SELECT ended_on FROM cover_schedules WHERE contract_version_id = 'contract:payer:synthetic-a:v2'`;
      assert.equal(schedule.ended_on, day(0));
      // Version 1 never ended, so it would still apply underneath; ending it too stops this payer's cover from today.
      assert.equal((await call('/insurance/contracts/end', { contractVersionId: 'contract:payer:synthetic-a:v1', endsOn: day(0), reason: 'Synthetic contract ended', requestKey: randomUUID() }, f.admin.id)).statusCode, 200);
      await charge('charge:after-end', 'fee:consult', 'consultation', 5_000);
      const [after] = (await chargePositions(db.sql as never, f.facility.id, await chargesById(db.sql as never, f.facility.id, ['charge:after-end']))).values();
      assert.equal(after.estimate.state === 'undetermined' && after.estimate.detail, 'contract', 'no contract in force: undetermined, never a guess');
      assert.equal((await details('charge:recon'))[0].patient_share_minor, 500, 'earlier snapshots are untouched');
      await assert.rejects(db.sql`UPDATE cover_schedules SET ended_on = ${day(5)} WHERE contract_version_id = 'contract:payer:synthetic-a:v2'`, 'an end date is recorded once');
    });
  });
});
