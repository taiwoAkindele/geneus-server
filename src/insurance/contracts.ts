import {
  CALCULATION_VERSION, CoverSchedule, PayerContractTerms, PayerContractVersion, SCHEMA_VERSION, buildScheduleLines, contractIdFor,
  contractVersionId, insuranceConfigurable, serviceDateOf, unsupportedArrangements, type FeeCategory, type InsuranceState,
} from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { insertRecord } from '../db/records.ts';
import { facilityTimeZone } from './coverage.ts';

type Row = Record<string, unknown>;

export const fromContractRow = (row: Row): PayerContractVersion => PayerContractVersion.parse({
  id: row.id, facilityId: row.facility_id, contractId: row.contract_id, version: row.version, status: row.status,
  terms: row.terms, revision: row.revision, createdBy: row.created_by, createdOn: row.created_on,
  updatedBy: row.updated_by ?? undefined, updatedOn: row.updated_on ?? undefined,
  activatedBy: row.activated_by ?? undefined, activatedOn: row.activated_on ?? undefined,
  endedOn: row.ended_on ?? undefined, endedBy: row.ended_by ?? undefined, endReason: row.end_reason ?? undefined,
});

export const contractVersions = async (sql: Sql | Tx, facilityId: string): Promise<PayerContractVersion[]> =>
  (await sql<Row[]>`SELECT * FROM payer_contract_versions WHERE facility_id = ${facilityId} ORDER BY contract_id, version`).map(fromContractRow);

export const findContractVersion = async (sql: Sql | Tx, facilityId: string, id: string, lock = false): Promise<PayerContractVersion | undefined> => {
  const [row] = lock
    ? await sql<Row[]>`SELECT * FROM payer_contract_versions WHERE facility_id = ${facilityId} AND id = ${id} FOR UPDATE`
    : await sql<Row[]>`SELECT * FROM payer_contract_versions WHERE facility_id = ${facilityId} AND id = ${id}`;
  return row ? fromContractRow(row) : undefined;
};

export class ContractRefusal extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) { super(message); this.name = 'ContractRefusal'; this.code = code; this.details = details; }
}

/**
 * The hospital's insurance state: off, setup (configure without touching bills)
 * or active (cover applies to bills; set only by an operator after readiness).
 */
export const insuranceState = async (sql: Sql | Tx, facilityId: string): Promise<InsuranceState> =>
  ((await sql<{ insurance_state: InsuranceState }[]>`SELECT insurance_state FROM facilities WHERE id = ${facilityId}`)[0]?.insurance_state) ?? 'off';
export const insuranceBillingActive = async (sql: Sql | Tx, facilityId: string) => (await insuranceState(sql, facilityId)) === 'active';

/** Fee items the terms name, with their categories; an unknown fee item is refused, never guessed. */
const feeCategories = async (tx: Tx, facilityId: string, terms: PayerContractTerms): Promise<Map<string, FeeCategory>> => {
  const named = [...new Set([...Object.keys(terms.tariff), ...Object.keys(terms.arrangements.items), ...terms.plans.flatMap((p) => Object.keys(p.rules.items))])];
  const rows = named.length ? await tx<{ id: string; category: FeeCategory }[]>`SELECT id, category FROM fee_items WHERE facility_id = ${facilityId} AND id = ANY(${named})` : [];
  const categories = new Map(rows.map((r) => [r.id, r.category]));
  const unknown = named.filter((id) => !categories.has(id));
  if (unknown.length) throw new ContractRefusal('unknown_fee_items', 'The contract names fee items this hospital does not have', { feeItemIds: unknown });
  return categories;
};

/**
 * Saves the payer's one open draft: edits it when the caller saw its current
 * revision, or starts the next version. Active versions are never touched.
 */
