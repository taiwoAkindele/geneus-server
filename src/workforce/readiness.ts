import { rolesFor, currentFacilityRevisions, type Facility, type FacilityWorkforcePolicy, type Staff } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import type { DeviceIdentity } from '../devices/credentials.ts';
import { deriveAuthority } from './authority.ts';
import { loadWorkforce } from './records.ts';
import { coverageIssues } from './coverage.ts';
export const recordClientVersion = async (sql: Sql | Tx, identity: DeviceIdentity, input: {
  facilityContractVersion?: number;
  schemaVersion?: number;
  policyVersion?: number;
  pendingMutationCount?: number;
}, now: number): Promise<void> => {
  const compatible = input.facilityContractVersion === 1 && input.schemaVersion === 4 && input.policyVersion === 10;
  await sql`INSERT INTO workforce_client_versions(device_id,facility_id,contract_version,schema_version,policy_version,pending_mutation_count,recorded_on)
    VALUES(${identity.deviceId},${identity.facilityId},${compatible ? 1 : 0},${input.schemaVersion ?? 0},${input.policyVersion ?? 0},${input.pendingMutationCount ?? 1},${new Date(now).toISOString()})
    ON CONFLICT(device_id) DO UPDATE SET contract_version=EXCLUDED.contract_version,schema_version=EXCLUDED.schema_version,policy_version=EXCLUDED.policy_version,pending_mutation_count=EXCLUDED.pending_mutation_count,recorded_on=EXCLUDED.recorded_on`;
};
const clinicalMember = (staff: Staff) => staff.active && staff.permission === 'read_write' && rolesFor(staff).some((role) => ['chew', 'nurse', 'doctor', 'supervisor', 'laboratory_staff', 'pharmacy_staff'].includes(role));
export const workforceReadiness = async (sql: Sql | Tx, facilityId: string, now = Date.now()) => {
  const data = await loadWorkforce(sql, facilityId);
  const blockers: {
    kind: string;
    ids: string[];
  }[] = [];
  const add = (kind: string, ids: string[]) => {
    if (ids.length)
      blockers.push({ kind, ids });
  };
  add('review_legacy_organizations', data.units.filter((u) => u.active && !u.kind).map((u) => u.id));
  const aliases = data.units.filter((u) => data.units.some((n) => n.id !== u.id && (n.id === u.unitId || n.unitId === u.id || n.unitId === u.unitId)));
  add('ambiguous_organization_identities', aliases.map((u) => u.id));
  const departments = await sql`SELECT id FROM billing_departments WHERE facility_id=${facilityId} AND active AND organization_unit_id IS NULL`;
  add('review_financial_organization_links', departments.map((r) => r.id as string));
  if (!data.offerings.some((o) => o.configuration === 'active'))
    add('configure_actual_services', [facilityId]);
  for (const worker of data.staff.filter(clinicalMember))
    if (!(await deriveAuthority(sql, worker, worker.deviceId, now)).snapshot.grants.length)
      add('clinical_approval_needed', [worker.staffId]);
  for (const session of currentFacilityRevisions(data.sessions).filter((s) => s.status === 'published' && Date.parse(s.endsAt) > now)) {
    if ((await coverageIssues(sql, data, session, now)).length)
      add('published_coverage_needs_approval_or_cover', [session.id]);
  }
  const devices = await sql`SELECT d.id FROM devices d LEFT JOIN workforce_client_versions v ON v.device_id=d.id
    WHERE d.facility_id=${facilityId} AND d.status='active' AND (v.device_id IS NULL OR v.contract_version<>1 OR v.schema_version<>4 OR v.policy_version<>10 OR v.pending_mutation_count<>0 OR v.recorded_on<${new Date(now - 86400000).toISOString()})`;
  add('upgrade_and_drain_active_devices', devices.map((r) => r.id as string));
  const rejections = await sql`SELECT id FROM sync_rejections WHERE facility_id=${facilityId} AND resolved_on IS NULL AND entity_type IN ('encounter_entry','clinical_event','credential','capability_decision','reviewer_delegation')`;
  add('resolve_pending_clinical_or_authority_writes', rejections.map((r) => r.id as string));
  return {
    ready: blockers.length === 0, blockers, inventory: {
      units: data.units.map((u) => ({ id: u.id, unitId: u.unitId, name: u.name, kind: u.kind ?? 'unreviewed_legacy_unit', revision: u.revision ?? 1 })),
      staff: data.staff.map((s) => ({ id: s.id, role: s.role, active: s.active })), offerings: data.offerings.map((o) => ({ id: o.id, configuration: o.configuration })),
    }
  };
};
export const policyTransitionIssues = async (tx: Tx, facilityId: string, policy: FacilityWorkforcePolicy, now: number): Promise<string[]> => {
  const facility = await findRecord<Facility>(tx, 'facility', facilityId);
  if (!facility)
    return ['Facility does not exist'];
  if (policy.revision !== (facility.workforcePolicy?.revision ?? 0) + 1)
    return ['Policy revision changed; review it again'];
  if (policy.mode !== 'enforced')
    return [];
  if (!facility.timeZone)
    return ['Set and review the facility timezone before enforcement'];
  if (!policy.effectiveOn || Date.parse(policy.effectiveOn) < now)
    return ['Use an explicit current or future enforcement instant'];
  const readiness = await workforceReadiness(tx, facilityId, Math.max(now, Date.parse(policy.effectiveOn)));
  return readiness.blockers.map((b) => b.kind);
};
