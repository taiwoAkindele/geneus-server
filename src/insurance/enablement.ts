import { randomUUID } from 'node:crypto';
import { FacilityTimeZone, type Facility, type InsuranceSetupItem, type InsuranceSetupStatus, type InsuranceState } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { activationBlockers } from './contracts.ts';
import { closeBillingPeriod, openBillingPeriod } from './billingPeriods.ts';

/**
 * What a hospital has and still needs. Billing items gate activation; claims
 * items are needed before claims; optional items never block anything.
 */
export const insuranceSetupStatus = async (sql: Sql | Tx, facilityId: string, now = Date.now()): Promise<InsuranceSetupStatus> => {
  const facility = await findRecord<Facility>(sql, 'facility', facilityId);
  if (!facility) throw new Error('Facility not found');
  const [row] = await sql<{ insurance_state: InsuranceState }[]>`SELECT insurance_state FROM facilities WHERE id = ${facilityId}`;
  const count = async (query: Promise<{ n: number }[]>) => (await query)[0].n;
  const [payers, activeContracts, payersWithoutContract, verifiers, documents, unverifiedContracts, profiles] = await Promise.all([
    count(sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM payers WHERE facility_id = ${facilityId} AND active`),
    count(sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM payer_contract_versions WHERE facility_id = ${facilityId} AND status = 'active' AND ended_on IS NULL`),
    count(sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM payers p WHERE p.facility_id = ${facilityId} AND p.active AND NOT EXISTS (SELECT 1 FROM payer_contract_versions v WHERE v.facility_id = p.facility_id AND v.payer_id = p.id AND v.status = 'active' AND v.ended_on IS NULL)`),
    count(sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM staff s JOIN staff_contacts c ON c.facility_id = s.facility_id AND c.staff_id = s.id
      WHERE s.facility_id = ${facilityId} AND s.active AND (s.role = 'insurance_officer' OR s.additional_permissions ? 'coverage:confirm')`),
    count(sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM insurance_documents WHERE facility_id = ${facilityId}`),
    count(sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM payers p WHERE p.facility_id = ${facilityId} AND p.active AND NOT EXISTS (SELECT 1 FROM insurance_documents d WHERE d.facility_id = p.facility_id AND d.payer_id = p.id AND d.document_type = 'contract' AND d.verification = 'verified')`),
    count(sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM payers p WHERE p.facility_id = ${facilityId} AND p.active AND NOT EXISTS (SELECT 1 FROM payer_submission_profiles s WHERE s.facility_id = p.facility_id AND s.payer_id = p.id)`),
  ]);
  // Active devices must run insurance-capable software and be synced. A revoked device never syncs again;
  // losing its unsent work is accepted by name when a contract is activated, not here.
  const devices = (await activationBlockers(sql, facilityId, now)).filter((d) => !d.reasons.includes('revoked_with_unsent_changes'));
  const items: InsuranceSetupItem[] = [
    { kind: 'time_zone_recorded', ok: Boolean(facility.timeZone), requiredFor: 'billing', ...(facility.timeZone ? { detail: facility.timeZone } : {}) },
    { kind: 'payers_added', ok: payers > 0, requiredFor: 'billing', detail: `${payers}` },
    { kind: 'active_contract', ok: activeContracts > 0, requiredFor: 'billing', detail: `${activeContracts} active; ${payersWithoutContract} payer(s) without one` },
    { kind: 'officer_with_verified_email', ok: verifiers > 0, requiredFor: 'billing', detail: `${verifiers}` },
    { kind: 'devices_ready', ok: devices.length === 0, requiredFor: 'billing', detail: devices.length ? `${devices.length} device(s) not ready` : 'all ready' },
    { kind: 'submission_method_per_payer', ok: profiles === 0 && payers > 0, requiredFor: 'claims', detail: `${profiles} payer(s) without one` },
    { kind: 'contract_document_verified', ok: unverifiedContracts === 0 && payers > 0, requiredFor: 'optional', detail: `${documents} document(s); ${unverifiedContracts} payer(s) without a verified contract document` },
  ];
  return { state: row.insurance_state, ...(facility.timeZone ? { timeZone: facility.timeZone } : {}), items };
};

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
 * bill, so it needs no Geneus approval; active is never reachable from here,
 * and an active hospital is only changed by an operator.
 */
export const setInsuranceSetup = async (sql: Sql, input: { facilityId: string; staffId: string; deviceId: string; to: 'off' | 'setup' }) =>
  sql.begin(async (tx) => {
    const [row] = await tx<{ insurance_state: InsuranceState }[]>`SELECT insurance_state FROM facilities WHERE id = ${input.facilityId} FOR UPDATE`;
    if (row.insurance_state === 'active') throw new SetupRefusal('billing_active', 'Insurance billing is active. Only Geneus can change it, so obligations are never left behind');
    if (row.insurance_state === input.to) return row.insurance_state;
    await tx`UPDATE facilities SET insurance_state = ${input.to} WHERE id = ${input.facilityId}`;
    await recordSwitch(tx, input.facilityId, row.insurance_state, input.to, { staffId: input.staffId, deviceId: input.deviceId });
    return input.to;
  });

export type InsuranceSwitch = {
  facilityId: string;
  state: InsuranceState;
  /** Who ran it and the approval it rests on: a deployment decision, never a self-service toggle. */
  operator: string;
  governanceReference: string;
  /** Required for setup or active when the facility has none; must match when it already has one. */
  timeZone?: string;
};

/**
 * A deployment operator's command (scripts/insurance-enable.ts). Moving to
 * active requires every billing readiness item. Leaving active keeps every
 * confirmed split: confirmed obligations stand whatever the state.
 */
export const setInsuranceState = async (sql: Sql, input: InsuranceSwitch): Promise<InsuranceSetupStatus> => {
  if (!input.operator.trim() || !input.governanceReference.trim()) throw new Error('A named operator and an approval reference are required');
  if (input.timeZone) FacilityTimeZone.parse(input.timeZone);
  await sql.begin(async (tx) => {
    const [row] = await tx<{ time_zone: string | null; insurance_state: InsuranceState }[]>`SELECT time_zone, insurance_state FROM facilities WHERE id = ${input.facilityId} FOR UPDATE`;
    if (!row) throw new Error('Facility not found');
    if (input.state !== 'off') {
      if (row.time_zone && input.timeZone && row.time_zone !== input.timeZone) {
        throw new Error(`The facility already records ${row.time_zone}. Changing a time zone redates services; it is a separate reviewed change`);
      }
      if (!row.time_zone && !input.timeZone) throw new Error('Record the facility time zone (for example Africa/Lagos) to enable insurance');
      if (!row.time_zone) await tx`UPDATE facilities SET time_zone = ${input.timeZone!}, updated_by = 'system', updated_on = now() WHERE id = ${input.facilityId}`;
    }
    if (input.state === 'active' && row.insurance_state !== 'active') {
      const missing = (await insuranceSetupStatus(tx, input.facilityId)).items.filter((i) => i.requiredFor === 'billing' && !i.ok);
      if (missing.length) throw new Error(`Insurance billing is not ready: ${missing.map((m) => `${m.kind} (${m.detail ?? 'missing'})`).join('; ')}`);
    }
    if (row.insurance_state !== input.state) await tx`UPDATE facilities SET insurance_state = ${input.state} WHERE id = ${input.facilityId}`;
    // Effective dates: billing applies to charges raised from activation until deactivation, never before or after.
    if (input.state === 'active' && row.insurance_state !== 'active') await openBillingPeriod(tx, input.facilityId, input.operator.trim());
    if (input.state !== 'active' && row.insurance_state === 'active') await closeBillingPeriod(tx, input.facilityId, input.operator.trim());
    await recordSwitch(tx, input.facilityId, row.insurance_state, input.state, { operator: input.operator.trim(), governanceReference: input.governanceReference.trim() });
  });
  return insuranceSetupStatus(sql, input.facilityId);
};
