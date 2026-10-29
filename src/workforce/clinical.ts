import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { AuthoritySnapshot, assessDelayedClinicalTime, authoritySignaturePayload, clinicalActivityIssues, clinicalEventActions, encounterClinicalActions, workforceEnforcementActive, OFFLINE_AUTHORIZATION_POLICY, scopeAllows, intervalContains, ClinicalAction, parseDocument, projectClinicalAuthority, type AuditEvent, type ClinicalEvent, type EncounterEntry, type Facility, type Staff, type SyncRejection, } from '#shared';
import type { Tx } from '../db/client.ts';
import type { DeviceIdentity } from '../devices/credentials.ts';
import { findRecord } from '../db/records.ts';
import { deriveAuthority, serverContext, authoritySources } from './authority.ts';
import type { WorkforceRefusal } from './validation.ts';
import { workforcePayloadHash } from './digests.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { randomUUID } from 'node:crypto';
const verifiedAuthority = async (tx: Tx, id: string): Promise<AuthoritySnapshot | undefined> => {
  const proof = await findRecord<AuthoritySnapshot>(tx, 'authority_snapshot', id);
  if (!proof)
    return undefined;
  const [key] = await tx`SELECT public_jwk FROM workforce_signing_keys WHERE id=${proof.keyId} AND trusted`;
  return key && verify(null, Buffer.from(authoritySignaturePayload(proof)), createPublicKey({ key: key.public_jwk as JsonWebKey, format: 'jwk' }), Buffer.from(proof.signature, 'base64')) ? proof : undefined;
};
const actionsFor = async (tx: Tx, record: EncounterEntry | ClinicalEvent) => record.type === 'clinical_event' ? clinicalEventActions(record)
  : encounterClinicalActions(record, record.amends ? await findRecord<EncounterEntry>(tx, 'encounter_entry', record.amends) : undefined);
