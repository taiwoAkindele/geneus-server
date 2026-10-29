import { FACILITY_DOCUMENT_POLICY, HIGH_RISK_PERMISSIONS, OFFLINE_AUTHORIZATION_POLICY, currentFacilityRevisions, facilityHeadIssues, facilityMutationIssues, facilityReferenceIssues, facilityRetirementImpact, hierarchyIssues, unitHierarchyIssues, billingOrganizationIssues, reviewerDecisionIssues, sessionBookingIssues, sessionConflictIssues, sessionRosterIssues, sessionEventIssues, sessionEventHeadIssues, staffPermissions, workOwnershipHeadIssues, workOwnershipIssues, workOwnershipReferenceIssues, type AnyDocument, type FacilityDependency, type FacilityRecords, type RejectionCategory, type UploadMutation, } from '#shared';
import type { DeviceIdentity } from '../devices/credentials.ts';
import type { Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import { deriveAuthority, serverContext } from './authority.ts';
import { acceptedAppointments, loadWorkforce, recordsInFacility, sessionAppointments } from './records.ts';
import { coverageIssues } from './coverage.ts';
export type WorkforceRefusal = {
  category: RejectionCategory;
  reason: string;
  dependencies?: FacilityDependency[];
};
const issuesRefusal = (issues: string[], category: RejectionCategory = 'validation'): WorkforceRefusal | undefined => issues.length ? { category, reason: issues.join('; ') } : undefined;
export const workforceType = (type: string): boolean => Object.hasOwn(FACILITY_DOCUMENT_POLICY, type);
export const workforceConfiguration = (type: string): boolean => ['unit', 'billing_department'].includes(type) || workforceType(type);
export const normalizeOrganizationReferences = (record: AnyDocument, data: FacilityRecords): AnyDocument => {
  const resolve = (id?: string) => {
    const matches = data.units.filter((u) => u.id === id || u.unitId === id);
    return matches.length === 1 ? matches[0].id : id;
  };
  if (record.type === 'unit')
    return Object.hasOwn(record, 'parentId') ? { ...record, parentId: resolve(record.parentId) } : record;
  if (record.type === 'location')
    return { ...record, unitId: resolve(record.unitId) };
  if (record.type === 'service_offering')
    return { ...record, unitId: resolve(record.unitId)! };
  if (record.type === 'billing_department')
    return Object.hasOwn(record, 'organizationUnitId') ? { ...record, organizationUnitId: resolve(record.organizationUnitId) } : record;
  return record;
};
/** Missing references are durable linked refusals; never activate a child whose parent was refused. */
const missingDependencies = async (tx: Tx, record: AnyDocument, data: FacilityRecords): Promise<FacilityDependency[]> => {
  const refs: FacilityDependency[] = [];
  const ref = (table: FacilityDependency['table'], id?: string) => {
    if (id)
      refs.push({ table, id });
  };
  if ('staffId' in record && typeof record.staffId === 'string' && record.type !== 'staff')
    ref('staff', record.staffId);
  if ('supervisorId' in record)
    ref('staff', record.supervisorId);
  if (['credential', 'capability_decision', 'reviewer_delegation', 'clinical_authority_bootstrap', 'staff_assignment', 'service_session', 'session_event', 'work_ownership_event'].includes(record.type) && 'previousId' in record)
    ref(record.type, record.previousId);
  switch (record.type) {
    case 'unit':
      ref('unit', record.parentId);
      break;
    case 'location':
      ref('location', record.parentId);
      ref('unit', record.unitId);
      break;
    case 'billing_department':
      ref('unit', record.organizationUnitId);
      break;
    case 'service_offering':
      ref('unit', record.unitId);
      ref('service_definition', record.serviceDefinitionId);
      for (const id of record.locationIds)
        ref('location', id);
      break;
    case 'staff_assignment':
      ref('service_offering', record.offeringId);
      for (const id of record.locationIds)
        ref('location', id);
      break;
    case 'service_session':
      ref('service_offering', record.offeringId);
      for (const r of record.resources)
        ref('location', r.locationId);
      for (const p of record.participants) {
        ref('staff', p.staffId);
        if (!data.assignments.some((a) => a.assignmentId === p.assignmentId))
          ref('staff_assignment', p.assignmentId);
      }
      for (const id of record.rosterShiftIds)
        ref('roster_shift', id);
      break;
    case 'session_event':
      ref('service_offering', record.offeringId);
      if (record.sessionId && !data.sessions.some((s) => s.sessionId === record.sessionId))
        ref('service_session', record.sessionId);
      break;
    case 'work_ownership_event':
      ref('handoff', record.sourceId);
      ref('service_offering', record.offeringId);
      ref('staff', record.ownerStaffId);
      ref('staff', record.recipientStaffId);
      break;
    case 'capability_decision':
      for (const id of record.credentialRevisionIds)
        if (['approve', 'restrict'].includes(record.decision))
          ref('credential', id);
      break;
  }
  if ('scope' in record && record.scope.kind === 'offerings')
    for (const id of record.scope.offeringIds)
      ref('service_offering', id);
  if ('scopes' in record)
    for (const scope of record.scopes)
      if (scope.kind === 'offerings')
        for (const id of scope.offeringIds)
          ref('service_offering', id);
  const missing: FacilityDependency[] = [];
  for (const r of refs) {
    const found = await findRecord(tx, r.table, r.id);
    if (!found || found.facilityId !== record.facilityId)
      missing.push(r);
  }
  return missing;
};
export const validateWorkforceRecord = async (tx: Tx, identity: DeviceIdentity, input: AnyDocument, mutation: UploadMutation, now: number, current?: AnyDocument): Promise<{
  record: AnyDocument;
  refusal?: WorkforceRefusal;
}> => {
  const data = await loadWorkforce(tx, identity.facilityId);
  const record = normalizeOrganizationReferences(input, data);
  const fail = (refusal?: WorkforceRefusal) => ({ record, refusal });
  const actorId = current ? String(mutation.data.updatedBy ?? '') : record.createdBy;
  const actor = data.staff.find((s) => s.staffId === actorId);
  if (!actor?.active || actor.permission !== 'read_write')
    return fail({ category: 'authorization', reason: 'An active writable member of this facility must make this change' });
  const guard = facilityMutationIssues({ ...mutation, data: record }, current);
  if (guard.length)
    return fail(issuesRefusal(guard, 'conflict'));
  const policy = workforceType(record.type) ? FACILITY_DOCUMENT_POLICY[record.type as keyof typeof FACILITY_DOCUMENT_POLICY] : undefined;
  if (policy?.writer === 'server')
    return fail({ category: 'authorization', reason: 'This record is server-owned' });
  const permission = policy && 'permission' in policy ? policy.permission : record.type === 'unit' ? 'unit:manage' : 'fee_item:manage';
  const context = serverContext(actor, identity.deviceId, now);
  if (record.type === 'capability_decision' || record.type === 'reviewer_delegation') {
    const issues = reviewerDecisionIssues(actor, context, await deriveAuthority(tx, actor, identity.deviceId, now), record, now);
    if (issues.length)
      return fail(issuesRefusal(issues, 'authorization'));
  }
  else if (!staffPermissions(actor).includes(permission))
    return fail({ category: 'authorization', reason: 'Required workflow permission is not granted' });
  const performed = Date.parse(current ? String(mutation.data.updatedOn ?? '') : record.createdOn);
  if (!Number.isFinite(performed) || performed > now + 300000 || (HIGH_RISK_PERMISSIONS.includes(permission) && now - performed > OFFLINE_AUTHORIZATION_POLICY.highRiskMs))
    return fail({ category: 'authorization', reason: 'Change time is invalid or outside the high-risk authorization window' });
  const missing = await missingDependencies(tx, record, data);
  if (missing.length)
    return fail({ category: 'dependency', reason: 'Required configuration has not been accepted; review the linked references and resubmit', dependencies: missing });
  let issues: string[] = [];
  switch (record.type) {
    case 'unit':
      issues = unitHierarchyIssues(record, data.units);
      if (current?.type === 'unit' && (record.unitId !== current.unitId || current.kind && !record.kind))
        issues.push('Preserve the original organization alias and reviewed classification');
      for (const offering of data.offerings.filter((o) => o.unitId === record.id && o.configuration === 'active'))
        issues.push(...facilityReferenceIssues(offering, { ...data, units: [...data.units.filter((u) => u.id !== record.id), record] }));
      break;
    case 'billing_department':
      issues = billingOrganizationIssues(record, data.units);
      break;
    case 'location':
    case 'service_offering':
    case 'practitioner_profile':
    case 'credential':
    case 'capability_decision':
    case 'reviewer_delegation':
    case 'staff_assignment':
    case 'service_session':
      issues = facilityReferenceIssues(record, data);
      break;
    case 'service_definition':
      if (!record.active && data.offerings.some((o) => o.serviceDefinitionId === record.id && o.configuration === 'active'))
        issues.push('Retire or replace active offerings before retiring this definition');
      break;
  }
  if ('version' in record && 'previousId' in record && ['credential', 'capability_decision', 'reviewer_delegation', 'staff_assignment', 'service_session'].includes(record.type)) {
    const history = await recordsInFacility(tx, identity.facilityId, record.type as 'credential' | 'capability_decision' | 'reviewer_delegation' | 'staff_assignment' | 'service_session');
    issues.push(...facilityHeadIssues(record as typeof history[number], currentFacilityRevisions(history)));
  }
  if (record.type === 'location')
    issues.push(...hierarchyIssues(record, data.locations));
  if(record.type==='practitioner_profile'&&current?.type==='practitioner_profile'&&record.staffId!==current.staffId)issues.push('Professional profiles retain their original staff identity');
  if (record.type === 'capability_decision' && ['approve', 'restrict'].includes(record.decision)) {
    const profiles = await recordsInFacility(tx, identity.facilityId, 'practitioner_profile');
    if (!profiles.some((p) => p.staffId === record.staffId && p.active))
      issues.push('Record the clinical worker professional profile before approving activity scope');
  }
  if (current && ((record.type === 'unit' || record.type === 'location') && !record.active || record.type === 'service_offering' && record.configuration === 'retired')) {
    const [handoffs, ownership] = await Promise.all([recordsInFacility(tx, identity.facilityId, 'handoff'), recordsInFacility(tx, identity.facilityId, 'work_ownership_event')]);
    const ownershipHeads = ownership.filter((e) => !ownership.some((n) => n.previousId === e.id) && handoffs.some((h) => h.id === e.sourceId && h.status !== 'done'));
    const impact = facilityRetirementImpact(record as Extract<AnyDocument, {
      type: 'unit' | 'location' | 'service_offering';
    }>, { ...data, handoffs, ownershipHeads, appointments: await acceptedAppointments(tx, identity.facilityId, now) }, now);
    if (impact.length)
      issues.push('Resolve active linked services, coverage, reservations and unfinished work before retirement');
  }
  if (record.type === 'staff_assignment' && currentFacilityRevisions(data.sessions).some((s) => s.status === 'published' && Date.parse(s.endsAt) > now && s.participants.some((p) => p.assignmentId === record.assignmentId))) {
    for (const session of currentFacilityRevisions(data.sessions).filter((s) => s.status === 'published' && Date.parse(s.endsAt) > now && s.participants.some((p) => p.assignmentId === record.assignmentId))) {
      issues.push(...facilityReferenceIssues(session, { ...data, assignments: [...data.assignments, record] }));
      issues.push(...await coverageIssues(tx, { ...data, assignments: [...data.assignments, record] }, session, now));
    }
  }
  if (record.type === 'service_session') {
    const appointments = await sessionAppointments(tx, identity.facilityId, [...data.sessions, record]);
    issues.push(...sessionBookingIssues(record, appointments, data.locations, now));
    if (record.status === 'published') {
      issues.push(...sessionConflictIssues(record, data.sessions, data.locations, await acceptedAppointments(tx, identity.facilityId, now)));
      issues.push(...sessionRosterIssues(record, await recordsInFacility(tx, identity.facilityId, 'roster_shift')));
      issues.push(...await coverageIssues(tx, data, record, now));
    }
  }
  if (record.type === 'session_event') {
    const history = await recordsInFacility(tx, identity.facilityId, 'session_event');
    const heads = history.filter((e) => !history.some((n) => n.previousId === e.id));
    issues.push(...sessionEventHeadIssues(record, heads), ...sessionEventIssues(record, history.find((e) => e.id === record.previousId)));
    const offering = data.offerings.find((o) => o.id === record.offeringId);
    if (!offering || offering.configuration !== 'active')
      issues.push('Open intake only for an active offering');
    if (record.sessionId && !currentFacilityRevisions(data.sessions).some((s) => s.sessionId === record.sessionId && s.offeringId === record.offeringId && s.status === 'published'))
      issues.push('Intake must reference the current published occurrence');
  }
  if (record.type === 'work_ownership_event') {
    const history = await recordsInFacility(tx, identity.facilityId, 'work_ownership_event');
    const heads = history.filter((e) => !history.some((n) => n.previousId === e.id));
    const source = await findRecord<Extract<AnyDocument, {
      type: 'handoff';
    }>>(tx, 'handoff', record.sourceId);
    if (source)
      issues.push(...workOwnershipHeadIssues(record, heads), ...workOwnershipIssues(record, source, history.find((e) => e.id === record.previousId), staffPermissions(actor).includes('work_ownership:manage')), ...workOwnershipReferenceIssues(record, source, data, now));
  }
  return fail(issuesRefusal(issues, 'conflict'));
};
