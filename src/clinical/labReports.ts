import { labPatientFacts, labReportIssues, type EncounterEntry, type InvestigationItem, type LabReport, type Patient, type ResultTemplate } from '#shared';
import type { Tx } from '../db/client.ts';
import { findRecord, fromRow } from '../db/records.ts';

/**
 * A structured result is checked against the template revision it names, as this
 * facility saved it, and against the patient record on the day it is published —
 * the same shared checks the device ran before saving. Images must already be
 * uploaded, unchanged.
 */
export const labReportUploadIssues = async (tx: Tx, entry: EncounterEntry, report: LabReport, results: readonly { test: string; result: string; orderItemId?: string }[]): Promise<string[]> => {
  const patient = await findRecord<Patient>(tx, 'patient', entry.patientId);
  if (!patient || patient.facilityId !== entry.facilityId) return ['A structured result must belong to a patient of this facility'];
  const [order] = await tx`SELECT * FROM encounter_entries WHERE facility_id = ${entry.facilityId} AND encounter_id = ${entry.encounterId} AND step = 'lab_order' ORDER BY created_on DESC, id DESC LIMIT 1`;
  const items = order ? (fromRow<EncounterEntry>('encounter_entry', order).values.items as InvestigationItem[] | undefined) ?? [] : [];
  const templates = new Map<string, ResultTemplate>();
  for (const { template } of report.items) {
    if (!template || templates.has(`${template.id}#${template.revision}`)) continue;
    const [version] = await tx<{ snapshot: Record<string, unknown> }[]>`SELECT snapshot FROM result_template_versions WHERE facility_id = ${entry.facilityId} AND source_id = ${template.id} AND revision = ${template.revision}`;
    if (version) templates.set(`${template.id}#${template.revision}`, fromRow<ResultTemplate>('result_template', version.snapshot));
  }
  const issues = labReportIssues(results, report, {
    facts: labPatientFacts(patient, entry.createdOn),
    template: (id, revision) => templates.get(`${id}#${revision}`),
    serviceDefinitionFor: (orderItemId) => items.find((item) => item.id === orderItemId)?.serviceDefinitionId,
  });
  if (issues.length) return issues;
  for (const value of report.items.flatMap((item) => item.values)) {
    if (value.kind !== 'images') continue;
    for (const file of value.files) {
      const [stored] = await tx`SELECT sha256, mime_type, byte_size FROM document_files WHERE facility_id = ${entry.facilityId} AND id = ${file.id}`;
      if (!stored || stored.sha256 !== file.sha256 || stored.mime_type !== file.mimeType || Number(stored.byte_size) !== file.byteSize) return [`${file.fileName} must be uploaded before the result is published`];
    }
  }
  return [];
};