export const saveDraft = async (tx: Tx, facilityId: string, staffId: string, input: { terms: unknown; expectedRevision?: number }) => {
  const parsed = PayerContractTerms.safeParse(input.terms);
  if (!parsed.success) throw new ContractRefusal('invalid_terms', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const terms = parsed.data;
  await tx`SELECT id FROM facilities WHERE id = ${facilityId} FOR UPDATE`;
  const [payer] = await tx`SELECT id FROM payers WHERE facility_id = ${facilityId} AND id = ${terms.payerId}`;
  if (!payer) throw new ContractRefusal('unknown_payer', 'Choose a payer of this hospital');
  await feeCategories(tx, facilityId, terms);
  const contractId = contractIdFor(terms.payerId);
  const now = new Date().toISOString();
  const [draft] = await tx<Row[]>`SELECT * FROM payer_contract_versions WHERE facility_id = ${facilityId} AND contract_id = ${contractId} AND status = 'draft' FOR UPDATE`;
  if (draft) {
    if (input.expectedRevision !== draft.revision) throw new ContractRefusal('stale_draft', 'This draft changed since you opened it. Review the current draft before saving');
    await tx`UPDATE payer_contract_versions SET terms = ${tx.json(terms as never)}, revision = revision + 1, updated_by = ${staffId}, updated_on = ${now} WHERE id = ${draft.id as string}`;
  } else {
    if (input.expectedRevision !== undefined) throw new ContractRefusal('stale_draft', 'This draft was activated or replaced. Start from the current version');
    const [{ next }] = await tx<{ next: number }[]>`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM payer_contract_versions WHERE facility_id = ${facilityId} AND contract_id = ${contractId}`;
    await tx`INSERT INTO payer_contract_versions (id, facility_id, contract_id, payer_id, version, status, terms, revision, created_by, created_on)
      VALUES (${contractVersionId(contractId, next)}, ${facilityId}, ${contractId}, ${terms.payerId}, ${next}, 'draft', ${tx.json(terms as never)}, 1, ${staffId}, ${now})`;
  }
  const [saved] = await tx<Row[]>`SELECT * FROM payer_contract_versions WHERE facility_id = ${facilityId} AND contract_id = ${contractId} AND status = 'draft'`;
  return { version: fromContractRow(saved), unsupported: unsupportedArrangements(terms) };
};

export type DeviceBlocker = {
  deviceId: string; label?: string;
  reasons: ('no_insurance_support' | 'unsent_changes' | 'not_seen_in_24_hours' | 'never_reported' | 'revoked_with_unsent_changes')[];
  pendingMutationCount?: number; lastReportedOn?: string; revokedOn?: string;
};

/**
 * Activation changes what every device shows at the till, so every active
 * device must already run insurance-capable software, have sent all its queued
 * work, and have reported within a day.
 *
 * Revoking a device does not make its unsent work disappear from the record:
 * a revoked device whose last report still held unsent changes is listed too,
 * and activation proceeds only when the administrator names it — so work lost
 * by a revocation is an explicit, audited decision, never a silent side effect.
 */
export const activationBlockers = async (sql: Sql | Tx, facilityId: string, now = Date.now()): Promise<DeviceBlocker[]> => {
  const rows = await sql<{ id: string; label: string | null; status: string; revoked_on: string | null; insurance_version: number | null; pending_mutation_count: number | null; recorded_on: string | null }[]>`
    SELECT d.id, d.label, d.status, d.revoked_on, v.insurance_version, v.pending_mutation_count, v.recorded_on
    FROM devices d LEFT JOIN workforce_client_versions v ON v.device_id = d.id
    WHERE d.facility_id = ${facilityId} AND (d.status = 'active' OR (d.status = 'revoked' AND COALESCE(v.pending_mutation_count, 0) > 0))
    ORDER BY d.id`;
  const dayAgo = now - 86_400_000;
  return rows.flatMap((row) => {
    const reasons: DeviceBlocker['reasons'] = [];
    if (row.status === 'revoked') reasons.push('revoked_with_unsent_changes');
    else if (!row.recorded_on) reasons.push('never_reported');
    else {
      if (row.insurance_version !== 1) reasons.push('no_insurance_support');
      if ((row.pending_mutation_count ?? 1) !== 0) reasons.push('unsent_changes');
      if (Date.parse(row.recorded_on) < dayAgo) reasons.push('not_seen_in_24_hours');
    }
    return reasons.length ? [{
      deviceId: row.id, ...(row.label ? { label: row.label } : {}), reasons,
      ...(row.pending_mutation_count !== null ? { pendingMutationCount: row.pending_mutation_count } : {}),
      ...(row.recorded_on ? { lastReportedOn: new Date(row.recorded_on).toISOString() } : {}),
      ...(row.revoked_on ? { revokedOn: new Date(row.revoked_on).toISOString() } : {}),
    }] : [];
  });
};

/**
 * Activates a draft: freezes it and publishes one patient-facing schedule per
 * plan. Refused unless insurance is enabled for the hospital, its time zone is
 * recorded, every device is ready, unsupported terms are acknowledged by name,
 * and every revoked device with unsent work is named as accepted.
 */
export const activateContract = async (tx: Tx, input: { facilityId: string; deviceId: string; staffId: string; contractVersionId: string; acknowledgeUnsupported: boolean; acceptRevokedDevices: readonly string[] }, now = Date.now()) => {
  await tx`SELECT id FROM facilities WHERE id = ${input.facilityId} FOR UPDATE`;
  // Activating a contract version prepares cover; it changes bills only once billing itself is active.
  if (!insuranceConfigurable(await insuranceState(tx, input.facilityId))) throw new ContractRefusal('insurance_not_enabled', 'Insurance setup is not enabled for this hospital');
  if (!(await facilityTimeZone(tx, input.facilityId))) throw new ContractRefusal('timezone_required', "Record the hospital's time zone first: insurance dates every service in local time");
  const version = await findContractVersion(tx, input.facilityId, input.contractVersionId, true);
  if (!version) throw new ContractRefusal('not_found', 'This contract version is not in this hospital');
  if (version.status !== 'draft') throw new ContractRefusal('already_active', 'This contract version is already active');
  const blockers = (await activationBlockers(tx, input.facilityId, now))
    .filter((b) => !(b.reasons.length === 1 && b.reasons[0] === 'revoked_with_unsent_changes' && input.acceptRevokedDevices.includes(b.deviceId)));
  if (blockers.length) throw new ContractRefusal('devices_not_ready', 'Every device must sync with the current app before a contract can be activated. A revoked device with unsent work must be named to accept that its work will not arrive', { devices: blockers });
  const unsupported = unsupportedArrangements(version.terms);
  if (unsupported.length && !input.acknowledgeUnsupported) throw new ContractRefusal('unsupported_arrangements', 'This contract names payment terms Geneus cannot calculate yet. Those services will stay undetermined', { unsupported });
  const categories = await feeCategories(tx, input.facilityId, version.terms);
  const createdOn = new Date(now).toISOString();
  const schedules = version.terms.plans.map((plan) => CoverSchedule.parse({
    id: `cover_schedule:${version.id}:${plan.planCode}`, type: 'cover_schedule', facilityId: input.facilityId, schemaVersion: SCHEMA_VERSION,
    createdBy: input.staffId, createdOn, deviceId: input.deviceId,
    payerId: version.terms.payerId, contractId: version.contractId, contractVersionId: version.id, contractVersion: version.version,
    planCode: plan.planCode, planName: plan.name, currency: version.terms.currency,
    effectiveFrom: version.terms.effectiveFrom, effectiveTo: version.terms.effectiveTo, selfPayElection: version.terms.selfPayElection,
    calculationVersion: CALCULATION_VERSION,
    ...buildScheduleLines(version.terms, plan, (id) => categories.get(id)),
  }));
  await tx`UPDATE payer_contract_versions SET status = 'active', activated_by = ${input.staffId}, activated_on = ${createdOn} WHERE id = ${version.id}`;
  for (const schedule of schedules) await insertRecord(tx, 'cover_schedule', schedule);
  return { contractVersionId: version.id, scheduleIds: schedules.map((s) => s.id), unsupported, acceptedRevokedDevices: [...input.acceptRevokedDevices] };
};

/**
 * Ends an active contract version from a date: services on or after it are no
 * longer covered by its schedules. The date may not be before today in the
 * hospital's time zone, so no past estimate changes silently, and confirmed
 * splits — snapshots of their own inputs — never change at all. Replacing a
 * contract is activating its next version; ending is for stopping cover.
 */
export const endContract = async (tx: Tx, input: { facilityId: string; staffId: string; contractVersionId: string; endsOn: string; reason: string }, now = Date.now()) => {
  await tx`SELECT id FROM facilities WHERE id = ${input.facilityId} FOR UPDATE`;
  const timeZone = await facilityTimeZone(tx, input.facilityId);
  const today = serviceDateOf(new Date(now).toISOString(), timeZone);
  if (!today) throw new ContractRefusal('timezone_required', "Record the hospital's time zone first");
  if (input.endsOn < today) throw new ContractRefusal('end_in_past', 'A contract can only end today or later. Past services keep the cover they had');
  const version = await findContractVersion(tx, input.facilityId, input.contractVersionId, true);
  if (!version || version.status !== 'active') throw new ContractRefusal('not_found', 'Choose an active contract version of this hospital');
  if (version.endedOn) throw new ContractRefusal('already_ended', `This contract version already ends on ${version.endedOn}`);
  if (input.endsOn < version.terms.effectiveFrom) throw new ContractRefusal('end_before_start', 'A contract cannot end before it starts');
  const stamp = new Date(now).toISOString();
  await tx`UPDATE payer_contract_versions SET ended_on = ${input.endsOn}, ended_by = ${input.staffId}, end_reason = ${input.reason} WHERE id = ${version.id}`;
  const ended = await tx`UPDATE cover_schedules SET ended_on = ${input.endsOn}, updated_by = ${input.staffId}, updated_on = ${stamp} WHERE facility_id = ${input.facilityId} AND contract_version_id = ${version.id} RETURNING id`;
  return { contractVersionId: version.id, endsOn: input.endsOn, scheduleIds: ended.map((r) => r.id as string) };
};
