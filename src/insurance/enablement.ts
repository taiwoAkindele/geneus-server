import { randomUUID } from 'node:crypto';
import { FacilityTimeZone, type Facility, type InsuranceActivationRequest, type InsuranceSetupItem, type InsuranceSetupStatus, type InsuranceState, type SetupPerson } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { activationBlockers } from './contracts.ts';
import { closeBillingPeriod, openBillingPeriod } from './billingPeriods.ts';
import { recordFacilityTimeZone } from '../facility/timeZone.ts';

type Row = Record<string, unknown>;

export const activationRequestRow = (r: Row): InsuranceActivationRequest => ({
  id: r.id as string, facilityId: r.facility_id as string, status: r.status as InsuranceActivationRequest['status'], ...(r.note ? { note: r.note as string } : {}),
  requestedBy: r.requested_by as string, ...(r.requested_by_name ? { requestedByName: r.requested_by_name as string } : {}), requestedOn: new Date(r.requested_on as string).toISOString(),
  ...(r.decided_by ? { decidedBy: r.decided_by as string } : {}), ...(r.decided_on ? { decidedOn: new Date(r.decided_on as string).toISOString() } : {}), ...(r.decision_note ? { decisionNote: r.decision_note as string } : {}),
});

export const latestActivationRequest = async (sql: Sql | Tx, facilityId: string): Promise<InsuranceActivationRequest | undefined> => {
  const [row] = await sql<Row[]>`SELECT r.*, s.full_name AS requested_by_name FROM insurance_activation_requests r LEFT JOIN staff s ON s.facility_id = r.facility_id AND s.id = r.requested_by
    WHERE r.facility_id = ${facilityId} ORDER BY r.requested_on DESC LIMIT 1`;
  return row ? activationRequestRow(row) : undefined;
};

/**
 * What a hospital has and still needs, as facts the screen can explain and act
 * on: which payers lack a contract, which officers have no verified email,
 * which devices are not ready and why. Billing items gate activation; claims
 * items are needed before claims; optional items never block anything.
 */
