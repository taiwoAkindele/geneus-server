import { facilityCompatibilityIssues, workforceEnforcementActive, type Facility, type UploadMutation, type UploadRequest } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
export const FACILITY_FEATURE_SUPPORT = { contractVersion: 1, minimumSchemaVersion: 4, minimumPolicyVersion: 10 } as const;
export class WorkforceCompatibilityError extends Error {
  statusCode = 409;
  code = 'upgrade_required';
}
export const assertWorkforceCompatibility = async (sql: Sql | Tx, facilityId: string, request: UploadRequest, now: number): Promise<void> => {
  const facility = await findRecord<Facility>(sql, 'facility', facilityId);
  let protectedConfiguration = false;
  for (const mutation of request.mutations.filter((m) => ['unit', 'billing_department'].includes(m.table))) {
    const rows = mutation.table === 'unit' ? await sql`SELECT id FROM units u WHERE facility_id=${facilityId} AND id=${mutation.id}
      AND (revision IS NOT NULL OR kind IS NOT NULL OR EXISTS(SELECT 1 FROM service_offerings o WHERE o.facility_id=u.facility_id AND o.unit_id=u.id))`
      : await sql`SELECT id FROM billing_departments WHERE facility_id=${facilityId} AND id=${mutation.id} AND (revision IS NOT NULL OR organization_unit_id IS NOT NULL)`;
    if (rows.length)
      protectedConfiguration = true;
  }
  const issues = facilityCompatibilityIssues(request, FACILITY_FEATURE_SUPPORT, protectedConfiguration || workforceEnforcementActive(facility?.workforcePolicy, now) || request.facilityContractVersion !== undefined);
  if (issues.length)
    throw new WorkforceCompatibilityError(issues.join('; '));
};
/** Preserve original client IDs. A child can be evaluated after its in-batch parents without inventing another queue. */
export const orderWorkforceMutations = (mutations: readonly UploadMutation[]): UploadMutation[] => {
  const isWitness = (m: UploadMutation) => m.table === 'audit_event' && (m.data.metadata as {
    kind?: string;
  } | undefined)?.kind === 'workforce_attestation';
  const pending = [...mutations].sort((a, b) => Number(isWitness(b)) - Number(isWitness(a))), result: UploadMutation[] = [];
  const references = (value: unknown): string[] => typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(references) : value && typeof value === 'object' ? Object.values(value).flatMap(references) : [];
  while (pending.length) {
    const ownBusinessField = (m: UploadMutation) => m.table === 'unit' ? 'unitId' : m.table === 'staff_assignment' ? 'assignmentId' : m.table === 'service_session' ? 'sessionId' : '';
    const index = pending.findIndex((m) => !references(Object.fromEntries(Object.entries(m.data).filter(([key]) => !['id', 'values', 'refusedRecord', 'refusedChanges', 'metadata', ownBusinessField(m), ...(isWitness(m) ? ['entityId'] : [])].includes(key))))
      .some((id) => pending.some((p) => p !== m && (p.id === id || Boolean(ownBusinessField(p)) && p.data[ownBusinessField(p)] === id))));
    if (index < 0) {
      result.push(...pending);
      break;
    }
    result.push(...pending.splice(index, 1));
  }
  return result;
};
