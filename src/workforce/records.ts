import type { AnyDocument, DocType, FacilityRecords, Appointment, AppointmentReservation, ServiceSession } from '#shared';
import { currentFacilityRevisions, reservationMatchesAppointment } from '#shared';
import { fromRow, TABLE_FOR } from '../db/records.ts';
import type { Sql, Tx } from '../db/client.ts';
export type DocumentOf<T extends DocType> = Extract<AnyDocument, {
  type: T;
}>;
export const recordsInFacility = async <T extends DocType>(sql: Sql | Tx, facilityId: string, type: T): Promise<DocumentOf<T>[]> => {
  const table: string = TABLE_FOR[type];
  return (await sql`SELECT * FROM ${sql(table)} WHERE facility_id = ${facilityId}`).map((row) => fromRow<DocumentOf<T>>(type, row));
};
export const loadWorkforce = async (tx: Sql | Tx, facilityId: string): Promise<FacilityRecords> => {
  const [units, locations, staff, definitions, offerings, assignments, sessions, credentials] = await Promise.all([
    recordsInFacility(tx, facilityId, 'unit'), recordsInFacility(tx, facilityId, 'location'), recordsInFacility(tx, facilityId, 'staff'),
    recordsInFacility(tx, facilityId, 'service_definition'), recordsInFacility(tx, facilityId, 'service_offering'),
    recordsInFacility(tx, facilityId, 'staff_assignment'), recordsInFacility(tx, facilityId, 'service_session'), recordsInFacility(tx, facilityId, 'credential'),
  ]);
  return { units, locations, staff, definitions, offerings, assignments, sessions, credentials };
};
/** Only current accepted allocations consume capacity. Proposed/refused local copies are not reservations. */
export const acceptedAppointments = async (tx: Sql | Tx, facilityId: string, now: number): Promise<Appointment[]> => {
  const rows = await tx`SELECT a.* FROM appointments a JOIN appointment_reservations r
    ON r.facility_id=a.facility_id AND r.appointment_id=a.id
    WHERE a.facility_id=${facilityId} AND r.status='accepted'
      AND NOT EXISTS(SELECT 1 FROM appointment_reservations newer WHERE newer.facility_id=r.facility_id AND newer.appointment_id=r.appointment_id AND newer.revision>r.revision)
      AND (a.allocation->>'endsAt')::timestamptz >= ${new Date(now).toISOString()}`;
  const reservations = await tx`SELECT r.* FROM appointment_reservations r WHERE r.facility_id=${facilityId}
    AND NOT EXISTS(SELECT 1 FROM appointment_reservations n WHERE n.facility_id=r.facility_id AND n.appointment_id=r.appointment_id AND n.revision>r.revision)`;
  const current = reservations.map((r) => fromRow<AppointmentReservation>('appointment_reservation', r));
  return rows.map((r) => fromRow<Appointment>('appointment', r)).filter((a) => current.some((r) => reservationMatchesAppointment(r, a)));
};
/** Historical children of an ongoing session still count toward its total throughput limit. */
export const sessionAppointments = async (tx: Sql | Tx, facilityId: string, sessions: readonly ServiceSession[]): Promise<Appointment[]> => {
  const ids = currentFacilityRevisions(sessions).map((s) => s.sessionId);
  if (!ids.length)
    return [];
  const rows = await tx`SELECT a.* FROM appointments a WHERE a.facility_id=${facilityId} AND a.allocation->>'sessionId' IN ${tx(ids)}`;
  const records = rows.map((r) => fromRow<Appointment>('appointment', r));
  const reservations = await tx`SELECT r.* FROM appointment_reservations r WHERE r.facility_id=${facilityId}
    AND NOT EXISTS(SELECT 1 FROM appointment_reservations n WHERE n.facility_id=r.facility_id AND n.appointment_id=r.appointment_id AND n.revision>r.revision)`;
  return records.filter((a) => reservations.some((r) => reservationMatchesAppointment(fromRow<AppointmentReservation>('appointment_reservation', r), a)));
};