export const insuranceSetupStatus = async (sql: Sql | Tx, facilityId: string, now = Date.now()): Promise<InsuranceSetupStatus> => {
  const facility = await findRecord<Facility>(sql, 'facility', facilityId);
  if (!facility) throw new Error('Facility not found');
  const [row] = await sql<{ insurance_state: InsuranceState }[]>`SELECT insurance_state FROM facilities WHERE id = ${facilityId}`;
  const payers = await sql<{ id: string; name: string; contract: boolean; profile: boolean; document: boolean }[]>`
    SELECT p.id, p.name,
      EXISTS (SELECT 1 FROM payer_contract_versions v WHERE v.facility_id = p.facility_id AND v.payer_id = p.id AND v.status = 'active' AND v.ended_on IS NULL) AS contract,
      EXISTS (SELECT 1 FROM payer_submission_profiles s WHERE s.facility_id = p.facility_id AND s.payer_id = p.id) AS profile,
      EXISTS (SELECT 1 FROM insurance_documents d WHERE d.facility_id = p.facility_id AND d.payer_id = p.id AND d.document_type = 'contract' AND d.verification = 'verified') AS document
    FROM payers p WHERE p.facility_id = ${facilityId} AND p.active ORDER BY p.name`;
  const [{ n: activeContracts }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM payer_contract_versions WHERE facility_id = ${facilityId} AND status = 'active' AND ended_on IS NULL`;
  const officers = await sql<{ id: string; full_name: string; verified: boolean; pending: boolean }[]>`
    SELECT s.id, s.full_name, EXISTS (SELECT 1 FROM staff_contacts c WHERE c.facility_id = s.facility_id AND c.staff_id = s.id) AS verified,
      EXISTS (SELECT 1 FROM staff_email_requests r WHERE r.facility_id = s.facility_id AND r.staff_id = s.id AND r.status = 'pending') AS pending
    FROM staff s WHERE s.facility_id = ${facilityId} AND s.active
      AND (s.role = 'insurance_officer' OR s.additional_roles ? 'insurance_officer' OR s.additional_permissions ? 'coverage:confirm') ORDER BY s.full_name`;
  const people: SetupPerson[] = officers.map((o) => ({ staffId: o.id, name: o.full_name, email: o.verified ? 'verified' : o.pending ? 'pending' : 'none' }));
  // A revoked device never syncs again; losing its unsent work is accepted by name when a contract is activated, not here.
  const devices = (await activationBlockers(sql, facilityId, now)).filter((d) => !d.reasons.includes('revoked_with_unsent_changes'));
  const missing = (key: 'contract' | 'profile' | 'document') => payers.filter((p) => !p[key]).map((p) => ({ id: p.id, name: p.name }));
  const items: InsuranceSetupItem[] = [
    { kind: 'time_zone_recorded', ok: Boolean(facility.timeZone), requiredFor: 'billing', ...(facility.timeZone ? { timeZone: facility.timeZone } : {}) },
    { kind: 'payers_added', ok: payers.length > 0, requiredFor: 'billing', count: payers.length },
    { kind: 'active_contract', ok: activeContracts > 0, requiredFor: 'billing', count: activeContracts, payers: missing('contract') },
    { kind: 'officer_with_verified_email', ok: people.some((p) => p.email === 'verified'), requiredFor: 'billing', count: people.filter((p) => p.email === 'verified').length, people },
    { kind: 'devices_ready', ok: devices.length === 0, requiredFor: 'billing', devices: devices.map(({ revokedOn: _revoked, ...d }) => d) },
    { kind: 'submission_method_per_payer', ok: payers.length > 0 && missing('profile').length === 0, requiredFor: 'claims', payers: missing('profile') },
    { kind: 'contract_document_verified', ok: payers.length > 0 && missing('document').length === 0, requiredFor: 'optional', payers: missing('document') },
  ];
  const activation = await latestActivationRequest(sql, facilityId);
  return { state: row.insurance_state, ...(facility.timeZone ? { timeZone: facility.timeZone } : {}), items, ...(activation ? { activation } : {}) };
};

export const billingBlockers = (status: InsuranceSetupStatus) => status.items.filter((i) => i.requiredFor === 'billing' && !i.ok);

export class SetupRefusal extends Error {
  readonly code: string; readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) { super(message); this.name = 'SetupRefusal'; this.code = code; this.details = details; }
}

const recordSwitch = async (tx: Tx, facilityId: string, from: InsuranceState, to: InsuranceState, actor: { staffId?: string; deviceId?: string; operator?: string; governanceReference?: string }) => {
  const [device] = actor.deviceId ? [{ id: actor.deviceId }] : await tx<{ id: string }[]>`SELECT id FROM devices WHERE facility_id = ${facilityId} ORDER BY enrolled_on LIMIT 1`;
  if (actor.operator) {
    await tx`INSERT INTO insurance_operator_commands (id, facility_id, enabled, state, time_zone, operator, governance_reference)
      VALUES (${`insurance_switch:${randomUUID()}`}, ${facilityId}, ${to === 'active'}, ${to}, ${(await findRecord<Facility>(tx, 'facility', facilityId))?.timeZone ?? null}, ${actor.operator}, ${actor.governanceReference!})`;
  }
  if (device) await recordAuditEvent(tx, {
    facilityId, deviceId: device.id, ...(actor.staffId ? { actorStaffId: actor.staffId } : {}), action: 'update', entityType: 'facility', entityId: facilityId,
    metadata: { context: 'insurance_state', from, to, ...(actor.operator ? { operator: actor.operator, governanceReference: actor.governanceReference! } : {}) },
  });
};

/**
 * A hospital administrator moves between off and setup. Setup changes no
 * bill, so it needs no Geneus approval; active is reached only through an
 * approved activation request, and an active hospital is changed only by Geneus.
 */
export const setInsuranceSetup = async (sql: Sql, input: { facilityId: string; staffId: string; deviceId: string; to: 'off' | 'setup' }) =>
  sql.begin(async (tx) => {
    const [row] = await tx<{ insurance_state: InsuranceState }[]>`SELECT insurance_state FROM facilities WHERE id = ${input.facilityId} FOR UPDATE`;
    if (row.insurance_state === 'active') throw new SetupRefusal('billing_active', 'Insurance billing is active. Only Geneus can change it, so obligations are never left behind');
    if (row.insurance_state === input.to) return row.insurance_state;
    await tx`UPDATE facilities SET insurance_state = ${input.to} WHERE id = ${input.facilityId}`;
    // Leaving setup withdraws an open activation request: there is nothing left to activate.
    if (input.to === 'off') await tx`UPDATE insurance_activation_requests SET status = 'withdrawn', decided_by = ${input.staffId}, decided_on = now() WHERE facility_id = ${input.facilityId} AND status = 'requested'`;
    await recordSwitch(tx, input.facilityId, row.insurance_state, input.to, { staffId: input.staffId, deviceId: input.deviceId });
    return input.to;
  });

export type InsuranceSwitch = {
  facilityId: string;
  state: InsuranceState;
  /** Who did it and the approval it rests on: a Geneus decision, never a hospital toggle. */
  operator: string;
  governanceReference: string;
  /** Recorded when the facility has none; must match when it already has one. */
  timeZone?: string;
};

/**
 * A Geneus decision, inside the caller's transaction. Moving to active
 * requires every billing readiness item, checked here and now; leaving active
 * keeps every confirmed split and the insurance treatment of charges raised
 * while billing was on.
 */
export const applyInsuranceState = async (tx: Tx, input: InsuranceSwitch) => {
  if (!input.operator.trim() || !input.governanceReference.trim()) throw new Error('A named operator and an approval reference are required');
  if (input.timeZone) FacilityTimeZone.parse(input.timeZone);
  const [row] = await tx<{ time_zone: string | null; insurance_state: InsuranceState }[]>`SELECT time_zone, insurance_state FROM facilities WHERE id = ${input.facilityId} FOR UPDATE`;
  if (!row) throw new Error('Facility not found');
  if (input.state !== 'off') {
    if (row.time_zone && input.timeZone && row.time_zone !== input.timeZone) {
      throw new SetupRefusal('time_zone_differs', `The facility already records ${row.time_zone}. A hospital administrator corrects a time zone in Facility settings`);
    }
    if (!row.time_zone && !input.timeZone) throw new SetupRefusal('time_zone_required', 'The facility time zone is not recorded. A hospital administrator records it in Facility settings');
    if (!row.time_zone) await recordFacilityTimeZone(tx, { facilityId: input.facilityId, timeZone: input.timeZone!, by: `operator:${input.operator.trim()}` });
  }
  if (input.state === 'active' && row.insurance_state !== 'active') {
    const missing = billingBlockers(await insuranceSetupStatus(tx, input.facilityId));
    if (missing.length) throw new SetupRefusal('not_ready', `Insurance billing is not ready: ${missing.map((m) => m.kind).join(', ')}`, { missing: missing.map((m) => m.kind) });
  }
  if (row.insurance_state !== input.state) await tx`UPDATE facilities SET insurance_state = ${input.state} WHERE id = ${input.facilityId}`;
  // Effective dates: billing applies to charges raised from activation until deactivation, never before or after.
  if (input.state === 'active' && row.insurance_state !== 'active') await openBillingPeriod(tx, input.facilityId, input.operator.trim());
  if (input.state !== 'active' && row.insurance_state === 'active') await closeBillingPeriod(tx, input.facilityId, input.operator.trim());
  await recordSwitch(tx, input.facilityId, row.insurance_state, input.state, { operator: input.operator.trim(), governanceReference: input.governanceReference.trim() });
};

/** For tests and the engineering break-glass script; Geneus operators use the operator console. */
export const setInsuranceState = async (sql: Sql, input: InsuranceSwitch): Promise<InsuranceSetupStatus> => {
  await sql.begin((tx) => applyInsuranceState(tx, input));
  return insuranceSetupStatus(sql, input.facilityId);
};

/** A hospital administrator asks Geneus to switch billing on. Only possible in setup with every billing item ready. */
export const requestActivation = async (tx: Tx, input: { facilityId: string; staffId: string; deviceId: string; note?: string }) => {
  const [row] = await tx<{ insurance_state: InsuranceState }[]>`SELECT insurance_state FROM facilities WHERE id = ${input.facilityId} FOR UPDATE`;
  if (row.insurance_state !== 'setup') throw new SetupRefusal('not_in_setup', row.insurance_state === 'active' ? 'Insurance billing is already active' : 'Start insurance setup first');
  const [open] = await tx`SELECT 1 FROM insurance_activation_requests WHERE facility_id = ${input.facilityId} AND status = 'requested'`;
  if (open) throw new SetupRefusal('already_requested', 'Activation was already requested. Geneus will review it');
  const missing = billingBlockers(await insuranceSetupStatus(tx, input.facilityId));
  if (missing.length) throw new SetupRefusal('not_ready', 'Complete every item needed before billing first', { missing: missing.map((m) => m.kind) });
  const id = `insurance_activation:${randomUUID()}`;
  await tx`INSERT INTO insurance_activation_requests (id, facility_id, note, requested_by, requested_from) VALUES (${id}, ${input.facilityId}, ${input.note ?? null}, ${input.staffId}, ${input.deviceId})`;
  await recordAuditEvent(tx, { facilityId: input.facilityId, deviceId: input.deviceId, actorStaffId: input.staffId, action: 'create', entityType: 'facility', entityId: input.facilityId, metadata: { context: 'insurance_activation_requested', requestId: id } });
  return id;
};

export const withdrawActivation = async (tx: Tx, input: { facilityId: string; staffId: string; deviceId: string }) => {
  const updated = await tx`UPDATE insurance_activation_requests SET status = 'withdrawn', decided_by = ${input.staffId}, decided_on = now() WHERE facility_id = ${input.facilityId} AND status = 'requested' RETURNING id`;
  if (!updated.length) throw new SetupRefusal('no_open_request', 'There is no open activation request');
  await recordAuditEvent(tx, { facilityId: input.facilityId, deviceId: input.deviceId, actorStaffId: input.staffId, action: 'update', entityType: 'facility', entityId: input.facilityId, metadata: { context: 'insurance_activation_withdrawn', requestId: updated[0].id as string } });
};

/**
 * Geneus decides a request. Approval and activation are one transaction: the
 * request must still be open and every billing item must pass at this moment,
 * or nothing changes. Recorded as who requested, who approved, and the switch.
 */
export const decideActivation = async (tx: Tx, input: { requestId: string; operator: { id: string; name: string; email: string }; decision: 'approve' | 'reject'; note: string }) => {
  const [request] = await tx<Row[]>`SELECT * FROM insurance_activation_requests WHERE id = ${input.requestId} FOR UPDATE`;
  if (!request) throw new SetupRefusal('not_found', 'No such request');
  if (request.status !== 'requested') throw new SetupRefusal('already_decided', `This request was already ${request.status as string}`);
  if (input.decision === 'approve') {
    await applyInsuranceState(tx, { facilityId: request.facility_id as string, state: 'active', operator: `${input.operator.name} <${input.operator.email}>`, governanceReference: `${input.requestId}: ${input.note}` });
  }
  await tx`UPDATE insurance_activation_requests SET status = ${input.decision === 'approve' ? 'approved' : 'rejected'}, decided_by = ${`operator:${input.operator.id}`}, decided_on = now(), decision_note = ${input.note} WHERE id = ${input.requestId}`;
  const [device] = await tx<{ id: string }[]>`SELECT id FROM devices WHERE facility_id = ${request.facility_id as string} AND id = ${request.requested_from as string}`;
  if (device) await recordAuditEvent(tx, { facilityId: request.facility_id as string, deviceId: device.id, action: 'update', entityType: 'facility', entityId: request.facility_id as string,
    metadata: { context: input.decision === 'approve' ? 'insurance_activation_approved' : 'insurance_activation_rejected', requestId: input.requestId, operator: input.operator.email, requestedBy: request.requested_by as string } });
  return request.facility_id as string;
};
