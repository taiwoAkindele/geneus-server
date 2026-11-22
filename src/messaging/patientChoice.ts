import { randomUUID } from 'node:crypto';
import {
  SCHEMA_VERSION,
  contactChangeProblem,
  currentPatientContact,
  type PatientContact,
} from '#shared';
import type { Sql } from '../db/client.ts';
import { fromRow, insertRecord } from '../db/records.ts';

type Row = Record<string, unknown>;

export const patientContactNow = async (
  sql: Sql,
  facilityId: string,
  patientId: string,
): Promise<PatientContact | undefined> =>
  currentPatientContact(
    (
      await sql<
        Row[]
      >`SELECT * FROM patient_contacts WHERE facility_id = ${facilityId} AND patient_id = ${patientId}`
    ).map((r) => fromRow<PatientContact>('patient_contact', r)),
    patientId,
  );

/**
 * The patient stops or restarts a channel from their link. Written by the server as the patient's own change
 * (source 'patient'), replacing the current record, so it syncs to the hospital's devices like any other.
 * Returns false when nothing changed.
 */
export const recordPatientChoice = async (
  sql: Sql,
  facilityId: string,
  patientId: string,
  channel: 'sms' | 'email',
  choice: 'stop' | 'start',
): Promise<boolean> =>
  sql.begin(async (tx) => {
    // One change at a time per patient: the patient row is the lock, as for other patient-scoped chains.
    await tx`SELECT id FROM patients WHERE facility_id = ${facilityId} AND id = ${patientId} FOR UPDATE`;
    const previous = currentPatientContact(
      (
        await tx<
          Row[]
        >`SELECT * FROM patient_contacts WHERE facility_id = ${facilityId} AND patient_id = ${patientId}`
      ).map((r) => fromRow<PatientContact>('patient_contact', r)),
      patientId,
    );
    const stopped = choice === 'stop';
    if (
      (channel === 'sms' ? previous?.smsStopped : previous?.emailStopped) === stopped ||
      (!previous && !stopped)
    ) {
      return false;
    }
    const [device] = await tx<
      { id: string }[]
    >`SELECT id FROM devices WHERE facility_id = ${facilityId} ORDER BY id LIMIT 1`;
    if (!device) {
      throw new Error('The hospital has no enrolled device');
    }
    const next: PatientContact = {
      id: `patient_contact:${randomUUID()}`,
      type: 'patient_contact',
      facilityId,
      schemaVersion: SCHEMA_VERSION,
      createdBy: 'patient',
      createdOn: new Date().toISOString(),
      deviceId: device.id,
      patientId,
      email: previous?.email,
      source: 'patient',
      smsStopped: channel === 'sms' ? stopped : (previous?.smsStopped ?? false),
      emailStopped: channel === 'email' ? stopped : (previous?.emailStopped ?? false),
      ...(previous ? { replaces: previous.id } : {}),
    };
    const problem = contactChangeProblem(previous, next);
    if (problem) {
      throw new Error(problem);
    }
    await insertRecord(tx, 'patient_contact', next);
    return true;
  });
