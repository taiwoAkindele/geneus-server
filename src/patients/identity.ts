import { createHash } from 'node:crypto';
import { activeIdentityLinks, canonicalPatientId, linkedPatientIds, PatientIdentityEvent, SCHEMA_VERSION, type Patient } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { fromRow, insertRecord, findRecord } from '../db/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { authorizeStaff } from '../auth/staffAuthorization.ts';

const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
export type IdentityAction = { patientId: string; otherPatientId: string; outcome: 'linked' | 'distinct' | 'unlinked' };
export const eventsForFacility = async (sql: Sql | Tx, facilityId: string): Promise<PatientIdentityEvent[]> =>
  (await sql`SELECT * FROM patient_identity_events WHERE facility_id = ${facilityId} ORDER BY revision`).map((row) => fromRow<PatientIdentityEvent>('patient_identity_event', row));

export const previewIdentity = async (sql: Sql | Tx, facilityId: string, action: IdentityAction) => {
  const events = await eventsForFacility(sql, facilityId);
  const ids = [...new Set([...linkedPatientIds(action.patientId, events), ...linkedPatientIds(action.otherPatientId, events)])].sort();
  const patients = (await sql`SELECT * FROM patients WHERE facility_id = ${facilityId} AND id IN ${sql(ids)} ORDER BY id`).map((row) => fromRow<Patient>('patient', row));
  if (patients.length !== ids.length) throw conflict('Both patients and their linked records must have synchronised to this facility first');
  const [held] = await sql`SELECT id FROM sync_rejections WHERE facility_id = ${facilityId}
    AND entity_type = 'patient' AND entity_id IN ${sql(ids)} AND operation = 'put'
    AND category = 'conflict' AND resolved_on IS NULL LIMIT 1`;
  if (held) throw conflict('A patient-ID collision is awaiting reconciliation. Resolve that collision in Sync before linking these identities');
  const canonical = canonicalPatientId(action.patientId, events);
  const other = canonicalPatientId(action.otherPatientId, events);
  if (action.patientId === action.otherPatientId) throw conflict('Choose two different patient records');
  if (action.outcome === 'linked' && canonical === other) throw conflict('These records are already linked');
  if (action.outcome === 'distinct' && canonical === other) throw conflict('Remove the mistaken link before marking the records as different people');
  if (action.outcome === 'unlinked' && !activeIdentityLinks(events).has(action.otherPatientId)) throw conflict('Select an active linked ID to remove');
  if (action.outcome === 'unlinked' && canonical !== other) throw conflict('This ID is not linked to the selected patient');
  const summaries = await Promise.all(patients.map(async (patient) => {
    const [counts] = await sql`SELECT
      (SELECT count(*)::int FROM encounters WHERE facility_id = ${facilityId} AND patient_id = ${patient.id}) AS encounters,
      (SELECT count(*)::int FROM appointments WHERE facility_id = ${facilityId} AND patient_id = ${patient.id}) AS appointments,
      (SELECT count(*)::int FROM charges WHERE facility_id = ${facilityId} AND patient_id = ${patient.id}) AS charges,
      (SELECT count(*)::int FROM payments WHERE facility_id = ${facilityId} AND patient_id = ${patient.id}) AS payments`;
    return { patient, counts };
  }));
  const revision = createHash('sha256').update(JSON.stringify({ action, lastEvent: events.filter((e) => ['linked', 'distinct', 'unlinked'].includes(e.outcome)).at(-1)?.revision ?? 0, summaries })).digest('hex');
  return { revision, canonicalPatientId: canonical, otherRootId: other, records: summaries,
    retainedIds: linkedPatientIds(action.patientId, events), otherIds: linkedPatientIds(action.otherPatientId, events),
    warning: 'Original clinical records, patient details, charges and payments keep their IDs and authorship. Linking does not cancel duplicate fees. Review those obligations separately.' };
};

export const confirmIdentity = async (sql: Sql, who: { facilityId: string; deviceId: string; actorStaffId: string }, body: IdentityAction & { reason: string; revision: string; requestId: string }) =>
  sql.begin(async (tx) => {
    await tx`SELECT id FROM facilities WHERE id = ${who.facilityId} FOR UPDATE`;
    if ('denial' in await authorizeStaff(tx, who.facilityId, who.actorStaffId, 'patient_identity:resolve')) throw Object.assign(new Error('Your account cannot resolve patient identities'), { statusCode: 403 });
    const id = `patient_identity_event:${body.requestId}`;
    const existing = await findRecord<PatientIdentityEvent>(tx, 'patient_identity_event', id);
    if (existing) {
      if (existing.facilityId !== who.facilityId || existing.createdBy !== who.actorStaffId || existing.outcome !== body.outcome || existing.reason !== body.reason || existing.patientId !== body.patientId || existing.otherPatientId !== body.otherPatientId) throw conflict('This request was already used for another identity decision');
      return existing;
    }
    const preview = await previewIdentity(tx, who.facilityId, { patientId: body.patientId, otherPatientId: body.otherPatientId, outcome: body.outcome });
    if (preview.revision !== body.revision) throw conflict('Patient records changed after the preview. Review the updated records before confirming');
    // Link roots only, so two groups cannot create a cycle. The selected first
    // patient must be its root, keeping request replay comparisons unambiguous.
    if (body.outcome === 'linked' && (preview.canonicalPatientId !== body.patientId || preview.otherRootId !== body.otherPatientId)) throw conflict('Choose the primary record of each linked group before linking them');
    await insertRecord(tx, 'patient_identity_event', {
      id, type: 'patient_identity_event', facilityId: who.facilityId, deviceId: who.deviceId,
      schemaVersion: SCHEMA_VERSION, createdBy: who.actorStaffId, createdOn: new Date().toISOString(),
      patientId: body.patientId, otherPatientId: body.otherPatientId, outcome: body.outcome, reason: body.reason,
    });
    await recordAuditEvent(tx, { ...who, action: 'create', entityType: 'patient_identity_event', entityId: id, metadata: { outcome: body.outcome, patientId: body.patientId, otherPatientId: body.otherPatientId } });
    return (await findRecord<PatientIdentityEvent>(tx, 'patient_identity_event', id))!;
  });
