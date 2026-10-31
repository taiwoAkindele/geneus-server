import { bedReadyIssues, inpatientIssues, inpatientBedStates, type BedReadyEvent, type InpatientEvent, type Encounter, type EncounterEntry, type Location, type Unit, type PatientIdentityEvent } from '#shared';
import type { Tx } from '../db/client.ts';
import { fromRow } from '../db/records.ts';

/** Upload already holds the facility row lock, shared with all location/configuration changes. */
export const inpatientRecords = async (tx: Tx, facilityId: string) => {
  const [events, ready, locations, units, identities] = await Promise.all([
    tx`SELECT * FROM inpatient_events WHERE facility_id=${facilityId}`,
    tx`SELECT * FROM bed_ready_events WHERE facility_id=${facilityId}`,
    tx`SELECT * FROM locations WHERE facility_id=${facilityId}`,
    tx`SELECT * FROM units WHERE facility_id=${facilityId}`,
    tx`SELECT * FROM patient_identity_events WHERE facility_id=${facilityId}`,
  ]);
  return {
    events: events.map((row) => fromRow<InpatientEvent>('inpatient_event', row)),
    ready: ready.map((row) => fromRow<BedReadyEvent>('bed_ready_event', row)),
    locations: locations.map((row) => fromRow<Location>('location', row)),
    units: units.map((row) => fromRow<Unit>('unit', row)),
    identities: identities.map((row) => fromRow<PatientIdentityEvent>('patient_identity_event', row)),
  };
};
export const inpatientUploadIssues = async (tx: Tx, event: InpatientEvent | BedReadyEvent): Promise<string[]> => {
  const data = await inpatientRecords(tx, event.facilityId);
  if (event.type === 'bed_ready_event') return bedReadyIssues(event, data);
  const [encounters, entries] = await Promise.all([
    tx`SELECT * FROM encounters WHERE facility_id=${event.facilityId} AND id=${event.encounterId}`,
    tx`SELECT * FROM encounter_entries WHERE facility_id=${event.facilityId} AND encounter_id=${event.encounterId}`,
  ]);
  return inpatientIssues(event, { ...data, encounters: encounters.map((row) => fromRow<Encounter>('encounter', row)), entries: entries.map((row) => fromRow<EncounterEntry>('encounter_entry', row)) });
};
/** A live/unclean bed cannot be retired, reparented or renamed out from under a stay. */
export const inpatientLocationIssues = async (tx: Tx, before: Location | Unit, after: Location | Unit): Promise<string[]> => {
  const changed = before.type === 'location' && after.type === 'location'
    ? before.active !== after.active || before.parentId !== after.parentId || before.kind !== after.kind || before.unitId !== after.unitId
    : before.active !== after.active;
  if (!changed) return [];
  const data = await inpatientRecords(tx, before.facilityId);
  if (before.type === 'unit') return data.events.some((event) => event.receivingUnitId === before.id && !data.events.some((next) => next.previousId === event.id) && !['discharge','cancel'].includes(event.action)) ? ['This receiving team has active admissions; transfer or finish them before changing its availability'] : [];
  const descendants = new Set([before.id]);
  let found = true;
  while (found) { found = false; for (const location of data.locations) if (location.parentId && descendants.has(location.parentId) && !descendants.has(location.id)) { descendants.add(location.id); found = true; } }
  const states = inpatientBedStates(data.events, data.ready);
  return data.locations.some((location) => location.kind === 'bed' && descendants.has(location.id) && states.has(location.id)) ? ['This location contains a reserved, occupied or unclean bed; finish that work before changing the location'] : [];
};
