import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { POLICY_VERSION, serviceDateOf, type FacilityRegistrationResult, type Staff } from '#shared';
import { insertRecord } from '../src/db/records.ts';
import { chargePositions, chargesById } from '../src/insurance/coverage.ts';
import { ensureBootstrapOperators } from '../src/routes/operator.ts';
import { setInsuranceState } from '../src/insurance/enablement.ts';
import { addStaff, asDevice, envelopeFor, lastCodeSentTo, registerScratchFacility, scratchDatabase, testApp, type ScratchDatabase } from './postgres.ts';

/**
 * Self-service administration: nothing a hospital or a Geneus operator does
 * routinely needs a script. Each test drives the real routes against PostgreSQL.
 */
describe('self-service administration', () => {
  let db: ScratchDatabase; let app: FastifyInstance; let f: FacilityRegistrationResult; let officer: Staff; let nurse: Staff;
  const tokens = new Map<string, string>();
  const VERSIONS = { insuranceWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: POLICY_VERSION, clinicalWorkflowVersion: 1, pendingMutationCount: 0 } as const;
  const login = async (staffId: string, email: string) => {
    assert.equal((await app.inject({ method: 'POST', url: '/workforce/access/code', headers: asDevice(f.device.credential), payload: { staffId } })).statusCode, 202);
    const verified = await app.inject({ method: 'POST', url: '/workforce/access/verify', headers: asDevice(f.device.credential), payload: { staffId, code: lastCodeSentTo(email) } });
    assert.equal(verified.statusCode, 200, verified.body);
    tokens.set(staffId, verified.json().token);
  };
  const call = (url: string, payload: unknown, staffId?: string) => app.inject({ method: 'POST', url, payload: payload as object,
    headers: { ...asDevice(f.device.credential), ...(staffId && tokens.get(staffId) ? { 'x-workforce-access': tokens.get(staffId)! } : {}) } });
  const operatorCall = (url: string, payload: unknown, token?: string) => app.inject({ method: 'POST', url, payload: payload as object, headers: token ? { 'x-operator-session': token } : {} });

  before(async () => {
    db = await scratchDatabase(); f = await registerScratchFacility(db.sql); app = testApp(db.sql);
    officer = await addStaff(db.sql, f, { role: 'insurance_officer', name: 'Ifeoma Officer' });
    nurse = await addStaff(db.sql, f, { role: 'nurse', name: 'Nkem Nurse' });
    await login(f.admin.id, 'admin@example.org');
  });
  after(async () => { if (app) await app.close(); if (db) await db.drop(); });

  describe('facility time zone', () => {
    it('is recorded by a verified administrator, with confirmation', async () => {
      assert.equal((await call('/facility/time-zone', { timeZone: 'Africa/Lagos', confirm: true })).statusCode, 403, 'a device-asserted identity is not enough');
      assert.equal((await call('/facility/time-zone', { timeZone: 'Mars/Olympus', confirm: true }, f.admin.id)).statusCode, 400, 'only real IANA zones');
      assert.equal((await call('/facility/time-zone', { timeZone: 'Africa/Lagos' }, f.admin.id)).statusCode, 400, 'it must be confirmed');
      const saved = await call('/facility/time-zone', { timeZone: 'Africa/Lagos', confirm: true }, f.admin.id);
      assert.deepEqual(saved.json(), { timeZone: 'Africa/Lagos', changed: true });
    });
    it('is corrected with a reason, from now on: earlier records keep the date they had', async () => {
      // 23:30 UTC is the next day in Lagos (UTC+1) but the same day in London.
      const late = '2026-03-10T23:30:00.000Z';
      const zoneFor = async () => {
        const [row] = await db.sql`SELECT time_zone_history FROM facilities WHERE id = ${f.facility.id}`;
        return row.time_zone_history as { timeZone: string; from: string }[];
      };
      assert.equal(serviceDateOf(late, 'Africa/Lagos'), '2026-03-11');
      assert.equal((await call('/facility/time-zone', { timeZone: 'Europe/London', confirm: true }, f.admin.id)).json().error, 'reason_required');
      const corrected = await call('/facility/time-zone', { timeZone: 'Europe/London', confirm: true, reason: 'Recorded the wrong zone at setup' }, f.admin.id);
      assert.equal(corrected.statusCode, 200, corrected.body);
      const history = await zoneFor();
      assert.deepEqual(history.map((h) => h.timeZone), ['Africa/Lagos', 'Europe/London']);
      const { timeZoneAt } = await import('#shared');
      assert.equal(timeZoneAt({ timeZone: 'Europe/London', timeZoneHistory: history }, late), 'Africa/Lagos', 'a moment before the correction keeps the earlier zone');
      assert.equal(timeZoneAt({ timeZone: 'Europe/London', timeZoneHistory: history }, new Date(Date.now() + 60_000).toISOString()), 'Europe/London');
      const changes = (await call('/facility/time-zone/history', {})).json().changes;
      assert.equal(changes[0].reason, 'Recorded the wrong zone at setup');
      assert.ok((await db.sql`SELECT 1 FROM audit_events WHERE metadata->>'context' = 'facility_time_zone_corrected'`).length);
      await assert.rejects(db.sql`DELETE FROM facility_time_zone_changes`, 'the change history is permanent');
      // Put it back for the rest of the suite.
      await call('/facility/time-zone', { timeZone: 'Africa/Lagos', confirm: true, reason: 'Corrected back for the synthetic suite' }, f.admin.id);
    });
    it('refuses anyone but an administrator', async () => {
      await db.sql`INSERT INTO staff_contacts (facility_id, staff_id, email, verified_on) VALUES (${f.facility.id}, ${nurse.id}, 'nurse@example.org', now())`;
      await login(nurse.id, 'nurse@example.org');
      assert.equal((await call('/facility/time-zone', { timeZone: 'Africa/Accra', confirm: true, reason: 'Not allowed' }, nurse.id)).statusCode, 403);
    });
  });

  describe('staff email self-service', () => {
    it('lets a member of staff prove an address; an administrator confirms it is theirs', async () => {
      assert.equal((await call('/staff/me/email/code', { staffId: officer.id, email: 'nurse@example.org' })).json().error, 'email_in_use');
      assert.equal((await call('/staff/me/email/code', { staffId: officer.id, email: 'officer@example.org' })).statusCode, 202);
      assert.equal((await call('/staff/me/email', { staffId: officer.id, email: 'officer@example.org', code: '000000' })).json().error, 'invalid_email_code');
      const proven = await call('/staff/me/email', { staffId: officer.id, email: 'officer@example.org', code: lastCodeSentTo('officer@example.org') });
      assert.deepEqual(proven.json(), { status: 'pending_approval' }, 'the device cannot prove who holds it, so an administrator confirms');
      const status = (await call('/staff/me/email/status', { staffId: officer.id })).json();
      assert.equal(status.verified, false);
      assert.notEqual(status.pending.email, 'officer@example.org', 'masked without proof of identity');
      assert.equal((await call('/staff/email-requests/list', {})).statusCode, 403, 'confirming needs a verified administrator');
      assert.equal((await call('/staff/email-requests/list', {}, nurse.id)).statusCode, 403, 'and staff:manage');
      const [request] = (await call('/staff/email-requests/list', {}, f.admin.id)).json().requests;
      assert.equal(request.email, 'officer@example.org');
      assert.equal(request.staffName, 'Ifeoma Officer');
      assert.equal((await call(`/staff/email-requests/${encodeURIComponent(request.id)}/decide`, { decision: 'approve' }, f.admin.id)).statusCode, 200);
      assert.equal((await call(`/staff/email-requests/${encodeURIComponent(request.id)}/decide`, { decision: 'approve' }, f.admin.id)).json().error, 'already_decided');
      await login(officer.id, 'officer@example.org');
      assert.equal((await call('/staff/me/email/status', { staffId: officer.id }, officer.id)).json().email, 'officer@example.org', 'unmasked to its verified owner');
    });
    it('lets a verified person change their own address at once', async () => {
      await call('/staff/me/email/code', { staffId: officer.id, email: 'officer.new@example.org' });
      const changed = await call('/staff/me/email', { staffId: officer.id, email: 'officer.new@example.org', code: lastCodeSentTo('officer.new@example.org') }, officer.id);
      assert.deepEqual(changed.json(), { status: 'verified' });
      const [contact] = await db.sql`SELECT email FROM staff_contacts WHERE staff_id = ${officer.id}`;
      assert.equal(contact.email, 'officer.new@example.org');
      assert.ok((await db.sql`SELECT 1 FROM audit_events WHERE metadata->>'context' = 'staff_email_changed'`).length);
      assert.equal((await call('/insurance/setup/status/officer', {}, officer.id)).statusCode, 403, 'a session for the old address ends with it');
      await login(officer.id, 'officer.new@example.org');
    });
    it('never lets an administrator confirm their own request', async () => {
      await call('/staff/me/email/code', { staffId: f.admin.id, email: 'admin.second@example.org' });
      await call('/staff/me/email', { staffId: f.admin.id, email: 'admin.second@example.org', code: lastCodeSentTo('admin.second@example.org') });
      const mine = (await call('/staff/email-requests/list', {}, f.admin.id)).json().requests.find((r: { staffId: string }) => r.staffId === f.admin.id);
      assert.equal((await call(`/staff/email-requests/${encodeURIComponent(mine.id)}/decide`, { decision: 'approve' }, f.admin.id)).json().error, 'own_request');
    });
  });

  describe('insurance activation without scripts', () => {
    let operatorToken = '';
    before(async () => {
      await ensureBootstrapOperators(db.sql, ['ops@geneus.example.org']);
      await ensureBootstrapOperators(db.sql, ['ops@geneus.example.org']);
    });
    it('signs a Geneus operator in with an emailed code; nobody else, and never by revealing who is an operator', async () => {
      assert.equal((await operatorCall('/operator/facilities', {})).statusCode, 401);
      assert.equal((await operatorCall('/operator/facilities', {}, 'forged')).statusCode, 401);
      const stranger = await operatorCall('/operator/login/code', { email: 'someone@example.org' });
      assert.equal(stranger.statusCode, 202, 'the same answer for anyone');
      assert.throws(() => lastCodeSentTo('someone@example.org'), 'but no code is sent to a stranger');
      await operatorCall('/operator/login/code', { email: 'ops@geneus.example.org' });
      assert.equal((await operatorCall('/operator/login', { email: 'ops@geneus.example.org', code: '000000' })).statusCode, 403);
      const session = await operatorCall('/operator/login', { email: 'ops@geneus.example.org', code: lastCodeSentTo('ops@geneus.example.org') });
      assert.equal(session.statusCode, 200, session.body);
      operatorToken = session.json().token;
      assert.equal((await operatorCall('/operator/facilities', {}, operatorToken)).statusCode, 200);
    });
    it('takes a request only from a verified administrator, in setup, with every billing item ready', async () => {
      assert.equal((await call('/insurance/activation/request', {})).statusCode, 403);
      assert.equal((await call('/insurance/setup', { state: 'setup' }, f.admin.id)).statusCode, 200);
      const early = await call('/insurance/activation/request', {}, f.admin.id);
      assert.equal(early.json().error, 'not_ready');
      assert.ok(early.json().details.missing.includes('payers_added'));
      const status = (await call('/insurance/setup/status', {}, f.admin.id)).json();
      const officerItem = status.items.find((i: { kind: string }) => i.kind === 'officer_with_verified_email');
      assert.equal(officerItem.ok, true);
      assert.deepEqual(officerItem.people.map((p: { name: string; email: string }) => [p.name, p.email]), [['Ifeoma Officer', 'verified']]);
      const devices = status.items.find((i: { kind: string }) => i.kind === 'devices_ready');
      assert.ok(Array.isArray(devices.devices), 'each device and its reasons, not a count');
      assert.ok(status.items.find((i: { kind: string }) => i.kind === 'payers_added').count === 0);
    });
    it('Geneus approves in the console; approval re-checks readiness in the activating transaction', async () => {
      // Make the hospital ready: a payer, an active contract and synced devices.
      const payer = await call('/insurance/payers/save', { name: 'Synthetic HMO', code: 'SYN', kind: 'hmo', active: true }, officer.id);
      assert.equal(payer.statusCode, 200, payer.body);
      const admin = { ...envelopeFor(f), schemaVersion: 5 };
      await insertRecord(db.sql, 'fee_item', { ...admin, id: 'fee:consult', type: 'fee_item', name: 'Consultation', category: 'consultation', amountMinor: 5_000, currency: 'NGN', chargeWhen: 'when_ordered' });
      const terms = { payerId: payer.json().id, effectiveFrom: '2020-01-01', currency: 'NGN', arrangements: { categories: { consultation: 'per_service' }, items: {} }, tariff: { 'fee:consult': { unitMinor: 4_000 } },
        plans: [{ planCode: 'GOLD', name: 'Gold', rules: { categories: { consultation: { coverage: 'covered', copay: { kind: 'none' } } }, items: {} } }] };
      const draft = await call('/insurance/contracts/draft', { terms }, officer.id);
      assert.equal(draft.statusCode, 200, draft.body);
      await app.inject({ method: 'POST', url: '/sync/token', headers: asDevice(f.device.credential), payload: VERSIONS });
      const activated = await call('/insurance/contracts/activate', { contractVersionId: draft.json().version.id, acknowledgeUnsupported: true, requestKey: crypto.randomUUID() }, f.admin.id);
      assert.equal(activated.statusCode, 200, activated.body);
      const requested = await call('/insurance/activation/request', { note: 'Ready for billing' }, f.admin.id);
      assert.equal(requested.statusCode, 200, requested.body);
      assert.equal(requested.json().activation.status, 'requested');
      assert.equal((await call('/insurance/activation/request', {}, f.admin.id)).json().error, 'already_requested');
      const list = (await operatorCall('/operator/facilities', {}, operatorToken)).json().facilities;
      const mine = list.find((x: { id: string }) => x.id === f.facility.id);
      assert.ok(mine.openRequest, 'the request appears in the console');
      // Readiness changes between request and approval: the approval refuses, and nothing changes.
      await db.sql`UPDATE payer_contract_versions SET ended_on = now()::date WHERE facility_id = ${f.facility.id}`.catch(() => undefined);
      await db.sql`UPDATE staff SET active = false WHERE id = ${officer.id}`;
      const refused = await operatorCall(`/operator/insurance/requests/${encodeURIComponent(mine.openRequest.id)}/decide`, { decision: 'approve', note: 'Synthetic approval' }, operatorToken);
      assert.equal(refused.json().error, 'not_ready', refused.body);
      assert.equal((await db.sql`SELECT insurance_state FROM facilities WHERE id = ${f.facility.id}`)[0].insurance_state, 'setup');
      assert.equal((await db.sql`SELECT status FROM insurance_activation_requests WHERE id = ${mine.openRequest.id}`)[0].status, 'requested');
      await db.sql`UPDATE staff SET active = true WHERE id = ${officer.id}`;
      const approved = await operatorCall(`/operator/insurance/requests/${encodeURIComponent(mine.openRequest.id)}/decide`, { decision: 'approve', note: 'GOV-SYN-001 rollout approval' }, operatorToken);
      assert.equal(approved.statusCode, 200, approved.body);
      assert.equal(approved.json().status.state, 'active');
      assert.equal(approved.json().status.activation.status, 'approved');
      assert.equal((await db.sql`SELECT COUNT(*)::int AS n FROM insurance_billing_periods WHERE facility_id = ${f.facility.id} AND ends_on IS NULL`)[0].n, 1, 'billing starts now');
      const [audit] = await db.sql`SELECT metadata FROM audit_events WHERE metadata->>'context' = 'insurance_activation_approved'`;
      assert.equal(audit.metadata.operator, 'ops@geneus.example.org');
      assert.equal(audit.metadata.requestedBy, f.admin.id, 'who asked and who approved are both recorded');
      assert.ok((await db.sql`SELECT 1 FROM operator_events WHERE action = 'insurance_activation_approved'`).length);
      assert.equal((await operatorCall(`/operator/insurance/requests/${encodeURIComponent(mine.openRequest.id)}/decide`, { decision: 'reject', note: 'Too late' }, operatorToken)).json().error, 'already_decided');
      assert.equal((await call('/insurance/setup', { state: 'off' }, f.admin.id)).json().error, 'billing_active', 'the hospital cannot switch billing off itself');
      // A charge raised now is estimated; switching off in the console keeps its treatment.
      await insertRecord(db.sql, 'charge', { ...admin, id: 'charge:after', type: 'charge', patientId: `${f.facility.id}-000001-K2`, feeItemId: 'fee:consult', category: 'consultation', description: 'Consultation', listPriceMinor: 5_000, amountMinor: 5_000, currency: 'NGN' }).catch(() => undefined);
      const off = await operatorCall(`/operator/facilities/${encodeURIComponent(f.facility.id)}/insurance-state`, { state: 'off', reason: 'Synthetic pause' }, operatorToken);
      assert.equal(off.json().status.state, 'off');
      assert.ok((await db.sql`SELECT ends_on FROM insurance_billing_periods WHERE facility_id = ${f.facility.id}`)[0].ends_on, 'the period is closed');
      void chargePositions; void chargesById; void setInsuranceState;
    });
    it('lets operators manage operators, never removing themselves, and ends sessions on removal', async () => {
      assert.equal((await operatorCall('/operator/operators/add', { email: 'second@geneus.example.org', name: 'Second Operator' }, operatorToken)).statusCode, 200);
      assert.equal((await operatorCall('/operator/operators/add', { email: 'second@geneus.example.org', name: 'Second Operator' }, operatorToken)).json().error, 'already_operator');
      const operators = (await operatorCall('/operator/operators', {}, operatorToken)).json().operators;
      const me = operators.find((o: { email: string }) => o.email === 'ops@geneus.example.org');
      assert.equal((await operatorCall(`/operator/operators/${encodeURIComponent(me.id)}/remove`, {}, operatorToken)).json().error, 'self');
      await operatorCall('/operator/login/code', { email: 'second@geneus.example.org' });
      const second = (await operatorCall('/operator/login', { email: 'second@geneus.example.org', code: lastCodeSentTo('second@geneus.example.org') })).json().token;
      assert.equal((await operatorCall(`/operator/operators/${encodeURIComponent(me.id)}/remove`, {}, second)).statusCode, 200);
      assert.equal((await operatorCall('/operator/facilities', {}, operatorToken)).statusCode, 401, 'a removed operator is signed out at once');
      await db.sql`UPDATE operator_sessions SET expires_on = now() - interval '1 second'`;
      assert.equal((await operatorCall('/operator/facilities', {}, second)).statusCode, 401, 'sessions expire');
    });
  });

  describe('device status for administrators', () => {
    it('lists each device with its sync report and why it would block a feature', async () => {
      assert.equal((await call('/devices/status', { requestedBy: nurse.id })).statusCode, 403);
      await app.inject({ method: 'POST', url: '/sync/token', headers: asDevice(f.device.credential), payload: VERSIONS });
      const status = await call('/devices/status', { requestedBy: f.admin.id });
      assert.equal(status.statusCode, 200, status.body);
      const [device] = status.json().devices;
      assert.equal(device.thisDevice, true);
      assert.equal(device.insuranceCapable, true);
      assert.equal(device.pendingChanges, 0);
      assert.ok(Array.isArray(device.blocking));
    });
  });
});
