import { contactChangeProblem, type PatientContact } from '#shared';
import type { Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';

/**
 * What a contact change's shape can't say. Devices upload only staff changes; a patient's own change is written
 * by the server from the patient's link. Each patient has one chain of records, and only the patient can start
 * a channel they stopped (see `contactChangeProblem`).
 */
export const contactUploadIssues = async (tx: Tx, record: PatientContact): Promise<string[]> => {
  if (record.source !== 'staff') {
    return ['Only the patient can record their own choice'];
  }

  if (!record.replaces) {
    const [existing] =
      await tx`SELECT id FROM patient_contacts WHERE facility_id = ${record.facilityId} AND patient_id = ${record.patientId} LIMIT 1 FOR UPDATE`;

    return existing
      ? ["This patient's contact details were changed on another device. Review them and try again"]
      : [];
  }

  const previous = await findRecord<PatientContact>(tx, 'patient_contact', record.replaces);

  if (
    !previous ||
    previous.facilityId !== record.facilityId ||
    previous.patientId !== record.patientId
  ) {
    return ["A contact change must replace this patient's own contact details"];
  }

  const [later] =
    await tx`SELECT id FROM patient_contacts WHERE facility_id = ${record.facilityId} AND replaces = ${record.replaces} LIMIT 1`;

  if (later) {
    return [
      "This patient's contact details were changed on another device. Review them and try again",
    ];
  }

  const problem = contactChangeProblem(previous, record);

  return problem ? [problem] : [];
};
