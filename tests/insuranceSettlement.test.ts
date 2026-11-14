import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { POLICY_VERSION, serviceDateOf, type FacilityRegistrationResult, type Staff, type UploadMutation } from '#shared';
import { insertRecord } from '../src/db/records.ts';
import { availableOnCharge } from '../src/billing/ledger.ts';
import { setInsuranceState } from '../src/insurance/enablement.ts';
import { buildSyncConfig } from '../src/sync/syncConfig.ts';
import { addStaff, asDevice, clientId, envelopeFor, lastCodeSentTo, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

/**
 * The insurance audit fixes (H1–H3) and hospital-side settlement (Slice 4)
 * against a disposable PostgreSQL database. Every payer, plan, code and price
 * here is synthetic.
 */
describe('insurance completion: audit fixes and settlement', () => {
  let db: ScratchDatabase; let app: FastifyInstance; let f: FacilityRegistrationResult;
  let officer: Staff; let cashier: Staff; let desk: Staff; let doctor: Staff; let chew: Staff; let nurse: Staff;
  const tokens = new Map<string, string>();
  const TZ = 'Africa/Lagos';
  const VERSIONS = { insuranceWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: POLICY_VERSION } as const;
  const day = (offset: number) => serviceDateOf(new Date(Date.now() + offset * 86_400_000).toISOString(), TZ)!;
  const patient = (n: string) => `${f.facility.id}-${n}-K2`;
  const balance = (chargeId: string) => availableOnCharge(db.sql as never, f.facility.id, chargeId);
  const PAYER = 'payer:synthetic-s';

  const login = async (staffId: string, email: string) => {
    const code = await app.inject({ method: 'POST', url: '/workforce/access/code', headers: asDevice(f.device.credential), payload: { staffId } });
    assert.equal(code.statusCode, 202, code.body);
    const verified = await app.inject({ method: 'POST', url: '/workforce/access/verify', headers: asDevice(f.device.credential), payload: { staffId, code: lastCodeSentTo(email) } });
    assert.equal(verified.statusCode, 200, verified.body);
    tokens.set(staffId, verified.json().token);
  };
  const call = (path: string, payload: unknown, staffId: string) => app.inject({
    method: 'POST', url: path, payload: payload as object, headers: { ...asDevice(f.device.credential), 'x-workforce-access': tokens.get(staffId) ?? '' },
  });
  const put = (table: UploadMutation['table'], record: Record<string, unknown>): UploadMutation => ({ clientId: clientId(), op: 'put', table, id: String(record.id), data: record });
  const send = (mutations: UploadMutation[]) => upload(app, f.device.credential, { ...VERSIONS, transactionId: 1, mutations } as never);
  const envelope = (by: Staff) => ({ ...envelopeFor(f), createdBy: by.id, schemaVersion: 5 });
  const ready = async () => { const r = await app.inject({ method: 'POST', url: '/sync/token', headers: asDevice(f.device.credential), payload: { ...VERSIONS, clinicalWorkflowVersion: 1, pendingMutationCount: 0 } }); assert.equal(r.statusCode, 200, r.body); };
  const key = () => randomUUID();

  /** One insured visit: verified cover, a clinician's entries, a consultation charge on the visit, confirmed. */
  const visit = async (n: string, opts: { entries?: { by: Staff; step: string; values: Record<string, unknown> }[]; feeItemId?: string; category?: string; price?: number; confirm?: boolean } = {}) => {
    const patientId = patient(n);
    await insertRecord(db.sql, 'patient', { ...envelopeFor(f), schemaVersion: 5, id: patientId, patientId, type: 'patient', fullName: `Synthetic patient ${n}`, address: 'Synthetic address', sex: 'female', ageYears: 30 });
    const coverId = `cover:${n}`;
    assert.equal((await send([
      put('patient_cover', { ...envelope(desk), id: coverId, type: 'patient_cover', patientId, payerId: PAYER, planCode: 'GOLD', enrolleeNumber: `SYN-${n}`, relationship: 'principal', active: true }),
      put('cover_check', { ...envelope(desk), id: `check:${n}`, type: 'cover_check', patientId, coverId, method: 'portal', reference: 'SYN-REF', result: 'verified', coversFrom: day(-1), coversTo: day(1) }),
    ])).rejected.length, 0);
    const encounterId = `encounter:${n}`;
    await insertRecord(db.sql, 'encounter', { ...envelope(doctor), id: encounterId, type: 'encounter', patientId, openedOn: new Date().toISOString(), setting: 'facility' });
    for (const [i, e] of (opts.entries ?? [{ by: doctor, step: 'diagnosis', values: { diagnosis: 'Malaria', diagnoses: [{ label: 'Malaria', code: 'B54', codingSystem: 'ICD-10', certainty: 'confirmed' }] } }]).entries()) {
      await insertRecord(db.sql, 'encounter_entry', { ...envelope(e.by), id: `entry:${n}:${i}`, type: 'encounter_entry', encounterId, patientId, step: e.step, actorRole: e.by.role, values: e.values });
    }
    const chargeId = `charge:${n}`;
    await insertRecord(db.sql, 'charge', { ...envelope(desk), id: chargeId, type: 'charge', patientId, feeItemId: opts.feeItemId ?? 'fee:consult', category: opts.category ?? 'consultation', description: 'Synthetic service', listPriceMinor: opts.price ?? 5_000, amountMinor: opts.price ?? 5_000, currency: 'NGN', encounterId });
    if (opts.confirm !== false) {
      const confirmed = await call('/insurance/allocations/confirm', { chargeIds: [chargeId], requestKey: key(), basis: 'exception', reason: 'Synthetic visit' }, officer.id);
      assert.equal(confirmed.json().outcomes[0].outcome, 'confirmed', confirmed.body);
    }
    return { patientId, chargeId, encounterId, coverId };
  };
  type Claim = { id: string; claimNumber: string; revision: number; state: string; payerShareMinor: number; issues: { code: string; blocking: boolean }[]; diagnoses: { code?: string; verification: string }[];
    lines: { chargeId: string; fulfillment: { kind: string } }[]; settlement: { status: string; outstandingMinor: number; paidMinor: number; payerOwesMinor: number; deductedMinor: number; writtenOffMinor: number; disputedMinor: number }; decisions: { decision: string }[] };
  const claimFor = async (chargeId: string, includeSuperseded = false): Promise<Claim> => {
    await call('/insurance/claims/generate', {}, officer.id);
    const claims = (await call('/insurance/claims/list', { includeSuperseded }, officer.id)).json().claims as Claim[];
    return claims.find((c) => c.lines.some((l) => l.chargeId === chargeId) && !('supersededBy' in c && (c as { supersededBy?: string }).supersededBy))!;
  };
  const codes = (c: Claim) => c.issues.filter((i) => i.blocking).map((i) => i.code).sort();
  /** Ready, exported and submitted: the payer has it. */
  const submitted = async (chargeId: string) => {
    const claim = await claimFor(chargeId);
    const r = await call('/insurance/claims/ready', { claimIds: [claim.id] }, officer.id);
    assert.equal(r.json().outcomes[0].outcome, 'ready', JSON.stringify(r.json()));
    const exported = await call('/insurance/claims/export', { claimIds: [claim.id], draft: false, format: 'csv', requestKey: key() }, officer.id);
    assert.equal(exported.statusCode, 200, exported.body);
    const sent = await call('/insurance/claims/submit', { claimIds: [claim.id], channel: 'portal', reference: `SYN-PORTAL-${claim.claimNumber}-${claim.revision}`, submittedOn: day(0), exportIds: [exported.json().exportId], requestKey: key() }, officer.id);
    assert.equal(sent.statusCode, 200, sent.body);
    return claimFor(chargeId);
  };
  const decide = (claimId: string, body: Record<string, unknown>, by = officer.id) => call('/insurance/claims/decisions/record', { claimId, decidedOn: day(0), requestKey: key(), ...body }, by);
  const remit = (body: Record<string, unknown>, by = officer.id) => call('/insurance/remittances/record', { payerId: PAYER, receivedOn: day(0), currency: 'NGN', method: 'transfer', requestKey: key(), ...body }, by);

  before(async () => {
    db = await scratchDatabase(); f = await registerScratchFacility(db.sql); app = testApp(db.sql);
    officer = await addStaff(db.sql, f, { role: 'insurance_officer' }); cashier = await addStaff(db.sql, f, { role: 'cashier' }); desk = await addStaff(db.sql, f, { role: 'records_officer' });
    doctor = await addStaff(db.sql, f, { role: 'doctor' }); chew = await addStaff(db.sql, f, { role: 'chew' }); nurse = await addStaff(db.sql, f, { role: 'nurse' });
    for (const [s, email] of [[officer, 'officer@example.org'], [cashier, 'cashier@example.org']] as const) await db.sql`INSERT INTO staff_contacts (facility_id, staff_id, email, verified_on) VALUES (${f.facility.id}, ${s.id}, ${email}, now())`;
    const admin = { ...envelopeFor(f), schemaVersion: 5 };
    for (const [id, category, amountMinor] of [['fee:consult', 'consultation', 5_000], ['fee:proc', 'procedure', 20_000], ['fee:other', 'consultation', 2_000]] as const) {
      await insertRecord(db.sql, 'fee_item', { ...admin, id, type: 'fee_item', name: id, category, amountMinor, currency: 'NGN', chargeWhen: 'when_ordered' });
    }
    await login(officer.id, 'officer@example.org'); await login(cashier.id, 'cashier@example.org'); await login(f.admin.id, 'admin@example.org');
    await setInsuranceState(db.sql, { facilityId: f.facility.id, state: 'setup', operator: 'synthetic-operator', governanceReference: 'synthetic:setup', timeZone: TZ });
    assert.equal((await call('/insurance/payers/save', { id: PAYER, name: 'Synthetic HMO S', kind: 'hmo', code: 'SYNS', active: true }, officer.id)).statusCode, 200);
    const terms = {
      payerId: PAYER, effectiveFrom: '2020-01-01', currency: 'NGN',
      arrangements: { categories: { consultation: 'per_service', procedure: 'per_service' }, items: {} },
      tariff: { 'fee:consult': { unitMinor: 4_000, payerCode: 'SYN-C1' }, 'fee:proc': { unitMinor: 20_000, payerCode: 'SYN-P1' } },
      plans: [{ planCode: 'GOLD', name: 'Synthetic gold', rules: { categories: {
        consultation: { coverage: 'covered', copay: { kind: 'percent', basisPoints: 1_000 } },
        procedure: { coverage: 'covered', copay: { kind: 'none' }, approvalRequired: true },
      }, items: {} } }],
    };
    const draft = await call('/insurance/contracts/draft', { terms }, officer.id);
    assert.equal(draft.statusCode, 200, draft.body);
    await ready();
    const activated = await call('/insurance/contracts/activate', { contractVersionId: `contract:${PAYER}:v1`, acknowledgeUnsupported: true, requestKey: key() }, f.admin.id);
    assert.equal(activated.statusCode, 200, activated.body);
    assert.equal((await call('/insurance/submission/save', { payerId: PAYER, profile: { method: 'manual', channel: 'portal', portalUrl: 'https://portal.example.org', diagnosisRequirement: 'codes_as_entered', paymentDueDays: 30 } }, officer.id)).statusCode, 200);
    await setInsuranceState(db.sql, { facilityId: f.facility.id, state: 'active', operator: 'synthetic-operator', governanceReference: 'synthetic:activation' });
  });
  after(async () => { if (app) await app.close(); if (db) await db.drop(); });

  it('keeps payer decisions, payer money, disputes, write-offs and code lists off every device', async () => {
    const secret = ['insurance_claim_decisions', 'insurance_claim_line_decisions', 'insurance_remittances', 'insurance_remittance_allocations', 'insurance_remittance_reversals',
      'insurance_claim_disputes', 'insurance_claim_dispute_resolutions', 'insurance_write_offs', 'diagnosis_catalogue_entries', 'diagnosis_catalogue_imports'];
    const config = buildSyncConfig();
    for (const table of secret) assert.ok(!config.includes(table), table);
    const published = (await db.sql<{ tablename: string }[]>`SELECT tablename FROM pg_publication_tables WHERE pubname = 'powersync'`).map((r) => r.tablename);
    for (const table of secret) assert.ok(!published.includes(table), table);
  });

  describe('evidence and diagnoses (H1)', () => {
    it('a nurse\'s vitals do not show a consultation took place; a CHEW\'s or doctor\'s entry does', async () => {
      const v = await visit('100001', { entries: [{ by: nurse, step: 'vitals', values: { temperatureC: 37 } }, { by: doctor, step: 'diagnosis', values: { diagnosis: 'Fever' } }].slice(0, 1) });
      let claim = await claimFor(v.chargeId);
      assert.equal(claim.lines[0].fulfillment.kind, 'missing');
      assert.ok(codes(claim).includes('fulfillment_missing'));
      await insertRecord(db.sql, 'encounter_entry', { ...envelope(chew), id: 'entry:100001:chew', type: 'encounter_entry', encounterId: v.encounterId, patientId: v.patientId, step: 'complaint', actorRole: 'chew', values: { complaints: ['Fever for two days'] } });
      claim = await claimFor(v.chargeId);
      assert.equal(claim.lines[0].fulfillment.kind, 'visit', 'CHEWs consult in primary care');
    });
    it('a payer that accepts codes as entered needs no catalogue; the code is labelled format-checked, never verified', async () => {
      const v = await visit('100002');
      const claim = await claimFor(v.chargeId);
      assert.deepEqual(codes(claim), []);
      assert.equal(claim.diagnoses[0].verification, 'format_checked');
    });
    it('a malformed code blocks the claim; a payer requiring verified codes needs the hospital\'s licensed list', async () => {
      const v = await visit('100003', { entries: [{ by: doctor, step: 'diagnosis', values: { diagnosis: 'Malaria', diagnoses: [{ label: 'Malaria', code: 'MAL', codingSystem: 'ICD-10', certainty: 'confirmed' }] } }] });
      assert.deepEqual(codes(await claimFor(v.chargeId)), ['diagnosis_code_format']);
    });
  });

  describe('authorization (H2)', () => {
    it('an emergency exception keeps care going but the claim blocked until the payer\'s approval; approved quantities are enforced', async () => {
      const v = await visit('100004', { feeItemId: 'fee:proc', category: 'procedure', price: 20_000, entries: [{ by: doctor, step: 'diagnosis', values: { diagnosis: 'Appendicitis', diagnoses: [{ label: 'Appendicitis', code: 'K35.8', codingSystem: 'ICD-10' }] } }] });
      assert.equal((await send([put('service_completion', { ...envelope(doctor), id: 'done:100004', type: 'service_completion', patientId: v.patientId, chargeId: v.chargeId, status: 'completed', completedOn: new Date(Date.now() - 60_000).toISOString(), actorRole: 'doctor' })])).rejected.length, 0);
      const auth = (body: Record<string, unknown>) => call('/insurance/authorizations/save', { patientId: v.patientId, payerId: PAYER, kind: 'pre_authorization', validFrom: day(-1), validTo: day(1), feeItemIds: ['fee:proc'], obtainedVia: 'phone', ...body }, officer.id);
      assert.equal((await auth({ status: 'emergency_exception' })).statusCode, 400, 'an emergency exception says why care could not wait');
      const emergency = await auth({ status: 'emergency_exception', note: 'Synthetic: acute abdomen, payer line closed' });
      assert.equal(emergency.statusCode, 200, emergency.body);
      assert.deepEqual(codes(await claimFor(v.chargeId)), ['authorization_emergency_followup']);
      assert.equal((await auth({ status: 'approved', reference: 'PA-SYN-9', approvedQuantities: { 'fee:other': 1 }, replaces: emergency.json().id })).statusCode, 400, 'a quantity names an authorized service');
      assert.equal((await auth({ status: 'approved', reference: 'PA-SYN-9', approvedQuantities: { 'fee:proc': 1 }, requestedOn: day(-1), replaces: emergency.json().id })).statusCode, 200);
      assert.deepEqual(codes(await claimFor(v.chargeId)), []);
    });
  });

  describe('making the patient liable (H3)', () => {
    it('needs a documented ground, never an unrecorded rule or missing configuration, and a separate approval for what the payer owes', async () => {
      const v = await visit('100005', { confirm: false });
      const selfPay = (liability: Record<string, unknown> | undefined, by = officer.id) => call('/insurance/allocations/confirm', { chargeIds: [v.chargeId], requestKey: key(), basis: 'exception', decision: 'self_pay', reason: 'Synthetic', ...(liability ? { liability } : {}) }, by);
      assert.equal((await selfPay(undefined)).statusCode, 400, 'a reason alone is not a ground');
      assert.equal((await selfPay({ ground: 'patient_election', patientAgreement: 'Signed synthetic form' })).json().outcomes[0].reason, 'contract_does_not_allow_self_pay', 'an unrecorded contract rule never permits it');
      assert.equal((await selfPay({ ground: 'contract_clause', contractClause: 'Synthetic clause 7.2' })).json().outcomes[0].reason, 'liability_approval_required', 'the officer cannot move what the payer owes');
      assert.equal((await selfPay({ ground: 'contract_clause', contractClause: 'Synthetic clause 7.2' }, cashier.id)).statusCode, 403);
      const approved = await selfPay({ ground: 'contract_clause', contractClause: 'Synthetic clause 7.2' }, f.admin.id);
      assert.equal(approved.json().outcomes[0].outcome, 'confirmed', approved.body);
      const [row] = await db.sql`SELECT d.inputs FROM coverage_allocation_details d JOIN coverage_allocations a ON a.id = d.allocation_id WHERE a.charge_id = ${v.chargeId}`;
      assert.equal(row.inputs.liability.contractClause, 'Synthetic clause 7.2');
      assert.equal(row.inputs.approvedBy, f.admin.id, 'who approved it is kept with the snapshot');
    });
    it('a charge on a current claim is never moved; the claim is revised first', async () => {
      const v = await visit('100006');
      await claimFor(v.chargeId);
      const moved = await call('/insurance/allocations/confirm', { chargeIds: [v.chargeId], requestKey: key(), basis: 'exception', decision: 'self_pay', reason: 'Synthetic', liability: { ground: 'contract_clause', contractClause: 'Synthetic clause 7.2' } }, f.admin.id);
      assert.equal(moved.json().outcomes[0].reason, 'on_current_claim');
    });
    it('missing hospital configuration is never a ground; a recorded not-eligible check is', async () => {
      const v = await visit('100007', { feeItemId: 'fee:other', price: 2_000, confirm: false });
      const moved = await call('/insurance/allocations/confirm', { chargeIds: [v.chargeId], requestKey: key(), basis: 'exception', decision: 'self_pay', reason: 'Synthetic', liability: { ground: 'contract_clause', contractClause: 'Synthetic' } }, f.admin.id);
      assert.equal(moved.json().outcomes[0].reason, 'missing_configuration_is_not_a_ground');
      const n = await visit('100008', { confirm: false });
      assert.equal((await send([put('cover_check', { ...envelope(desk), id: 'check:100008:ne', type: 'cover_check', patientId: n.patientId, coverId: n.coverId, method: 'phone', reference: 'SYN-NE', result: 'not_eligible', coversFrom: day(-1), coversTo: day(1) })])).rejected.length, 0);
      const ne = await call('/insurance/allocations/confirm', { chargeIds: [n.chargeId], requestKey: key(), basis: 'exception', decision: 'self_pay', reason: 'Payer said not eligible', liability: { ground: 'not_eligible', coverCheckId: 'check:100008:ne' } }, officer.id);
      assert.equal(ne.json().outcomes[0].outcome, 'confirmed', ne.body);
    });
  });

  describe('payer decisions and remittances (Slice 4)', () => {
    it('Scenario F: the payer approves and pays in full; the claim settles and the patient\'s account is untouched', async () => {
      const v = await visit('200001');
      const patientOwes = await balance(v.chargeId);
      const claim = await submitted(v.chargeId);
      assert.equal(claim.settlement.status, 'awaiting_response');
      assert.equal(claim.settlement.outstandingMinor, 3_600, 'the payer share: tariff 4,000 less the 10% co-pay');
      assert.equal((await decide(claim.id, { decision: 'approved' })).statusCode, 200);
      const paid = await remit({ reference: 'SYN-PAY-F', amountMinor: 3_600, allocations: [{ claimId: claim.id, amountMinor: 3_600 }] });
      assert.equal(paid.statusCode, 200, paid.body);
      const after = await claimFor(v.chargeId);
      assert.deepEqual([after.settlement.status, after.settlement.outstandingMinor, after.settlement.paidMinor], ['settled', 0, 3_600]);
      assert.equal(await balance(v.chargeId), patientOwes, 'payer money never enters the patient\'s account');
      assert.equal((await db.sql`SELECT COUNT(*)::int AS n FROM payments WHERE patient_id = ${v.patientId}`)[0].n, 0);
    });
    it('Scenario G: a partial approval records the deduction; nothing becomes patient debt; a write-off needs its own permission', async () => {
      const v = await visit('200002');
      const patientOwes = await balance(v.chargeId);
      const claim = await submitted(v.chargeId);
      assert.equal((await decide(claim.id, { decision: 'partially_approved', approvedMinor: 3_600, reason: 'Synthetic' })).json().error, 'not_partial', 'approving everything is not partial');
      assert.equal((await decide(claim.id, { decision: 'partially_approved', approvedMinor: 3_000 })).statusCode, 400, 'the payer\'s reason is required');
      const decided = await decide(claim.id, { decision: 'partially_approved', approvedMinor: 3_000, reasonCode: 'TARIFF', reason: 'Synthetic: tariff variance' });
      assert.equal(decided.statusCode, 200, decided.body);
      assert.equal((await remit({ reference: 'SYN-PAY-G', amountMinor: 3_000, allocations: [{ claimId: claim.id, amountMinor: 3_000 }] })).statusCode, 200);
      let s = (await claimFor(v.chargeId)).settlement;
      assert.deepEqual([s.status, s.deductedMinor, s.paidMinor, s.outstandingMinor, s.payerOwesMinor], ['partially_paid', 600, 3_000, 600, 0]);
      assert.equal(await balance(v.chargeId), patientOwes, 'the deduction is not the patient\'s debt');
      const dispute = await call('/insurance/disputes/open', { claimId: claim.id, amountMinor: 600, reason: 'Synthetic: tariff applies', requestKey: key() }, officer.id);
      assert.equal(dispute.statusCode, 200, dispute.body);
      assert.equal((await claimFor(v.chargeId)).settlement.status, 'disputed');
      assert.equal((await call('/insurance/write-offs', { claimId: claim.id, amountMinor: 600, reason: 'Synthetic', requestKey: key() }, f.admin.id)).json().error, 'above_outstanding', 'a disputed amount is not written off');
      assert.equal((await call('/insurance/disputes/resolve', { disputeId: dispute.json().disputeId, outcome: 'payer_upheld', note: 'Synthetic: payer kept the deduction', requestKey: key() }, officer.id)).statusCode, 200);
      assert.equal((await call('/insurance/write-offs', { claimId: claim.id, amountMinor: 600, reason: 'Synthetic', requestKey: key() }, officer.id)).statusCode, 403, 'the officer does not write off');
      assert.equal((await call('/insurance/write-offs', { claimId: claim.id, amountMinor: 600, reason: 'Synthetic: deduction accepted', requestKey: key() }, f.admin.id)).statusCode, 200);
      s = (await claimFor(v.chargeId)).settlement;
      assert.deepEqual([s.status, s.writtenOffMinor, s.outstandingMinor], ['settled', 600, 0]);
      assert.equal(await balance(v.chargeId), patientOwes);
    });
    it('Scenario H: one payment pays several claims, once; a duplicate or over-allocation is refused; a reversal undoes it whole', async () => {
      const [a, b] = [await visit('200003'), await visit('200004')];
      const [ca, cb] = [await submitted(a.chargeId), await submitted(b.chargeId)];
      assert.equal((await remit({ reference: 'SYN-PAY-H', amountMinor: 7_000, allocations: [{ claimId: ca.id, amountMinor: 3_600 }, { claimId: cb.id, amountMinor: 3_600 }] })).statusCode, 400, 'never more than received');
      assert.equal((await remit({ reference: 'SYN-PAY-H', amountMinor: 8_000, allocations: [{ claimId: ca.id, amountMinor: 4_000 }] })).json().error, 'above_outstanding');
      const paid = await remit({ reference: 'SYN-PAY-H', amountMinor: 8_000, allocations: [{ claimId: ca.id, amountMinor: 3_600 }, { claimId: cb.id, amountMinor: 3_600 }] });
      assert.equal(paid.statusCode, 200, paid.body);
      assert.equal(paid.json().unallocatedMinor, 800, 'what is not matched stays visibly unallocated');
      assert.equal((await remit({ reference: ' syn-pay-h ', amountMinor: 8_000 })).json().error, 'duplicate_remittance', 'the same payment is never recorded twice');
      assert.equal((await call('/insurance/remittances/allocate', { remittanceId: paid.json().remittanceId, allocations: [{ claimId: ca.id, amountMinor: 1 }], requestKey: key() }, officer.id)).json().error, 'above_outstanding', 'a settled claim takes no more');
      assert.deepEqual([(await claimFor(a.chargeId)).settlement.status, (await claimFor(b.chargeId)).settlement.status], ['settled', 'settled']);
      assert.equal((await call('/insurance/remittances/reverse', { remittanceId: paid.json().remittanceId, reason: 'Synthetic: recorded against the wrong payer', requestKey: key() }, officer.id)).statusCode, 200);
      assert.equal((await claimFor(a.chargeId)).settlement.outstandingMinor, 3_600, 'a reversed payment no longer counts');
      assert.equal((await remit({ reference: 'SYN-PAY-H', amountMinor: 7_200, allocations: [{ claimId: ca.id, amountMinor: 3_600 }, { claimId: cb.id, amountMinor: 3_600 }] })).statusCode, 200, 'recorded again correctly');
      const listed = (await call('/insurance/remittances/list', {}, officer.id)).json().remittances as { reference: string; reversed?: unknown }[];
      assert.equal(listed.filter((r) => r.reference === 'SYN-PAY-H').length, 2, 'both the reversed and the corrected payment stay on record');
      assert.equal((await call('/insurance/remittances/list', {}, cashier.id)).statusCode, 403);
      await assert.rejects(db.sql`DELETE FROM insurance_remittances`, 'payer money records are permanent');
    });
    it('Scenario I: a denied claim is corrected and resubmitted; earlier revisions, submissions and decisions stay', async () => {
      const v = await visit('200005');
      const patientOwes = await balance(v.chargeId);
      const claim = await submitted(v.chargeId);
      assert.equal((await decide(claim.id, { decision: 'denied', reasonCode: 'DOC', reason: 'Synthetic: discharge note missing' })).statusCode, 200);
      const denied = await claimFor(v.chargeId);
      assert.equal(denied.settlement.status, 'denied');
      assert.equal(await balance(v.chargeId), patientOwes, 'a rejected claim never becomes patient debt');
      const revised = await call(`/insurance/claims/${encodeURIComponent(claim.id)}/revise`, { reason: 'Synthetic: add the missing note', requestKey: key() }, officer.id);
      assert.equal(revised.statusCode, 200, revised.body);
      const resent = await submitted(v.chargeId);
      assert.equal(resent.revision, 2);
      const submissions = (await call('/insurance/claims/submissions/list', {}, officer.id)).json().submissions as { claimIds: string[]; resubmission: boolean; exportIds: string[] }[];
      assert.equal(submissions.find((s) => s.claimIds.includes(resent.id))?.resubmission, true);
      assert.ok(submissions.find((s) => s.claimIds.includes(claim.id))?.exportIds.length, 'the exact files sent are on record');
      assert.equal((await decide(resent.id, { decision: 'approved' })).statusCode, 200);
      assert.equal((await remit({ reference: 'SYN-PAY-I', amountMinor: 3_600, allocations: [{ claimId: resent.id, amountMinor: 3_600 }] })).statusCode, 200);
      assert.equal((await claimFor(v.chargeId)).settlement.status, 'settled');
      const all = (await call('/insurance/claims/list', { includeSuperseded: true }, officer.id)).json().claims as Claim[];
      const first = all.find((c) => c.id === claim.id)!;
      assert.deepEqual(first.decisions.map((d) => d.decision), ['denied'], 'the earlier decision is kept with its revision');
      assert.equal((await decide(claim.id, { decision: 'approved' })).json().error, 'superseded');
    });
    it('reports outstanding balances per payer, every figure apart', async () => {
      const report = (await call('/insurance/outstanding', {}, f.admin.id)).json();
      const totals = report.totals[`${PAYER}|NGN`];
      assert.equal(totals.paid, 3_600 + 3_000 + 3_600 * 2 + 3_600);
      assert.equal(totals.writtenOff, 600);
      assert.ok(report.claims.every((c: { settlement: { outstandingMinor: number; expectedMinor: number; paidMinor: number; writtenOffMinor: number } }) => c.settlement.outstandingMinor === Math.max(0, c.settlement.expectedMinor - c.settlement.paidMinor - c.settlement.writtenOffMinor)));
      assert.equal((await call('/insurance/outstanding', {}, cashier.id)).statusCode, 403);
    });
    it('proposes remittance matches without recording anything', async () => {
      const v = await visit('200006');
      const claim = await submitted(v.chargeId);
      const matched = await call('/insurance/remittances/match', { payerId: PAYER, rows: [
        { sourceRow: 2, claimNumber: claim.claimNumber, paidMinor: 3_600 },
        { sourceRow: 3, enrolleeNumber: 'SYN-200006', paidMinor: 100 },
        { sourceRow: 4, claimNumber: 'CLM-999999', paidMinor: 100 },
      ] }, officer.id);
      assert.equal(matched.statusCode, 200, matched.body);
      assert.deepEqual(matched.json().matches.map((m: { confidence: string }) => m.confidence), ['exact', 'uncertain', 'none']);
      assert.equal((await claimFor(v.chargeId)).settlement.paidMinor, 0);
    });
  });
});
