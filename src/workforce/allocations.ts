import { randomUUID } from 'node:crypto';
import { AppointmentReservation, appointmentAllocationFingerprint, appointmentAllocationIssues, effectiveFacilityRevisions, type Appointment } from '#shared';
import type { Tx } from '../db/client.ts';
import { insertRecord } from '../db/records.ts';
import { acceptedAppointments, loadWorkforce, sessionAppointments } from './records.ts';
import type { WorkforceRefusal } from './validation.ts';
/** Called while holding the same facility lock used by session publication, staff changes and retirement. */
export const allocationRefusal = async (tx: Tx, appointment: Appointment, now: number): Promise<WorkforceRefusal | undefined> => {
  if (!appointment.allocation || ['cancelled', 'no_show'].includes(appointment.attendance ?? 'booked'))
    return undefined;
  const data = await loadWorkforce(tx, appointment.facilityId);
  const peers = [...await acceptedAppointments(tx, appointment.facilityId, now), ...await sessionAppointments(tx, appointment.facilityId, data.sessions)];
  const unique = [...new Map(peers.map((a) => [a.id, a])).values()];
  const issues = appointmentAllocationIssues(appointment, data, unique);
  const allocation = appointment.allocation;
  if (allocation.assignmentId && appointment.scheduledFor) {
    const assignment = effectiveFacilityRevisions(data.assignments, Date.parse(appointment.scheduledFor)).find((a) => a.assignmentId === allocation.assignmentId);
    if (assignment?.locationIds.length && allocation.locations.some((r) => !assignment.locationIds.includes(r.locationId)))
      issues.push('Named practitioner is not assigned to the chosen booking location');
  }
  return issues.length ? { category: 'conflict', reason: issues.join('; ') } : undefined;
};
export const recordReservation = async (tx: Tx, appointment: Appointment, now: number): Promise<void> => {
  const fingerprint = appointmentAllocationFingerprint(appointment);
  if (!fingerprint || !appointment.allocation)
    return;
  const [previous] = await tx<{
    revision: number;
  }[]> `SELECT revision FROM appointment_reservations WHERE facility_id=${appointment.facilityId} AND appointment_id=${appointment.id} ORDER BY revision DESC LIMIT 1`;
  const released = ['cancelled', 'no_show'].includes(appointment.attendance ?? 'booked');
  await insertRecord(tx, 'appointment_reservation', AppointmentReservation.parse({
    id: `appointment_reservation:${randomUUID()}`, type: 'appointment_reservation', facilityId: appointment.facilityId, createdBy: 'system',
    createdOn: new Date(now).toISOString(), deviceId: appointment.deviceId, appointmentId: appointment.id, patientId: appointment.patientId,
    offeringId: appointment.allocation.offeringId, allocationFingerprint: fingerprint, revision: (previous?.revision ?? 0) + 1,
    status: released ? 'released' : 'accepted', reason: released ? 'Booking cancelled or marked no-show' : undefined,
  }));
};