const reviewCovers = async (tx: Tx, reviewer: Staff, record: EncounterEntry | ClinicalEvent, deviceId: string, now: number): Promise<boolean> => {
  if (!reviewer.active || reviewer.permission !== 'read_write' || reviewer.staffId === record.createdBy || reviewer.facilityId !== record.facilityId || !record.actorContext)
    return false;
  const proof = await deriveAuthority(tx, reviewer, deviceId, now);
  return (await actionsFor(tx, record)).every((action) => proof.snapshot.reviewScopes.some((g) => intervalContains(g, now) && scopeAllows(g.scope, action, record.actorContext!.offeringId)));
};
export const historicalReviewValid = async (tx: Tx, record: EncounterEntry | ClinicalEvent, deviceId: string, now: number): Promise<boolean> => {
  const reviews = await tx`SELECT * FROM workforce_historical_reviews WHERE facility_id=${record.facilityId} AND payload_hash=${workforcePayloadHash(record)} AND expires_on>${new Date(now).toISOString()}`;
  for (const review of reviews) {
    const reviewer = await findRecord<Staff>(tx, 'staff', review.reviewed_by as string);
    if (reviewer && await reviewCovers(tx, reviewer, record, deviceId, now))
      return true;
  }
  return false;
};
export const approveHistoricalReview = async (tx: Tx, identity: DeviceIdentity, reviewer: Staff, rejection: SyncRejection, reason: string, now: number): Promise<string> => {
  if (rejection.facilityId !== identity.facilityId || rejection.operation !== 'put' || !rejection.refusedRecord || !['encounter_entry', 'clinical_event'].includes(rejection.entityType))
    throw new Error('Select an original refused clinical entry in this facility');
  const parsed = parseDocument(rejection.refusedRecord);
  if (!parsed.success || !['encounter_entry', 'clinical_event'].includes(parsed.data.type))
    throw new Error('Original reported care is not a valid source record');
  const record = parsed.data as EncounterEntry | ClinicalEvent;
  if (!await reviewCovers(tx, reviewer, record, identity.deviceId, now))
    throw new Error('Independent accepted reviewer scope is required for every reported action');
  const originalProof = record.actorContext && await verifiedAuthority(tx, record.actorContext.authoritySnapshotId);
  const at = Date.parse(record.createdOn);
  if (!originalProof || originalProof.staffId !== record.createdBy || originalProof.facilityId !== identity.facilityId || at < Date.parse(originalProof.issuedOn) || at > now + 300000
    || !(await actionsFor(tx, record)).every((action) => originalProof.grants.some((g) => intervalContains(g, at) && scopeAllows(g.scope, action, record.actorContext!.offeringId))))
    throw new Error('Historical review cannot invent a missing accepted clinical grant or backdate proof');
  const reportedStaff = await findRecord<Staff>(tx, 'staff', record.createdBy);
  if (!reportedStaff || reportedStaff.facilityId !== identity.facilityId)
    throw new Error('Original worker must remain identifiable in this facility');
  const temporal = projectClinicalAuthority({ ...reportedStaff, active: true, permission: 'read_write' }, await authoritySources(tx, identity.facilityId), at);
  if (!(await actionsFor(tx, record)).every((action) => temporal.grants.some((g) => intervalContains(g, at) && scopeAllows(g.scope, action, record.actorContext!.offeringId))))
    throw new Error('Accepted source history does not support clinical scope at the reported performance time');
  const id = `historical_review:${randomUUID()}`;
  await tx`INSERT INTO workforce_historical_reviews(id,facility_id,rejection_id,payload_hash,reviewed_by,reason,reviewed_on,expires_on)
    VALUES(${id},${identity.facilityId},${rejection.id},${workforcePayloadHash(record)},${reviewer.staffId},${reason},${new Date(now).toISOString()},${new Date(now + 86400000).toISOString()})`;
  await recordAuditEvent(tx, { facilityId: identity.facilityId, deviceId: identity.deviceId, actorStaffId: reviewer.staffId, action: 'update', entityType: 'sync_rejection', entityId: rejection.id, metadata: { historicalReviewId: id, disposition: 'authorized_exact_resubmission' } });
  return id;
};
export const completeHistoricalReview = async (tx: Tx, record: EncounterEntry | ClinicalEvent, deviceId: string, now: number): Promise<void> => {
  const [review] = await tx`SELECT * FROM workforce_historical_reviews WHERE facility_id=${record.facilityId} AND payload_hash=${workforcePayloadHash(record)}
    AND expires_on>${new Date(now).toISOString()} ORDER BY reviewed_on DESC LIMIT 1`;
  if (!review)
    return;
  await tx`UPDATE workforce_historical_reviews SET expires_on=${new Date(now).toISOString()} WHERE id=${review.id}`;
  await tx`UPDATE sync_rejections SET resolved_on=${new Date(now).toISOString()},resolved_by=${review.reviewed_by},resolution=${`Accepted exact source content following independent review ${String(review.id)}`}
    WHERE id=${review.rejection_id} AND facility_id=${record.facilityId}`;
  await recordAuditEvent(tx, {
    facilityId: record.facilityId, deviceId, actorStaffId: review.reviewed_by as string, action: 'update', entityType: record.type, entityId: record.id,
    metadata: { historicalReviewId: review.id as string, reportedAuthor: record.createdBy }
  });
};
/** Existing append-only audit events carry bounded, payload-bound co-signatures through the same offline queue. */
export const clinicalAttestationRefusal = async (tx: Tx, identity: DeviceIdentity, audit: AuditEvent, now: number): Promise<WorkforceRefusal | undefined> => {
  if (audit.metadata?.kind !== 'workforce_attestation')
    return undefined;
  const meta = audit.metadata;
  const action = ClinicalAction.safeParse(meta.action);
  if (!action.success || audit.actorStaffId !== audit.createdBy || typeof meta.recordId !== 'string' || typeof meta.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(meta.payloadHash)
    || typeof meta.offeringId !== 'string' || !['supervisor', 'checker'].includes(String(meta.attestationKind)))
    return { category: 'validation', reason: 'Co-signature must identify its author, activity, service and exact source digest' };
  const worker = await findRecord<Staff>(tx, 'staff', audit.createdBy);
  if (!worker || worker.facilityId !== identity.facilityId)
    return { category: 'authorization', reason: 'Witness must be a facility member' };
  const requiredAction = meta.attestationKind === 'checker' && ['record_result', 'perform_test'].includes(action.data) ? 'verify_result' : action.data;
  const accepted = typeof meta.authoritySnapshotId === 'string' ? await verifiedAuthority(tx, meta.authoritySnapshotId) : undefined;
  if (!accepted || accepted.staffId !== worker.staffId || accepted.facilityId !== identity.facilityId || Date.parse(audit.occurredOn) < Date.parse(accepted.issuedOn)
    || Date.parse(audit.occurredOn) >= Date.parse(accepted.expiresOn) || !accepted.grants.some((g) => intervalContains(g, Date.parse(audit.occurredOn)) && scopeAllows(g.scope, requiredAction, meta.offeringId as string)))
    return { category: 'authorization', reason: 'Witness needs accepted personal scope effective at the co-signature time' };
  const issues = clinicalActivityIssues(worker, serverContext(worker, identity.deviceId, now), await deriveAuthority(tx, worker, identity.deviceId, now), { action: requiredAction, offeringId: meta.offeringId }, now);
  issues.push(...clinicalActivityIssues(worker, serverContext(worker, identity.deviceId, Date.parse(audit.occurredOn)), await deriveAuthority(tx, worker, identity.deviceId, Date.parse(audit.occurredOn)), { action: requiredAction, offeringId: meta.offeringId }, Date.parse(audit.occurredOn)));
  if (issues.length)
    return { category: 'authorization', reason: 'Witness lacks the required independent clinical scope' };
  const performed = Date.parse(audit.occurredOn);
  return !Number.isFinite(performed) || performed > now + 300000 || now - performed > OFFLINE_AUTHORIZATION_POLICY.generalMs ? { category: 'authorization', reason: 'Witness time is outside trusted offline bounds' } : undefined;
};
/** Historical proofs are loaded from our immutable rows; no proof/verified flag from the upload is trusted. */
export const clinicalAuthorityRefusal = async (tx: Tx, identity: DeviceIdentity, record: EncounterEntry | ClinicalEvent, now: number): Promise<WorkforceRefusal | undefined> => {
  const facility = await findRecord<Facility>(tx, 'facility', identity.facilityId);
  if (!workforceEnforcementActive(facility?.workforcePolicy, now))
    return undefined;
  const actorContext = record.actorContext;
  if (!actorContext)
    return { category: 'authorization', reason: 'This facility requires the accepted clinical authority and service context; upgrade and review this entry' };
  const staff = await findRecord<Staff>(tx, 'staff', record.createdBy);
  const accepted = await verifiedAuthority(tx, actorContext.authoritySnapshotId);
  if (!staff || staff.facilityId !== identity.facilityId || !accepted || accepted.staffId !== staff.staffId || accepted.facilityId !== identity.facilityId)
    return { category: 'authorization', reason: 'Clinical authority must belong to the attributed worker and facility' };
  const performed = Date.parse(record.createdOn);
  const reviewed = await historicalReviewValid(tx, record, identity.deviceId, now);
  const time = assessDelayedClinicalTime({
    performedOn: record.createdOn, receivedOn: new Date(now).toISOString(), lastTrustedServerOn: accepted.issuedOn,
    maximumClockSkewMs: 300000, maximumOfflineMs: OFFLINE_AUTHORIZATION_POLICY.generalMs, authorityExpiresOn: accepted.expiresOn
  });
  if (time === 'invalid_time' || time !== 'current' && !reviewed)
    return { category: 'authorization', reason: time === 'invalid_time' ? 'Clinical time is outside trusted bounds; retain this reported care for review' : 'Delayed clinical authority requires independent historical review; reported care is retained in reconciliation' };
  const original = record.type === 'encounter_entry' && record.amends ? await findRecord<EncounterEntry>(tx, 'encounter_entry', record.amends) : undefined;
  const actions = record.type === 'encounter_entry' ? encounterClinicalActions(record, original) : clinicalEventActions(record);
  const witnesses = await tx`SELECT * FROM audit_events WHERE facility_id=${identity.facilityId}
    AND metadata->>'kind'='workforce_attestation' AND metadata->>'recordId'=${record.id} AND metadata->>'payloadHash'=${workforcePayloadHash(record)}`;
  const source = serverContext(staff, identity.deviceId, performed);
  const current = await deriveAuthority(tx, staff, identity.deviceId, now);
  const effectiveThen = await deriveAuthority(tx, staff, identity.deviceId, performed);
  for (const action of actions) {
    const qualified: string[] = [];
    for (const witness of witnesses) {
      const actorId = witness.actor_staff_id as string;
      if (actorId === record.createdBy || witness.created_by !== actorId || witness.metadata.action !== action || witness.metadata.offeringId !== actorContext.offeringId)
        continue;
      const worker = await findRecord<Staff>(tx, 'staff', actorId);
      const requiredAction = witness.metadata.attestationKind === 'checker' && ['record_result', 'perform_test'].includes(action) ? 'verify_result' : action;
      if (worker && clinicalActivityIssues(worker, serverContext(worker, identity.deviceId, now), await deriveAuthority(tx, worker, identity.deviceId, now), { action: requiredAction, offeringId: actorContext.offeringId }, now).length === 0)
        qualified.push(actorId);
    }
    // Receipt-time re-derivation catches revocation after the offline signature was issued.
    const nowIssues = clinicalActivityIssues(staff, serverContext(staff, identity.deviceId, now), current, { action, offeringId: actorContext.offeringId, availableQualifiedActorIds: qualified }, now);
    const thenIssues = clinicalActivityIssues(staff, source, { snapshot: accepted, signatureVerified: true, currentRevision: accepted.revision }, { action, offeringId: actorContext.offeringId, availableQualifiedActorIds: qualified }, performed);
    thenIssues.push(...clinicalActivityIssues(staff, source, effectiveThen, { action, offeringId: actorContext.offeringId, availableQualifiedActorIds: qualified }, performed));
    if (reviewed) {
      if (!accepted.grants.some((g) => intervalContains(g, performed) && scopeAllows(g.scope, action, actorContext.offeringId)))
        return { category: 'authorization', reason: 'Historical review cannot invent clinical authority that was absent when care was reported' };
    }
    else if (thenIssues.length || nowIssues.length)
      return { category: 'authorization', reason: 'Effective clinical scope/restrictions could not be confirmed at performance and receipt; retain for independent review' };
  }
  if (actorContext.assignmentRevisionId) {
    const assignment = await findRecord(tx, 'staff_assignment', actorContext.assignmentRevisionId);
    if (!assignment || assignment.type !== 'staff_assignment' || assignment.staffId !== staff.staffId || assignment.facilityId !== identity.facilityId || assignment.offeringId !== actorContext.offeringId)
      return { category: 'validation', reason: 'Clinical attribution must name this worker/service assignment revision' };
  }
  return undefined;
};
