import { clinicalRecordActions, CLINICAL_ACTION_PERMISSIONS, wardEntryIssues, wardEventIssues, wardSessionIssues, wardReadinessIssues, type Permission, type Encounter, type EncounterEntry, type InpatientEvent, type WardCareEvent, type WardRecords } from '#shared';
import type { Tx } from '../db/client.ts';
import { fromRow, findRecord } from '../db/records.ts';

export const wardRecords = async (tx: Tx, facilityId: string, admissionId: string): Promise<WardRecords> => {
  const [admissions, encounters, entries, events] = await Promise.all([
    tx`SELECT * FROM inpatient_events WHERE facility_id=${facilityId} AND admission_id=${admissionId}`,
    tx`SELECT * FROM encounters WHERE facility_id=${facilityId} AND (inpatient_context->>'admissionId'=${admissionId} OR id IN (SELECT encounter_id FROM inpatient_events WHERE facility_id=${facilityId} AND admission_id=${admissionId}))`,
    tx`SELECT * FROM encounter_entries WHERE facility_id=${facilityId} AND encounter_id IN (SELECT id FROM encounters WHERE facility_id=${facilityId} AND (inpatient_context->>'admissionId'=${admissionId} OR id IN (SELECT encounter_id FROM inpatient_events WHERE facility_id=${facilityId} AND admission_id=${admissionId}))) ORDER BY created_on,id`,
    tx`SELECT * FROM ward_care_events WHERE facility_id=${facilityId} AND admission_id=${admissionId}`,
  ]);
  return { admissions: admissions.map((r) => fromRow<InpatientEvent>('inpatient_event', r)), encounters: encounters.map((r) => fromRow<Encounter>('encounter', r)), entries: entries.map((r) => fromRow<EncounterEntry>('encounter_entry', r)), events: events.map((r) => fromRow<WardCareEvent>('ward_care_event', r)) };
};

export const wardUploadIssues = async (tx: Tx, record: Encounter | EncounterEntry | WardCareEvent, allowLate: boolean, permissions: readonly Permission[]): Promise<string[]> => {
  const session = record.type === 'encounter' ? record : await findRecord<Encounter>(tx, 'encounter', record.encounterId);
  const admissionId = session?.inpatientContext?.admissionId;
  if (!admissionId) return record.type === 'ward_care_event' || (record.type === 'encounter_entry' && record.admissionId) ? ['The source is not an inpatient care activity'] : [];
  const data = await wardRecords(tx, record.facilityId, admissionId);
  // Accept the context of offline care after a competing departure, but no new
  // clinical entry can pass closure without its own exact independent review.
  if (record.type === 'encounter') return wardSessionIssues(record, data, true);
  const original = record.type === 'encounter_entry' && record.amends ? data.entries.find((e) => e.id === record.amends) : undefined;
  if (record.type === 'encounter_entry' && record.step === 'amendment' && !original) return ['Choose the original care entry to correct'];
  if (!allowLate && clinicalRecordActions(record, original).some((action) => !permissions.includes(CLINICAL_ACTION_PERMISSIONS[action]))) return ['Your assigned actions do not permit this clinical activity'];
  if (!session) return ['The care activity has not been accepted'];
  if (record.type === 'encounter_entry') return wardEntryIssues(session, record, data, allowLate || ['lab_results','result_review','dispense','amendment'].includes(record.step));
  return wardEventIssues(record, data, allowLate);
};
export const dischargeReadinessIssues = async (tx: Tx, event: InpatientEvent) => {
  const data = await wardRecords(tx, event.facilityId, event.admissionId);
  const issues = wardReadinessIssues(event, data.events, data.encounters.some((e) => e.inpatientContext));
  if (event.dischargeSummaryId) {
    const summary = data.events.find((e) => e.id === event.dischargeSummaryId);
    if (!summary || summary.values.kind !== 'discharge') issues.push('Choose this stay’s signed discharge summary');
  }
  return issues;
};
