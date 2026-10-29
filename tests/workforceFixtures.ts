import { randomUUID } from 'node:crypto';
import { Appointment, ClinicalAction, Patient, type UploadMutation, type FacilityRegistrationResult } from '#shared';
import type { Sql } from '../src/db/client.ts';
import { insertRecord } from '../src/db/records.ts';
import { applyGovernanceRecord, setWorkforcePolicy } from '../src/workforce/operations.ts';
import { addStaff, asDevice, clientId, envelopeFor, registerScratchFacility, signer, testApp, upload } from './postgres.ts';
export const versions = { facilityContractVersion: 1, schemaVersion: 4, policyVersion: 10 } as const;
export const put = (record: Record<string, unknown>, precondition?: {
  expectedPreviousId?: string | null;
  expectedRevision?: number;
}): UploadMutation => ({
  clientId: clientId(), op: 'put', table: record.type as UploadMutation['table'], id: record.id as string, data: record, ...precondition,
});
export const setupWorkforce = async (sql: Sql) => {
  const facility = await registerScratchFacility(sql), app = testApp(sql), worker = await addStaff(sql, facility, { role: 'nurse' });
  const env = envelopeFor(facility), now = Date.now(), begins = new Date(now - 3600000).toISOString(), ends = new Date(now + 3 * 86400000).toISOString();
  const uid = randomUUID();
  const unit = { ...env, type: 'unit', id: `unit:${uid}`, unitId: `legacy-alias:${uid}`, name: 'Outpatient', kind: 'unit', revision: 1, active: true };
  const location = { ...env, type: 'location', id: `location:${uid}`, name: 'Consulting room', kind: 'room', unitId: unit.unitId, capacity: 1, revision: 1, active: true };
  const definition = { ...env, type: 'service_definition', id: `definition:${uid}`, name: 'Consultation', category: 'consultation', concept: { system: 'urn:geneus:synthetic', code: 'consult', label: 'Synthetic consultation' }, active: true, orderable: false, revision: 1 };
  const offering = { ...env, type: 'service_offering', id: `offering:${uid}`, name: 'Outpatient consultation', serviceDefinitionId: definition.id, unitId: unit.id, locationIds: [location.id], delivery: 'physical', requiredActions: ['assess'], intakePolicy: 'both', timeZone: 'Africa/Lagos', configuration: 'active', resourceReadiness: 'unassessed', revision: 1 };
  const send = (mutations: UploadMutation[]) => upload(app, facility.device.credential, { ...versions, transactionId: clientId(), mutations });
  const configured = await send([put(offering), put(location), put(definition), put(unit)]);
  if (configured.rejected.length)
    throw new Error(`Fixture configuration refused: ${JSON.stringify(configured.rejected)}`);
  const bootstrap = {
    ...env, type: 'clinical_authority_bootstrap', id: `bootstrap:${uid}:v1`, bootstrapId: `bootstrap:${uid}`, version: 1, createdBy: 'system', staffId: facility.admin.id,
    decision: 'approve', scopes: [{ kind: 'facility', actions: ClinicalAction.options }], startsAt: begins, endsAt: ends, governanceReference: 'synthetic:governance-authorization', authorizedBy: 'synthetic:operator', reason: 'Audited synthetic clinical reviewer'
  };
  await applyGovernanceRecord(sql, signer, bootstrap, 'synthetic-test-operator');
  const profile = { ...env, type: 'practitioner_profile', id: `profile:${uid}`, staffId: worker.id, profession: { system: 'urn:geneus:synthetic-profession', code: 'nurse', label: 'Synthetic nurse' }, specialties: [], active: true, revision: 1 };
  const profiled = await send([put(profile)]);
  if (profiled.rejected.length)
    throw new Error('Fixture professional profile was refused');
  const credential = { ...env, type: 'credential', id: `credential:${uid}:v1`, credentialId: `credential:${uid}`, version: 1, staffId: worker.id, kind: 'registration', issuer: 'Synthetic issuer', label: 'Synthetic evidence', evidenceReference: 'synthetic:evidence', timeZone: 'Africa/Lagos', verification: 'verified', checkedBy: facility.admin.id, checkedOn: env.createdOn };
  const decision = {
    ...env, type: 'capability_decision', id: `capability:${uid}:v1`, capabilityId: `capability:${uid}`, version: 1, staffId: worker.id,
    scope: { kind: 'offerings', offeringIds: [offering.id], actions: ['assess', 'diagnose', 'prescribe', 'record_result', 'dispense', 'administer'] }, startsAt: begins, endsAt: ends, decision: 'approve', credentialRevisionIds: [credential.id], reason: 'Independent synthetic approval'
  };
  const approved = await send([put(decision, { expectedPreviousId: null }), put(credential, { expectedPreviousId: null })]);
  if (approved.rejected.length)
    throw new Error(`Fixture approval refused: ${JSON.stringify(approved.rejected)}`);
  const assignment = { ...env, type: 'staff_assignment', id: `assignment:${uid}:v1`, assignmentId: `assignment:${uid}`, version: 1, staffId: worker.id, offeringId: offering.id, locationIds: [location.id], startsAt: begins, endsAt: ends, duty: 'member', requiredActions: ['assess'], status: 'active', temporaryCover: false };
  const session = {
    ...env, type: 'service_session', id: `session:${uid}:v1`, sessionId: `session:${uid}`, version: 1, offeringId: offering.id,
    startsAt: new Date(now + 3600000).toISOString(), endsAt: new Date(now + 7200000).toISOString(), timeZone: 'Africa/Lagos', status: 'published',
    participants: [{ assignmentId: assignment.assignmentId, staffId: worker.id, commitment: 'exclusive' }], resources: [{ locationId: location.id, mode: 'pooled', units: 1 }], rosterShiftIds: [], maxAppointments: 5
  };
  const scheduled = await send([put(session, { expectedPreviousId: null }), put(assignment, { expectedPreviousId: null })]);
  if (scheduled.rejected.length)
    throw new Error(`Fixture scheduling refused: ${JSON.stringify(scheduled.rejected)}`);
  const patientId = `${facility.facility.code}-000001-A1`;
  await insertRecord(sql, 'patient', Patient.parse({ ...env, id: patientId, type: 'patient', patientId, fullName: 'Synthetic patient', address: 'Synthetic address', sex: 'female', ageYears: 30 }));
  const booking = () => Appointment.parse({
    ...env, id: `appointment:${randomUUID()}`, type: 'appointment', patientId, reason: 'Synthetic consultation', status: 'scheduled', scheduledFor: session.startsAt,
    allocation: { offeringId: offering.id, sessionId: session.sessionId, assignmentId: assignment.assignmentId, staffId: worker.id, endsAt: new Date(now + 5400000).toISOString(), locations: [{ locationId: location.id, units: 1 }] }
  });
  const enable = async () => {
    const handshake = await app.inject({ method: 'POST', url: '/sync/token', headers: asDevice(facility.device.credential), payload: { ...versions, pendingMutationCount: 0 } });
    if (handshake.statusCode !== 200)
      throw new Error('Fixture handshake failed');
    const effective = Date.now();
    const command = {
      facilityId: facility.facility.id, deviceId: facility.device.deviceId, operator: 'synthetic-test-operator', timeZone: 'Africa/Lagos',
      policy: { contractVersion: 1, schemaVersion: 4, policyVersion: 10, revision: 1, mode: 'enforced', effectiveOn: new Date(effective).toISOString(), governanceReference: 'synthetic:reviewed-cutover' }
    };
    await setWorkforcePolicy(sql, signer, command, effective);
    return command;
  };
  return { facility, app, worker, unit, location, definition, offering, bootstrap, credential, decision, assignment, session, patientId, booking, send, enable, env, now };
};
export const envelopeForOther = (facility: FacilityRegistrationResult, record: Record<string, unknown>) => ({ ...record, ...envelopeFor(facility), id: `other:${randomUUID()}` });
