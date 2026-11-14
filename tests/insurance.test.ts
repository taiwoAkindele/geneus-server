import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { POLICY_VERSION, PayerContractTerms, computeAllocation, serviceDateOf, type FacilityRegistrationResult, type Staff, type UploadMutation } from '#shared';
import { insertRecord } from '../src/db/records.ts';
import { buildSyncConfig } from '../src/sync/syncConfig.ts';
import { availableOnCharge } from '../src/billing/ledger.ts';
import { chargePositions, chargesById } from '../src/insurance/coverage.ts';
import { setInsuranceState } from '../src/insurance/enablement.ts';
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
    for (const n of ['000001', '000002', '000003', '000004']) await insertRecord(db.sql, 'patient', { ...admin, id: patient(n), patientId: patient(n), type: 'patient', fullName: `Synthetic patient ${n}`, address: 'Synthetic address', sex: 'female', ageYears: 30 });
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
      // Operator commands are audited decisions that need the hospital's time zone.
      const op = (state: 'off' | 'setup' | 'active', extra: Record<string, unknown> = {}) => setInsuranceState(db.sql, { facilityId: f.facility.id, state, operator: 'synthetic-operator', governanceReference: 'synthetic:approval', ...extra });
      await assert.rejects(op('setup'), /time zone/);
      await assert.rejects(op('setup', { operator: ' ', timeZone: TZ }), /operator/);
      const status = await op('setup', { timeZone: TZ });
      assert.equal(status.state, 'setup');
      assert.equal(status.timeZone, TZ);
      await assert.rejects(op('setup', { timeZone: 'Europe/London' }), /Facility settings/, 'a recorded time zone is never silently changed');
      await assert.rejects(op('active'), /not ready/, 'billing cannot be activated before readiness');
      const [command] = await db.sql`SELECT operator, governance_reference, state FROM insurance_operator_commands WHERE facility_id = ${f.facility.id}`;
      assert.deepEqual([command.operator, command.governance_reference, command.state], ['synthetic-operator', 'synthetic:approval', 'setup']);
      assert.ok((await db.sql`SELECT 1 FROM audit_events WHERE metadata->>'context' = 'insurance_state'`).length, 'the switch is audited');
      await assert.rejects(db.sql`DELETE FROM insurance_operator_commands`, 'the record of switches is permanent');
      const t2 = await token();
      assert.equal(t2.json().insuranceWorkflowVersion, 1, 'setup delivers insurance configuration records');
      assert.equal(t2.json().insuranceBillingActive, false, 'but tells the device billing is not active');
      assert.equal((await call('/billing/refunds', { id: `refund:${randomUUID()}`, patientId: patient('000001'), method: 'cash', currency: 'NGN', allocations: [{ chargeId: 'x', amountMinor: 1 }], reason: 'Synthetic' }, supervisor.id)).json().error, 'insurance_billing_inactive');
    });
    it('lets a hospital administrator leave and re-enter setup, never activate billing', async () => {
      assert.deepEqual((await call('/insurance/setup', { state: 'off' }, f.admin.id)).json(), { state: 'off' });
      assert.deepEqual((await call('/insurance/setup', { state: 'setup' }, f.admin.id)).json(), { state: 'setup' });
      assert.equal((await call('/insurance/setup', { state: 'active' }, f.admin.id)).statusCode, 400, 'active is not a choice here');
      assert.equal((await call('/insurance/setup', { state: 'off' }, officer.id)).statusCode, 403, 'the officer does not switch insurance');
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
      // Only reachable if the time zone were removed behind the operator's back; activation still refuses.
      await db.sql`UPDATE facilities SET time_zone = NULL WHERE id = ${f.facility.id}`;
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

  describe('setup never touches a bill; activation applies only from its effective moment', () => {
    it('records cover during setup without changing any bill, and activation never reclassifies charges raised before it', async () => {
      await send([cover('cover:setup', '000004'), check('check:setup', 'cover:setup', '000004')]);
      await charge('charge:setup', 'fee:consult', 'consultation', 5_000, '000004');
      assert.equal(await balance('charge:setup'), 5_000, 'setup: billed as cash');
      const status = await (await call('/insurance/setup/status/officer', {}, officer.id)).json();
      assert.equal(status.state, 'setup');
      assert.ok(status.items.find((i: { kind: string }) => i.kind === 'active_contract').ok);
      await ready();
      const activated = await setInsuranceState(db.sql, { facilityId: f.facility.id, state: 'active', operator: 'synthetic-operator', governanceReference: 'synthetic:activation' });
      assert.equal(activated.state, 'active');
      assert.equal(await balance('charge:setup'), 5_000, 'a charge raised before activation stays as billed');
      assert.equal((await confirm(['charge:setup'])).json().outcomes[0].reason, 'outside_billing_period', 'and cover cannot be applied to it retrospectively');
      await charge('charge:while-active', 'fee:consult', 'consultation', 5_000, '000004');
      assert.equal(await balance('charge:while-active'), 400, 'a charge raised after activation: the verified cover applies');
      const t = (await token()).json();
      assert.equal(t.insuranceBillingActive, true);
      assert.equal(t.insuranceBillingPeriods.length, 1);
      assert.equal(t.insuranceBillingPeriods[0].to, undefined);
      await assert.rejects(db.sql`DELETE FROM insurance_billing_periods`, 'billing periods are permanent');
      assert.equal((await call('/insurance/setup', { state: 'off' }, f.admin.id)).json().error, 'billing_active', 'only an operator changes active billing');
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

  describe('supporting documents and submission settings', () => {
    const pdf = Buffer.from('%PDF-1.4\n% synthetic contract\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    const upload = (bytes: Buffer, meta: Record<string, unknown>, staffId = officer.id) => app.inject({
      method: 'POST', url: '/insurance/documents', payload: bytes,
      headers: { ...asDevice(f.device.credential), 'x-workforce-access': tokens.get(staffId) ?? '', 'content-type': 'application/octet-stream',
        'x-file-sha256': createHash('sha256').update(bytes).digest('hex'), 'x-document-meta': encodeURIComponent(JSON.stringify(meta)) },
    });
    const meta = { payerId: 'payer:synthetic-a', documentType: 'contract', title: 'Synthetic provider agreement', fileName: 'agreement.pdf' };
    it('stores a PDF as evidence, refuses content that is not what it claims, and keeps versions', async () => {
      const first = await upload(pdf, meta);
      assert.equal(first.statusCode, 201, first.body);
      assert.deepEqual([first.json().version, first.json().verification, first.json().mimeType], [1, 'unverified', 'application/pdf']);
      const fake = Buffer.from('=HYPERLINK("http://example.org") not a pdf');
      assert.equal((await upload(fake, { ...meta, fileName: 'evil.pdf' })).statusCode, 400, 'content is sniffed, not trusted');
      assert.equal((await upload(pdf, { ...meta, payerId: 'payer:unknown' })).statusCode, 409);
      const second = await upload(pdf, { ...meta, replaces: first.json().id, title: 'Synthetic agreement, amended' });
      assert.equal(second.json().version, 2);
      assert.equal((await upload(pdf, { ...meta, replaces: first.json().id })).statusCode, 409, 'a version is replaced once');
    });
    it('lets only contract readers list or download documents, and audits downloads', async () => {
      const list = await call('/insurance/documents/list', { payerId: 'payer:synthetic-a' }, officer.id);
      assert.equal(list.json().documents.length, 2);
      assert.equal(JSON.stringify(list.json()).includes('content'), false, 'listing never carries file contents');
      for (const who of [supervisor.id, cashier.id, f.admin.id]) assert.equal((await call('/insurance/documents/list', {}, who)).statusCode, 403);
      const id = list.json().documents[0].id;
      const file = await call(`/insurance/documents/${encodeURIComponent(id)}/file`, {}, officer.id);
      assert.equal(file.statusCode, 200);
      assert.match(String(file.headers['content-disposition']), /^attachment/);
      assert.equal(file.headers['x-content-type-options'], 'nosniff');
      assert.ok(file.rawPayload.subarray(0, 5).toString() === '%PDF-');
      assert.ok((await db.sql`SELECT 1 FROM audit_events WHERE metadata->>'context' = 'insurance_document_downloaded'`).length);
      const verify = await call(`/insurance/documents/${encodeURIComponent(id)}/verify`, { verification: 'verified', note: 'Matches the signed original' }, officer.id);
      assert.equal(verify.json().verification, 'verified');
      assert.equal((await call(`/insurance/documents/${encodeURIComponent(id)}/verify`, { verification: 'rejected' }, officer.id)).statusCode, 409, 'reviewed once');
      await assert.rejects(db.sql`UPDATE insurance_documents SET title = 'changed' WHERE id = ${id}`, 'documents never change');
    });
    it('records a manual submission method per payer; direct submission is refused', async () => {
      const save = (profile: Record<string, unknown>, expectedRevision?: number) => call('/insurance/submission/save', { payerId: 'payer:synthetic-a', profile, ...(expectedRevision ? { expectedRevision } : {}) }, officer.id);
      assert.equal((await save({ method: 'direct', channel: 'portal', portalUrl: 'https://portal.example.org' })).json().error, 'direct_submission_unavailable');
      assert.equal((await save({ method: 'manual', channel: 'portal' })).statusCode, 400, 'a portal needs its address');
      const saved = await save({ method: 'manual', channel: 'email', recipient: 'claims@synthetic-hmo.example.org', claimFormat: 'xlsx', requiredAttachments: ['referral_form'] });
      assert.equal(saved.json().revision, 1, saved.body);
      assert.equal((await save({ method: 'manual', channel: 'physical' })).json().error, 'stale_submission_method', 'a second editor must see the current revision');
      assert.equal((await save({ method: 'manual', channel: 'physical' }, 1)).json().revision, 2);
      const [stored] = (await call('/insurance/submission/list', {}, officer.id)).json().profiles;
      assert.equal(stored.profile.channel, 'physical');
      await assert.rejects(db.sql`INSERT INTO payer_submission_profiles (facility_id, payer_id, profile, revision, updated_by) VALUES (${f.facility.id}, 'payer:synthetic-a', '{"method":"direct"}', 9, 'x') ON CONFLICT (facility_id, payer_id) DO UPDATE SET profile = EXCLUDED.profile`, 'the database refuses direct submission too');
    });
  });

  describe('spreadsheet tariff import and saved mappings', () => {
    const source = { fileName: 'synthetic-tariff.xlsx', sha256: 'a'.repeat(64), sheet: 'Tariff', rows: 3 };
    const importTariff = (body: Record<string, unknown>, staffId = officer.id) => call('/insurance/contracts/import-tariff', { payerId: 'payer:synthetic-a', mode: 'merge', source, requestKey: randomUUID(), ...body }, staffId);
    const draftTerms = async () => (await db.sql`SELECT terms, revision, version FROM payer_contract_versions WHERE payer_id = 'payer:synthetic-a' AND status = 'draft'`)[0];
    before(async () => {
      const admin = { ...envelopeFor(f), schemaVersion: 5 };
      await insertRecord(db.sql, 'fee_item', { ...admin, id: 'fee:retired', type: 'fee_item', name: 'Retired service', category: 'procedure', amountMinor: 100, currency: 'NGN', chargeWhen: 'when_ordered', active: false });
      await insertRecord(db.sql, 'fee_item', { ...admin, id: 'fee:usd', type: 'fee_item', name: 'Dollar service', category: 'procedure', amountMinor: 100, currency: 'USD', chargeWhen: 'when_ordered' });
    });
    it('starts a draft from the active version, merges confirmed prices and keeps everything else', async () => {
      const schedulesBefore = (await db.sql`SELECT COUNT(*)::int AS n FROM cover_schedules`)[0].n;
      assert.equal((await importTariff({ payerId: 'payer:unknown', lines: [{ feeItemId: 'fee:consult', unitMinor: 1, sourceRow: 2 }] })).json().error, 'no_contract_terms');
      const key = randomUUID();
      const lines = [{ feeItemId: 'fee:consult', unitMinor: 6_000, payerCode: 'SYN-CONS-01', sourceRow: 2 }, { feeItemId: 'fee:proc', unitMinor: 25_000, sourceRow: 3 }];
      const first = await importTariff({ requestKey: key, lines });
      assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual([first.json().added, first.json().changed, first.json().unchanged, first.json().removed], [1, 1, 0, 0]);
      const draft = await draftTerms();
      assert.equal(draft.version, 3);
      assert.deepEqual(draft.terms.tariff['fee:consult'], { unitMinor: 6_000, payerCode: 'SYN-CONS-01' });
      assert.deepEqual(draft.terms.tariff['fee:capt'], { unitMinor: 1_000 }, 'merge keeps prices the sheet does not mention');
      assert.equal(draft.terms.plans[0].planCode, 'GOLD', 'plans and rules carry over from the active version');
      assert.equal((await db.sql`SELECT COUNT(*)::int AS n FROM cover_schedules`)[0].n, schedulesBefore, 'importing never activates anything');
      // The same request again is a replay, not a second change; a different body under the same key is refused.
      const replay = await importTariff({ requestKey: key, lines });
      assert.deepEqual(replay.json(), first.json());
      assert.equal((await draftTerms()).revision, draft.revision);
      assert.equal((await importTariff({ requestKey: key, lines: lines.slice(0, 1) })).json().error, 'request_reused');
      const [audit] = await db.sql`SELECT metadata FROM audit_events WHERE metadata->>'context' = 'insurance_tariff_imported'`;
      assert.equal(audit.metadata.reportedFileSha256, source.sha256, 'the file checksum is kept only as reported by the browser');
      assert.match(first.json().payloadSha256, /^[0-9a-f]{64}$/);
      assert.equal(audit.metadata.payloadSha256, first.json().payloadSha256, 'the audit holds the server checksum of what it applied');
      assert.notEqual(audit.metadata.payloadSha256, source.sha256);
      assert.equal((await db.sql`SELECT 1 FROM audit_events WHERE metadata->>'context' = 'insurance_tariff_imported'`).length, 1, 'a replay is not audited twice');
    });
    it('needs the current draft revision, and replace makes the sheet the whole tariff', async () => {
      const lines = [{ feeItemId: 'fee:consult', unitMinor: 6_000, sourceRow: 2 }];
      assert.equal((await importTariff({ lines })).json().error, 'stale_draft', 'a second import must see the current draft');
      const draft = await draftTerms();
      const replaced = await importTariff({ mode: 'replace', expectedRevision: draft.revision, lines });
      assert.deepEqual([replaced.json().unchanged, replaced.json().removed], [1, 2], replaced.body);
      const after = await draftTerms();
      assert.deepEqual(Object.keys(after.terms.tariff), ['fee:consult']);
      assert.equal(after.terms.tariff['fee:consult'].payerCode, 'SYN-CONS-01', 'a row without a payer code keeps the recorded one');
    });
    it('two people importing into the same draft at once: one applies, the other must review first', async () => {
      const revision = (await draftTerms()).revision;
      const lines = (price: number) => [{ feeItemId: 'fee:consult', unitMinor: price, sourceRow: 2 }];
      const results = await Promise.all([importTariff({ expectedRevision: revision, lines: lines(6_100) }), importTariff({ expectedRevision: revision, lines: lines(6_200) })]);
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
      assert.equal(results.find((r) => r.statusCode === 409)!.json().error, 'stale_draft');
      assert.equal((await draftTerms()).revision, revision + 1, 'exactly one import applied');
    });
    it('checks every row again on the server, whatever the browser checked', async () => {
      const revision = (await draftTerms()).revision;
      const bad = await importTariff({ expectedRevision: revision, lines: [
        { feeItemId: 'fee:missing', unitMinor: 1, sourceRow: 2 }, { feeItemId: 'fee:retired', unitMinor: 1, sourceRow: 3 }, { feeItemId: 'fee:usd', unitMinor: 1, sourceRow: 4 },
      ] });
      assert.equal(bad.json().error, 'invalid_lines');
      assert.deepEqual(bad.json().details.rows.map((r: { problem: string }) => r.problem), ['unknown_fee_item', 'retired_fee_item', 'currency_mismatch']);
      const twice = await importTariff({ expectedRevision: revision, lines: [{ feeItemId: 'fee:consult', unitMinor: 1, sourceRow: 2 }, { feeItemId: 'fee:consult', unitMinor: 2, sourceRow: 3 }] });
      assert.equal(twice.statusCode, 400, 'one price per service');
      const formula = await importTariff({ expectedRevision: revision, lines: [{ feeItemId: 'fee:consult', unitMinor: 1, payerCode: '=HYPERLINK("http://example.org")', sourceRow: 2 }] });
      assert.equal(formula.statusCode, 400, 'formula-like codes are refused');
      assert.equal((await importTariff({ expectedRevision: revision, lines: [{ feeItemId: 'fee:consult', unitMinor: -5, sourceRow: 2 }] })).statusCode, 400);
      assert.equal((await draftTerms()).revision, revision, 'nothing was applied');
      for (const who of [cashier.id, f.admin.id]) assert.equal((await importTariff({ lines: [{ feeItemId: 'fee:consult', unitMinor: 1, sourceRow: 2 }] }, who)).statusCode, 403);
    });
    it('saves a column mapping by name and refuses a silent overwrite', async () => {
      const template = { kind: 'contract_tariff', payerId: 'payer:synthetic-a', name: 'Synthetic HMO tariff', headers: ['service', 'code', 'price'], headerRow: 0, mapping: { name: 0, payerCode: 1, price: 2 } };
      const saved = await call('/insurance/import-templates/save', template, officer.id);
      assert.equal(saved.json().revision, 1, saved.body);
      assert.equal((await call('/insurance/import-templates/save', template, officer.id)).json().error, 'stale_template');
      assert.equal((await call('/insurance/import-templates/save', { ...template, name: 'synthetic hmo TARIFF', mapping: { name: 0, price: 2 }, expectedRevision: 1 }, officer.id)).json().revision, 2, 'names match ignoring case');
      const listed = (await call('/insurance/import-templates/list', { kind: 'contract_tariff' }, officer.id)).json().templates;
      assert.deepEqual([listed.length, listed[0].mapping], [1, { name: 0, price: 2 }]);
      assert.equal((await call('/insurance/import-templates/save', { ...template, mapping: { name: 999 } }, officer.id)).statusCode, 400);
      assert.equal((await call('/insurance/import-templates/list', { kind: 'contract_tariff' }, cashier.id)).statusCode, 403);
      assert.equal((await call('/insurance/import-templates/list', { kind: 'patients' }, officer.id)).statusCode, 400);
    });
  });

  describe('claims from confirmed insurance splits', () => {
    let doctor: Staff;
    const listClaims = async (body: Record<string, unknown> = {}) => (await call('/insurance/claims/list', body, officer.id)).json().claims as {
      id: string; claimNumber: string; revision: number; state: string; supersededBy?: string; patientId: string; episode: { kind: string; key: string };
      lines: { chargeId: string; payerShareMinor: number; fulfillment: { kind: string }; authorization?: { reference?: string } }[]; issues: { code: string; blocking: boolean; chargeId?: string }[];
    }[];
    const claimWith = async (chargeId: string) => (await listClaims()).find((c) => c.lines.some((l) => l.chargeId === chargeId))!;
    const codes = (claim: { issues: { code: string; blocking: boolean }[] }) => claim.issues.filter((i) => i.blocking).map((i) => i.code).sort();
    const completion = (id: string, chargeId: string, by: Staff, role: string, status = 'completed', extra: Record<string, unknown> = {}) => put('service_completion', {
      ...envelope(by), id, type: 'service_completion', patientId: patient('000004'), chargeId, status, completedOn: new Date(Date.now() - 60_000).toISOString(), actorRole: role, ...(status === 'not_done' ? { note: 'Patient declined' } : {}), ...extra,
    });
    const profileRevision = async () => (await call('/insurance/submission/list', {}, officer.id)).json().profiles[0].revision as number;
    before(async () => {
      doctor = await addStaff(db.sql, f, { role: 'doctor' });
      // A real visit: a doctor's diagnosis entry (ICD-10 coded), and its consultation fee raised against the visit.
      await insertRecord(db.sql, 'encounter', { ...envelope(doctor), id: 'encounter:claim', type: 'encounter', patientId: patient('000004'), openedOn: new Date().toISOString(), setting: 'facility' });
      await insertRecord(db.sql, 'encounter_entry', { ...envelope(doctor), id: 'entry:claim-dx', type: 'encounter_entry', encounterId: 'encounter:claim', patientId: patient('000004'), step: 'diagnosis', actorRole: 'doctor',
        values: { diagnosis: 'Malaria', diagnoses: [{ label: 'Malaria', code: 'B54', codingSystem: 'ICD-10', certainty: 'confirmed' }] } });
      await insertRecord(db.sql, 'charge', { ...envelope(desk), id: 'charge:claim-visit', type: 'charge', patientId: patient('000004'), feeItemId: 'fee:consult', category: 'consultation', description: 'Consultation', listPriceMinor: 5_000, amountMinor: 5_000, currency: 'NGN', encounterId: 'encounter:claim' });
      assert.equal((await confirm(['charge:claim-visit'], { basis: 'exception', reason: 'Synthetic visit for claims' })).json().outcomes[0].outcome, 'confirmed');
    });

    it('makes one claim per payer, patient and episode from per-service splits the payer owes; never capitation, never twice', async () => {
      const generated = await call('/insurance/claims/generate', {}, officer.id);
      assert.equal(generated.statusCode, 200, generated.body);
      assert.ok(generated.json().created >= 2);
      const all = await listClaims();
      const lines = all.flatMap((c) => c.lines);
      assert.ok(lines.every((l) => l.payerShareMinor > 0), 'only what the payer owes is claimed');
      assert.equal(lines.some((l) => l.chargeId === 'charge:capt'), false, 'capitation never becomes a fee-for-service claim');
      assert.equal(new Set(lines.map((l) => l.chargeId)).size, lines.length, 'each service once');
      const visit = await claimWith('charge:claim-visit');
      assert.deepEqual(visit.episode, { kind: 'encounter', key: 'encounter:claim' });
      assert.ok(all.every((c) => new Set(c.lines.map(() => c.patientId)).size === 1));
      assert.equal((await call('/insurance/claims/generate', {}, officer.id)).json().lines, 0, 'generating again adds nothing');
      const [line] = await db.sql`SELECT * FROM insurance_claim_lines WHERE charge_id = 'charge:claim-visit'`;
      await assert.rejects(db.sql`INSERT INTO insurance_claim_lines (id, facility_id, claim_id, charge_id, allocation_id, contract_version_id) VALUES ('dup', ${f.facility.id}, ${line.claim_id}, 'charge:claim-visit', ${line.allocation_id}, 'x')`, 'the database refuses a second claim line');
      for (const who of [cashier.id, f.admin.id, supervisor.id]) assert.equal((await call('/insurance/claims/list', {}, who)).statusCode, 403, 'claims carry payer shares: officers only');
    });

    it('blocks readiness until evidence and the payer\'s diagnosis rule are met; a draft exports only as a marked draft', async () => {
      let visit = await claimWith('charge:claim-visit');
      assert.equal(visit.lines[0].fulfillment.kind, 'visit', 'the doctor\'s entry shows the consultation happened');
      assert.deepEqual(codes(visit), ['diagnosis_coding_unverified'], 'coded diagnoses cannot pass without a verified ICD-10 catalogue');
      const day = await claimWith('charge:later');
      assert.ok(codes(day).includes('fulfillment_missing') && codes(day).includes('diagnosis_missing'));
      const ready = await call('/insurance/claims/ready', { claimIds: [visit.id] }, officer.id);
      assert.equal(ready.json().outcomes[0].reason, 'blocked');
      assert.equal((await call('/insurance/claims/export', { claimIds: [visit.id], draft: false, format: 'csv', requestKey: randomUUID() }, officer.id)).json().error, 'not_ready');
      const draft = await call('/insurance/claims/export', { claimIds: [visit.id, day.id], draft: true, format: 'xlsx', requestKey: randomUUID() }, officer.id);
      assert.equal(draft.statusCode, 200, draft.body);
      const status = draft.json().headers.indexOf('claimStatus');
      assert.ok(draft.json().rows.every((r: unknown[]) => r[status] === 'DRAFT - NOT FOR SUBMISSION'));
      assert.equal((await claimWith('charge:claim-visit')).state, 'draft', 'a draft export changes nothing');
      // This payer accepts written diagnoses: a configurable rule, recorded with the submission method.
      const saved = await call('/insurance/submission/save', { payerId: 'payer:synthetic-a', profile: { method: 'manual', channel: 'physical', diagnosisRequirement: 'free_text' }, expectedRevision: await profileRevision() }, officer.id);
      assert.equal(saved.statusCode, 200, saved.body);
      visit = await claimWith('charge:claim-visit');
      assert.deepEqual(codes(visit), []);
      assert.equal((await call('/insurance/claims/ready', { claimIds: [visit.id] }, officer.id)).json().outcomes[0].outcome, 'ready');
      const [row] = await db.sql`SELECT ready_snapshot FROM insurance_claims WHERE id = ${visit.id}`;
      assert.equal(row.ready_snapshot.lines[0].fulfillment.kind, 'visit', 'what passed is kept with the claim');
      assert.equal(row.ready_snapshot.lines[0].contractVersionId, 'contract:payer:synthetic-a:v2', 'traceable to the contract version');
    });

    it('needs clinical evidence from clinical staff, and an approved authorization where the contract requires one', async () => {
      // A procedure under a rule that requires the payer's approval.
      await insertRecord(db.sql, 'charge', { ...envelope(desk), id: 'charge:claim-proc', type: 'charge', patientId: patient('000004'), feeItemId: 'fee:proc', category: 'procedure', description: 'Synthetic procedure', listPriceMinor: 20_000, amountMinor: 20_000, currency: 'NGN', encounterId: 'encounter:claim' });
      await insertRecord(db.sql, 'coverage_allocation', { ...envelope(officer), id: 'alloc:claim-proc', type: 'coverage_allocation', patientId: patient('000004'), chargeId: 'charge:claim-proc', state: 'finalised', payerId: 'payer:synthetic-a', arrangement: 'per_service', patientShareMinor: 0, currency: 'NGN', basis: 'exception' });
      await db.sql`INSERT INTO coverage_allocation_details (allocation_id, facility_id, calculation_version, inputs, list_price_minor, patient_share_minor, payer_share_minor, contract_adjustment_minor, capitation_covered_minor, reason, request_key)
        VALUES ('alloc:claim-proc', ${f.facility.id}, 1, ${db.sql.json({ serviceDate: day(0), units: 1, cover: { id: 'cover:setup', planCode: 'GOLD', enrolleeNumber: 'SYN-000004' }, planCode: 'GOLD', contractVersionId: 'contract:payer:synthetic-a:v2', rule: { coverage: 'covered', copay: { kind: 'none' }, approvalRequired: true }, tariffUnitMinor: 20_000, termsSlice: { tariff: { 'fee:proc': { unitMinor: 20_000, payerCode: 'SYN-P-01' } } } })}, 20000, 0, 20000, 0, 0, 'Synthetic', 'synthetic')`;
      assert.equal((await call('/insurance/claims/generate', {}, officer.id)).json().lines, 1);
      let claim = await claimWith('charge:claim-proc');
      assert.deepEqual(codes(claim), ['authorization_missing', 'fulfillment_missing'], 'the visit claim was already ready, so this is a new claim');
      // Only clinical staff record that a service was done; an insurance officer cannot.
      assert.equal((await send([completion('done:officer', 'charge:claim-proc', officer, 'doctor')])).rejected.length, 1);
      assert.equal((await send([completion('done:wrong-role', 'charge:claim-proc', doctor, 'nurse')])).rejected.length, 1, 'only in a role the person holds');
      assert.equal((await send([completion('done:1', 'charge:claim-proc', doctor, 'doctor', 'not_done')])).rejected.length, 0);
      claim = await claimWith('charge:claim-proc');
      assert.ok(codes(claim).includes('not_performed'));
      assert.equal((await send([completion('done:2', 'charge:claim-proc', doctor, 'doctor', 'completed', { replaces: 'done:1' })])).rejected.length, 0, 'a correction replaces the earlier record');
      assert.equal((await send([completion('done:3', 'charge:claim-proc', doctor, 'doctor', 'completed', { replaces: 'done:1' })])).rejected.length, 1, 'once');
      await assert.rejects(db.sql`UPDATE service_completions SET status = 'completed' WHERE id = 'done:1'`, 'completions never change');
      const auth = (body: Record<string, unknown>) => call('/insurance/authorizations/save', { patientId: patient('000004'), payerId: 'payer:synthetic-a', kind: 'pre_authorization', validFrom: day(-1), validTo: day(1), categories: ['procedure'], obtainedVia: 'phone', ...body }, officer.id);
      assert.equal((await auth({ status: 'approved' })).statusCode, 400, 'an approval needs the payer\'s code');
      const requested = await auth({ status: 'requested' });
      assert.equal(requested.statusCode, 200, requested.body);
      assert.deepEqual(codes(await claimWith('charge:claim-proc')), ['authorization_pending'], 'a request is not an approval');
      assert.equal((await auth({ status: 'approved', reference: 'PA-SYN-001', replaces: requested.json().id })).statusCode, 200);
      claim = await claimWith('charge:claim-proc');
      assert.deepEqual(codes(claim), []);
      assert.equal(claim.lines[0].authorization?.reference, 'PA-SYN-001');
      assert.equal(claim.lines[0].fulfillment.kind, 'completion');
      assert.equal((await auth({ status: 'denied', replaces: requested.json().id })).json().error, 'already_replaced');
    });

    it('exports in the payer\'s layout; export, submission and acknowledgement stay separate facts; a revision keeps history', async () => {
      const visit = await claimWith('charge:claim-visit');
      const layout = await call('/insurance/import-templates/save', { kind: 'claim_export', payerId: 'payer:synthetic-a', name: 'Synthetic HMO claim sheet', headerRow: 0,
        headers: ['Enrollee No', 'Patient', 'Date of Service', 'Diagnosis', 'Service', 'Amount (NGN)'],
        mapping: { enrolleeNumber: 0, patientName: 1, serviceDate: 2, diagnosis: 3, serviceName: 4, amountClaimed: 5 }, formats: { serviceDate: 'date_dmy' } }, officer.id);
      assert.equal(layout.statusCode, 200, layout.body);
      assert.equal((await call('/insurance/import-templates/save', { kind: 'claim_export', name: 'Bad', headerRow: 0, headers: ['A'], mapping: { password: 0 } }, officer.id)).json().error, 'unknown_fields');
      const submit = (body: Record<string, unknown> = {}) => call('/insurance/claims/submit', { claimIds: [visit.id], channel: 'physical', reference: 'SYN-DELIVERY-1', submittedOn: day(0), requestKey: randomUUID(), ...body }, officer.id);
      assert.equal((await submit()).json().error, 'not_exported', 'nothing is submitted before it is exported');
      const key = randomUUID();
      const exported = await call('/insurance/claims/export', { claimIds: [visit.id], draft: false, format: 'xlsx', templateId: layout.json().id, requestKey: key }, officer.id);
      assert.equal(exported.statusCode, 200, exported.body);
      assert.deepEqual(exported.json().headers, ['Enrollee No', 'Patient', 'Date of Service', 'Diagnosis', 'Service', 'Amount (NGN)']);
      assert.match(String(exported.json().rows[0][2]), /^\d{2}\/\d{2}\/\d{4}$/);
      assert.equal(exported.json().rows[0][3], 'Malaria');
      assert.equal(exported.json().rows[0][5], 45, 'the payer share: NGN 50.00 less the 10% co-pay');
      assert.equal((await call('/insurance/claims/export', { claimIds: [visit.id], draft: false, format: 'xlsx', templateId: layout.json().id, requestKey: key }, officer.id)).json().exportId, exported.json().exportId, 'a retried export replays');
      assert.equal((await claimWith('charge:claim-visit')).state, 'exported', 'exported, not submitted');
      const sent = await submit();
      assert.equal(sent.statusCode, 200, sent.body);
      assert.equal((await claimWith('charge:claim-visit')).state, 'submitted', 'submitted, not approved');
      const ack = (requestKey = randomUUID()) => call('/insurance/claims/acknowledge', { submissionId: sent.json().submissionId, acknowledgedOn: day(0), reference: 'SYN-ACK-1', requestKey }, officer.id);
      assert.equal((await ack()).statusCode, 200);
      assert.equal((await ack()).json().error, 'already_acknowledged');
      assert.equal((await claimWith('charge:claim-visit')).state, 'acknowledged');
      // A correction: a new revision, the earlier one and its submission untouched.
      const revised = await call(`/insurance/claims/${encodeURIComponent(visit.id)}/revise`, { reason: 'Synthetic correction requested by the payer', requestKey: randomUUID() }, officer.id);
      assert.equal(revised.statusCode, 200, revised.body);
      const both = (await listClaims({ includeSuperseded: true })).filter((c) => c.claimNumber === visit.claimNumber).sort((a, b) => a.revision - b.revision);
      assert.deepEqual(both.map((c) => [c.revision, c.state, Boolean(c.supersededBy)]), [[1, 'acknowledged', true], [2, 'draft', false]]);
      assert.deepEqual(both[1].lines.map((l) => l.chargeId), ['charge:claim-visit']);
      assert.equal((await call('/insurance/claims/ready', { claimIds: [visit.id] }, officer.id)).json().error, 'superseded');
      await assert.rejects(db.sql`UPDATE insurance_claims SET state = 'draft' WHERE id = ${visit.id}`, 'a superseded revision never changes');
      assert.equal((await call('/insurance/claims/submissions/list', {}, officer.id)).json().submissions[0].acknowledgement.reference, 'SYN-ACK-1');
    });

    it('two officers generating at once never claim a service twice', async () => {
      await insertRecord(db.sql, 'charge', { ...envelope(desk), id: 'charge:claim-race', type: 'charge', patientId: patient('000004'), feeItemId: 'fee:consult', category: 'consultation', description: 'Consultation', listPriceMinor: 5_000, amountMinor: 5_000, currency: 'NGN' });
      assert.equal((await confirm(['charge:claim-race'], { basis: 'exception', reason: 'Synthetic race' })).json().outcomes[0].outcome, 'confirmed');
      const results = await Promise.all([call('/insurance/claims/generate', {}, officer.id), call('/insurance/claims/generate', {}, officer.id)]);
      assert.deepEqual(results.map((r) => r.json().lines).sort(), [0, 1]);
      assert.equal((await db.sql`SELECT COUNT(*)::int AS n FROM insurance_claim_lines WHERE charge_id = 'charge:claim-race' AND current`)[0].n, 1);
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
    });
    it('deactivating billing keeps every confirmed obligation and the insurance treatment of charges raised while it was on', async () => {
      const before = await balance('charge:recon');
      const whileActive = await balance('charge:while-active');
      assert.notEqual(whileActive, 5_000);
      await setInsuranceState(db.sql, { facilityId: f.facility.id, state: 'off', operator: 'synthetic-operator', governanceReference: 'synthetic:deactivation' });
      assert.equal(await balance('charge:recon'), before, 'a confirmed split still decides what the patient owes');
      assert.equal(await balance('charge:setup'), 5_000);
      assert.equal(await balance('charge:while-active'), whileActive, 'a charge raised while billing was on keeps its insurance treatment');
      await charge('charge:after-off', 'fee:consult', 'consultation', 5_000, '000004');
      assert.equal(await balance('charge:after-off'), 5_000, 'a charge raised after deactivation is billed as cash');
      const t = (await token()).json();
      assert.equal(t.insuranceWorkflowVersion, 1, 'devices keep the insurance records behind those obligations');
      assert.equal(t.insuranceBillingActive, false);
      assert.ok(t.insuranceBillingPeriods[0].to, 'the period is closed');
      assert.equal((await call('/insurance/allocations/preview', { chargeIds: ['charge:while-active'] }, officer.id)).statusCode, 200, 'officers can still work historical charges');
      await assert.rejects(db.sql`UPDATE insurance_billing_periods SET starts_on = now()`, 'a closed period never changes');
      await assert.rejects(db.sql`UPDATE cover_schedules SET ended_on = ${day(5)} WHERE contract_version_id = 'contract:payer:synthetic-a:v2'`, 'an end date is recorded once');
    });
  });
});
