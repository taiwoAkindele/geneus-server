/** Deployment-operator entry points. These are never registered as public mutation routes. */
import { randomUUID } from 'node:crypto';
import { FacilityTimeZone, FacilityWorkforcePolicy, parseDocument, currentFacilityRevisions, facilityHeadIssues, facilityReferenceIssues, configurationRevisionIssues, externalReviewerIssues, IMMUTABLE_ENVELOPE_FIELDS, type AnyDocument, type Staff, type Facility, } from '#shared';
import type { Sql } from '../db/client.ts';
import { findRecord, insertRecord, toRow } from '../db/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { saveStaffEmail } from '../email/verifications.ts';
import type { Signer } from '../lib/signing.ts';
import { refreshFacilityAuthority } from './authority.ts';
import { loadWorkforce, recordsInFacility } from './records.ts';
import { workforcePayloadHash } from './digests.ts';
import { policyTransitionIssues, workforceReadiness } from './readiness.ts';
export const applyGovernanceRecord = async (sql: Sql, signer: Signer, input: unknown, operator: string, expectedRevision?: number): Promise<{
  id: string;
  duplicate: boolean;
}> => {
  if (!operator.trim())
    throw new Error('An accountable deployment operator is required');
  const parsed = parseDocument(input);
  if (!parsed.success)
    throw new Error('Governance record does not match the shared contract');
  const record = parsed.data;
  // Read the parsed envelope without narrowing the generic Zod factory's overwritten literal field.
  if (!['clinical_authority_bootstrap', 'external_clinical_reviewer', 'credential', 'capability_decision'].includes(record.type) || (record as Record<string, unknown>).createdBy !== 'system')
    throw new Error('Only the audited bootstrap/external-verification record types are accepted here');
  if ((record.type === 'credential' || record.type === 'capability_decision') && !record.externalReviewerId)
    throw new Error('Use ordinary independent review through sync, or identify the real authorized external verifier');
  const commandId = `${record.type}:${record.id}:${'revision' in record ? record.revision : 'immutable'}`, digest = workforcePayloadHash(record);
  return sql.begin(async (tx) => {
    const [facility] = await tx`SELECT id FROM facilities WHERE id=${record.facilityId} FOR UPDATE`;
    const [device] = await tx`SELECT id FROM devices WHERE facility_id=${record.facilityId} AND id=${record.deviceId} AND status='active'`;
    if (!facility || !device)
      throw new Error('Governance provenance must identify a real facility and active enrolled device');
    const [prior] = await tx`SELECT payload_hash FROM workforce_operator_commands WHERE id=${commandId}`;
    if (prior) {
      if (prior.payload_hash !== digest)
        throw new Error('Operation identity was already used with different content');
      return { id: record.id, duplicate: true };
    }
    const data = await loadWorkforce(tx, record.facilityId);
    if (record.type === 'clinical_authority_bootstrap' || record.type === 'credential' || record.type === 'capability_decision') {
      const issues = facilityReferenceIssues(record, data);
      const history = await recordsInFacility(tx, record.facilityId, record.type);
      issues.push(...facilityHeadIssues(record, currentFacilityRevisions(history)));
      if (issues.length)
        throw new Error(issues.join('; '));
    }
    if (record.type === 'credential' || record.type === 'capability_decision') {
      if (record.type === 'capability_decision' && ['approve', 'restrict'].includes(record.decision)) {
        const profiles = await recordsInFacility(tx, record.facilityId, 'practitioner_profile');
        if (!profiles.some((p) => p.staffId === record.staffId && p.active))
          throw new Error('Record a professional profile before external capability approval');
      }
      const reviewer = await findRecord(tx, 'external_clinical_reviewer', record.externalReviewerId!);
      if (!reviewer || reviewer.type !== 'external_clinical_reviewer')
        throw new Error('External reviewer was not established through audited governance');
      const issues = externalReviewerIssues(reviewer, record, true, Date.now());
      if (issues.length)
        throw new Error(issues.join('; '));
    }
    const current = await findRecord<AnyDocument>(tx, record.type, record.id);
    if (current && record.type !== 'external_clinical_reviewer')
      throw new Error('Immutable governance record already exists');
    if (current && record.type === 'external_clinical_reviewer') {
      const issues = configurationRevisionIssues(expectedRevision, 'revision' in current ? current.revision : undefined);
      if (record.revision !== (('revision' in current ? current.revision : 0) ?? 0) + 1)
        issues.push('External reviewer revision must increment once');
      if (IMMUTABLE_ENVELOPE_FIELDS.some((key) => key === 'createdOn' ? Date.parse(current.createdOn) !== Date.parse(record.createdOn) : workforcePayloadHash(current[key]) !== workforcePayloadHash(record[key])))
        issues.push('External review provenance cannot be rewritten');
      if (current.type !== 'external_clinical_reviewer' || current.externalSubjectReference !== record.externalSubjectReference)
        issues.push('Do not move a historical reviewer identity to a different person');
      if (issues.length)
        throw new Error(issues.join('; '));
      await tx`UPDATE external_clinical_reviewers SET ${tx(toRow(tx, record.type, record))} WHERE id=${record.id} AND facility_id=${record.facilityId}`;
    }
    else
      await insertRecord(tx, record.type, record);
    await tx`INSERT INTO workforce_operator_commands(id,facility_id,payload_hash,operator) VALUES(${commandId},${record.facilityId},${digest},${operator})`;
    await recordAuditEvent(tx, {
      facilityId: record.facilityId, deviceId: record.deviceId, action: current ? 'update' : 'create', entityType: record.type, entityId: record.id,
      metadata: { channel: 'deployment_operator', operator, commandId }
    });
    await refreshFacilityAuthority(tx, record.facilityId, signer, Date.now());
    return { id: record.id, duplicate: false };
  });
};
export const setWorkforcePolicy = async (sql: Sql, signer: Signer, input: {
  facilityId: string;
  deviceId: string;
  operator: string;
  policy: unknown;
  timeZone?: string;
}, now = Date.now()): Promise<void> => {
  const policy = FacilityWorkforcePolicy.parse(input.policy);
  if (!input.operator.trim())
    throw new Error('Deployment operator is required');
  if (input.timeZone)
    FacilityTimeZone.parse(input.timeZone);
  await sql.begin(async (tx) => {
    const [facility] = await tx`SELECT id FROM facilities WHERE id=${input.facilityId} FOR UPDATE`;
    const [device] = await tx`SELECT id FROM devices WHERE facility_id=${input.facilityId} AND id=${input.deviceId} AND status='active'`;
    if (!facility || !device)
      throw new Error('Facility and active provenance device are required');
    const current = await findRecord<Facility>(tx, 'facility', input.facilityId);
    if (current?.workforcePolicy && workforcePayloadHash(current.workforcePolicy) === workforcePayloadHash(policy)
      && (!input.timeZone || input.timeZone === current.timeZone))
      return;
    if (input.timeZone)
      await tx`UPDATE facilities SET time_zone=${input.timeZone} WHERE id=${input.facilityId}`;
    const issues = await policyTransitionIssues(tx, input.facilityId, policy, now);
    if (issues.length)
      throw new Error(`Readiness is incomplete: ${issues.join('; ')}`);
    const readiness = await workforceReadiness(tx, input.facilityId, now);
    await tx`INSERT INTO workforce_migration_reviews(facility_id,revision,inventory,reviewed_by,reviewed_on)
      VALUES(${input.facilityId},${policy.revision},${tx.json(readiness.inventory)},${input.operator},${new Date(now).toISOString()})`;
    await tx`UPDATE facilities SET workforce_policy=${tx.json(policy)},schema_version=4,updated_by='system',updated_on=${new Date(now).toISOString()} WHERE id=${input.facilityId}`;
    await refreshFacilityAuthority(tx, input.facilityId, signer, now);
    await recordAuditEvent(tx, {
      facilityId: input.facilityId, deviceId: input.deviceId, action: 'update', entityType: 'facility', entityId: input.facilityId,
      metadata: { operator: input.operator, workforceMode: policy.mode, policyRevision: policy.revision }
    });
  });
};
/** A deployment operator can provision an independently established staff contact without inventing another staff identity. */
export const provisionWorkforceContact = async (sql: Sql, input: {
  facilityId: string;
  staffId: string;
  deviceId: string;
  email: string;
  operator: string;
  governanceReference: string;
}): Promise<void> => {
  if (!input.operator.trim() || !input.governanceReference.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))
    throw new Error('Verified contact and audited governance are required');
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM facilities WHERE id=${input.facilityId} FOR UPDATE`;
    const staff = await findRecord<Staff>(tx, 'staff', input.staffId);
    if (!staff?.active || staff.facilityId !== input.facilityId)
      throw new Error('Contact must belong to active facility staff');
    const [device] = await tx`SELECT id FROM devices WHERE facility_id=${input.facilityId} AND id=${input.deviceId} AND status='active'`;
    if (!device)
      throw new Error('Verified contact provenance must use an active facility device');
    await saveStaffEmail(tx, input.facilityId, input.staffId, input.email.trim().toLowerCase());
    const id = `contact:${randomUUID()}`;
    await tx`INSERT INTO workforce_operator_commands(id,facility_id,payload_hash,operator) VALUES(${id},${input.facilityId},${workforcePayloadHash(input)},${input.operator})`;
    await recordAuditEvent(tx, {
      facilityId: input.facilityId, deviceId: input.deviceId, action: 'update', entityType: 'staff', entityId: input.staffId,
      metadata: { channel: 'deployment_operator', operator: input.operator, workforceContact: 'provisioned' }
    });
  });
};
