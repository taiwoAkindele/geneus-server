import { createHash, randomUUID } from 'node:crypto';
import {
  CLAIM_EXPORT_FIELDS, DEFAULT_CLAIM_COLUMNS, SubmissionProfile, currentCompletions, effectiveEncounterEntries, serviceFulfillment,
  type AuthorizationInput, type Charge, type ClaimAcknowledgementInput, type ClaimAuthorization, type ClaimExportField, type ClaimIssue, type ClaimLineView,
  type ClaimState, type ClaimSubmissionInput, type ClaimView, type EncounterEntry, type Facility, type ImportTemplate, type Patient, type ServiceCompletion,
} from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord, fromRow } from '../db/records.ts';
import { chargesById } from './coverage.ts';

type Row = Record<string, unknown>;
type Db = Sql | Tx;

export class ClaimRefusal extends Error {
  readonly code: string; readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) { super(message); this.name = 'ClaimRefusal'; this.code = code; this.details = details; }
}

/* ---------------- Authorizations and referrals ---------------- */

const authorizationRow = (r: Row): ClaimAuthorization => ({
  id: r.id as string, patientId: r.patient_id as string, payerId: r.payer_id as string, kind: r.kind as ClaimAuthorization['kind'], status: r.status as ClaimAuthorization['status'],
  ...(r.reference ? { reference: r.reference as string } : {}), validFrom: isoDay(r.valid_from), validTo: isoDay(r.valid_to),
  feeItemIds: r.fee_item_ids as string[], categories: r.categories as ClaimAuthorization['categories'], ...(r.encounter_id ? { encounterId: r.encounter_id as string } : {}),
  obtainedVia: r.obtained_via as ClaimAuthorization['obtainedVia'], ...(r.referred_from ? { referredFrom: r.referred_from as string } : {}), ...(r.note ? { note: r.note as string } : {}),
  ...(r.evidence_document_id ? { evidenceDocumentId: r.evidence_document_id as string } : {}), ...(r.replaces ? { replaces: r.replaces as string } : {}),
  recordedBy: r.recorded_by as string, recordedOn: new Date(r.recorded_on as string).toISOString(),
});
const isoDay = (value: unknown) => value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : String(value).slice(0, 10);

export const listAuthorizations = async (sql: Db, facilityId: string, patientIds?: readonly string[]): Promise<ClaimAuthorization[]> => {
  const rows = patientIds ? await sql<Row[]>`SELECT * FROM insurance_authorizations WHERE facility_id = ${facilityId} AND patient_id = ANY(${patientIds as string[]}) ORDER BY recorded_on`
    : await sql<Row[]>`SELECT * FROM insurance_authorizations WHERE facility_id = ${facilityId} ORDER BY recorded_on DESC LIMIT 500`;
  const all = rows.map(authorizationRow);
  const replacedBy = new Map(all.filter((a) => a.replaces).map((a) => [a.replaces!, a.id]));
  return all.map((a) => replacedBy.has(a.id) ? { ...a, replacedBy: replacedBy.get(a.id)! } : a);
};

/** Records an authorization or referral as obtained. A change is a new record replacing the latest one. */
export const recordAuthorization = async (tx: Tx, facilityId: string, staffId: string, input: AuthorizationInput): Promise<ClaimAuthorization> => {
  const [payer] = await tx`SELECT id FROM payers WHERE facility_id = ${facilityId} AND id = ${input.payerId}`;
  if (!payer) throw new ClaimRefusal('unknown_payer', 'Choose a payer of this hospital');
  const patient = await findRecord<Patient>(tx, 'patient', input.patientId);
  if (!patient || patient.facilityId !== facilityId) throw new ClaimRefusal('unknown_patient', 'Choose a patient of this hospital');
  if (input.replaces) {
    const [previous] = await tx<Row[]>`SELECT patient_id, payer_id, kind FROM insurance_authorizations WHERE facility_id = ${facilityId} AND id = ${input.replaces} FOR UPDATE`;
    if (!previous || previous.patient_id !== input.patientId || previous.payer_id !== input.payerId || previous.kind !== input.kind) throw new ClaimRefusal('invalid_replaces', 'A change must replace the same patient\'s record of the same kind and payer');
    const [later] = await tx`SELECT 1 FROM insurance_authorizations WHERE facility_id = ${facilityId} AND replaces = ${input.replaces}`;
    if (later) throw new ClaimRefusal('already_replaced', 'This record was already changed. Review the current one');
  }
  if (input.evidenceDocumentId) {
    const [doc] = await tx`SELECT 1 FROM insurance_documents WHERE facility_id = ${facilityId} AND id = ${input.evidenceDocumentId} AND payer_id = ${input.payerId}`;
    if (!doc) throw new ClaimRefusal('unknown_document', 'Attach a document stored for this payer');
  }
  const id = `insurance_authorization:${randomUUID()}`;
  await tx`INSERT INTO insurance_authorizations (id, facility_id, patient_id, payer_id, kind, status, reference, valid_from, valid_to, fee_item_ids, categories, encounter_id, obtained_via, referred_from, note, evidence_document_id, replaces, recorded_by)
    VALUES (${id}, ${facilityId}, ${input.patientId}, ${input.payerId}, ${input.kind}, ${input.status}, ${input.reference ?? null}, ${input.validFrom}, ${input.validTo}, ${tx.json(input.feeItemIds)}, ${tx.json(input.categories)},
      ${input.encounterId ?? null}, ${input.obtainedVia}, ${input.referredFrom ?? null}, ${input.note ?? null}, ${input.evidenceDocumentId ?? null}, ${input.replaces ?? null}, ${staffId})`;
  return (await listAuthorizations(tx, facilityId, [input.patientId])).find((a) => a.id === id)!;
};

/* ---------------- Generation ---------------- */

type Candidate = { allocationId: string; chargeId: string; patientId: string; payerId: string; inputs: Row };

const episodeOf = (charge: Charge, admissions: Map<string, string>, serviceDate: string): { kind: ClaimView['episode']['kind']; key: string } => {
  const admission = charge.encounterId ? admissions.get(charge.encounterId) : undefined;
  if (admission) return { kind: 'admission', key: admission };
  if (charge.encounterId) return { kind: 'encounter', key: charge.encounterId };
  if (charge.appointmentId) return { kind: 'appointment', key: charge.appointmentId };
  return { kind: 'day', key: serviceDate };
};

const nextClaimNumber = async (tx: Tx, facilityId: string) => {
  const [{ n }] = await tx<{ n: number }[]>`SELECT COUNT(DISTINCT claim_number)::int AS n FROM insurance_claims WHERE facility_id = ${facilityId}`;
  return `CLM-${String(n + 1).padStart(6, '0')}`;
};
const event = (tx: Tx, facilityId: string, claimId: string, state: ClaimState, staffId: string, note?: string, ref?: string) =>
  tx`INSERT INTO insurance_claim_events (id, facility_id, claim_id, state, staff_id, note, ref) VALUES (${`claim_event:${randomUUID()}`}, ${facilityId}, ${claimId}, ${state}, ${staffId}, ${note ?? null}, ${ref ?? null})`;

/**
 * Builds claims from confirmed insurance splits the payer owes: paid per
 * service, a payer share above nothing, still the charge's current split, and
 * on no current claim line. Capitation and fully self-paid charges never
 * become claims. One claim per payer, patient and care episode (an admission,
 * else a visit, else a booking, else a day); a new charge joins the episode's
 * open draft, or starts a new claim when the earlier one has moved on.
 */
export const generateClaims = async (tx: Tx, facilityId: string, staffId: string, filter: { payerId?: string; from?: string; to?: string }) => {
  await tx`SELECT id FROM facilities WHERE id = ${facilityId} FOR UPDATE`;
  const rows = await tx<Row[]>`
    SELECT a.id AS allocation_id, a.charge_id, a.patient_id, a.payer_id, d.inputs
    FROM coverage_allocations a JOIN coverage_allocation_details d ON d.allocation_id = a.id AND d.facility_id = a.facility_id
    WHERE a.facility_id = ${facilityId} AND a.state = 'finalised' AND a.arrangement = 'per_service' AND d.payer_share_minor > 0
      AND NOT EXISTS (SELECT 1 FROM coverage_allocations later WHERE later.facility_id = a.facility_id AND later.supersedes = a.id)
      AND NOT EXISTS (SELECT 1 FROM insurance_claim_lines l WHERE l.facility_id = a.facility_id AND l.charge_id = a.charge_id AND l.current)
      AND (${filter.payerId ?? null}::text IS NULL OR a.payer_id = ${filter.payerId ?? null})
      AND (${filter.from ?? null}::text IS NULL OR d.inputs->>'serviceDate' >= ${filter.from ?? null})
      AND (${filter.to ?? null}::text IS NULL OR d.inputs->>'serviceDate' <= ${filter.to ?? null})
    ORDER BY d.inputs->>'serviceDate', a.charge_id
    LIMIT 5000`;
  const candidates: Candidate[] = rows.map((r) => ({ allocationId: r.allocation_id as string, chargeId: r.charge_id as string, patientId: r.patient_id as string, payerId: r.payer_id as string, inputs: r.inputs as Row }));
  if (!candidates.length) return { created: 0, extended: 0, lines: 0 };
  const charges = new Map((await chargesById(tx, facilityId, candidates.map((c) => c.chargeId))).map((c) => [c.id, c]));
  const encounterIds = [...new Set([...charges.values()].map((c) => c.encounterId).filter(Boolean))] as string[];
  const admissions = new Map((encounterIds.length ? await tx<{ id: string; ward_admission_id: string | null }[]>`SELECT id, ward_admission_id FROM encounters WHERE facility_id = ${facilityId} AND id = ANY(${encounterIds})` : [])
    .filter((e) => e.ward_admission_id).map((e) => [e.id, e.ward_admission_id!]));
  const groups = new Map<string, { candidates: Candidate[]; episode: ReturnType<typeof episodeOf>; coverId: string; currency: string }>();
  for (const c of candidates) {
    const charge = charges.get(c.chargeId)!;
    const episode = episodeOf(charge, admissions, c.inputs.serviceDate as string);
    const key = [c.payerId, c.patientId, episode.kind, episode.key].join('|');
    const group = groups.get(key) ?? { candidates: [], episode, coverId: (c.inputs.cover as { id: string }).id, currency: charge.currency };
    group.candidates.push(c); groups.set(key, group);
  }
  let created = 0, extended = 0, lines = 0;
  for (const group of groups.values()) {
    const first = group.candidates[0];
    const [open] = await tx<{ id: string }[]>`SELECT id FROM insurance_claims WHERE facility_id = ${facilityId} AND payer_id = ${first.payerId} AND patient_id = ${first.patientId}
      AND episode_kind = ${group.episode.kind} AND episode_key = ${group.episode.key} AND state = 'draft' AND superseded_by IS NULL AND supersedes IS NULL FOR UPDATE`;
    let claimId = open?.id;
    if (claimId) extended += 1;
    else {
      claimId = `insurance_claim:${randomUUID()}`;
      await tx`INSERT INTO insurance_claims (id, facility_id, claim_number, revision, payer_id, patient_id, cover_id, episode_kind, episode_key, currency, state, created_by)
        VALUES (${claimId}, ${facilityId}, ${await nextClaimNumber(tx, facilityId)}, 1, ${first.payerId}, ${first.patientId}, ${group.coverId}, ${group.episode.kind}, ${group.episode.key}, ${group.currency}, 'draft', ${staffId})`;
      await event(tx, facilityId, claimId, 'draft', staffId, 'Generated from confirmed insurance splits');
      created += 1;
    }
    for (const c of group.candidates) {
      await tx`INSERT INTO insurance_claim_lines (id, facility_id, claim_id, charge_id, allocation_id, contract_version_id) VALUES (${`claim_line:${randomUUID()}`}, ${facilityId}, ${claimId}, ${c.chargeId}, ${c.allocationId}, ${c.inputs.contractVersionId as string})`;
      lines += 1;
    }
  }
  return { created, extended, lines };
};

/* ---------------- Views and validation ---------------- */

const CODE_CATALOGUE_VERIFIED = false; // No verified ICD-10 catalogue yet: coded diagnoses cannot be validated (see the licensing investigation).

/** Builds full claim views — lines, evidence, authorizations, diagnoses and every issue — reading all records in bulk. */
export const claimViews = async (sql: Db, facilityId: string, claimRows: readonly Row[]): Promise<ClaimView[]> => {
  if (!claimRows.length) return [];
  const claimIds = claimRows.map((c) => c.id as string);
  const lineRows = await sql<Row[]>`SELECT l.*, d.inputs, d.payer_share_minor, d.patient_share_minor AS d_patient_share, d.list_price_minor FROM insurance_claim_lines l
    JOIN coverage_allocation_details d ON d.allocation_id = l.allocation_id AND d.facility_id = l.facility_id
    WHERE l.facility_id = ${facilityId} AND l.claim_id = ANY(${claimIds}) ORDER BY d.inputs->>'serviceDate', l.charge_id`;
  const chargeIds = [...new Set(lineRows.map((l) => l.charge_id as string))];
  const charges = new Map((await chargesById(sql, facilityId, chargeIds)).map((c) => [c.id, c]));
  const patientIds = [...new Set(claimRows.map((c) => c.patient_id as string))];
  const payerIds = [...new Set(claimRows.map((c) => c.payer_id as string))];
  const encounterIds = [...new Set([...charges.values()].map((c) => c.encounterId).filter(Boolean))] as string[];
  const appointmentIds = [...new Set([...charges.values()].map((c) => c.appointmentId).filter(Boolean))] as string[];
  const dispenseIds = [...new Set([...charges.values()].map((c) => c.dispenseEntryId).filter(Boolean))] as string[];
  const [currentAllocs, entryRows, apptEncounters, dispenseRows, completionRows, authorizations, profileRows, patients, attachmentRows, eventRows, batchRows] = await Promise.all([
    sql<{ id: string; charge_id: string }[]>`SELECT a.id, a.charge_id FROM coverage_allocations a WHERE a.facility_id = ${facilityId} AND a.charge_id = ANY(${chargeIds})
      AND NOT EXISTS (SELECT 1 FROM coverage_allocations later WHERE later.facility_id = a.facility_id AND later.supersedes = a.id)`,
    encounterIds.length ? sql<Row[]>`SELECT * FROM encounter_entries WHERE facility_id = ${facilityId} AND encounter_id = ANY(${encounterIds})` : Promise.resolve([] as Row[]),
    appointmentIds.length ? sql<{ id: string; appointment_id: string }[]>`SELECT id, appointment_id FROM encounters WHERE facility_id = ${facilityId} AND appointment_id = ANY(${appointmentIds})` : Promise.resolve([]),
    dispenseIds.length ? sql<Row[]>`SELECT * FROM encounter_entries WHERE facility_id = ${facilityId} AND id = ANY(${dispenseIds})` : Promise.resolve([] as Row[]),
    sql<Row[]>`SELECT * FROM service_completions WHERE facility_id = ${facilityId} AND charge_id = ANY(${chargeIds})`,
    listAuthorizations(sql, facilityId, patientIds),
    sql<{ payer_id: string; profile: unknown }[]>`SELECT payer_id, profile FROM payer_submission_profiles WHERE facility_id = ${facilityId} AND payer_id = ANY(${payerIds})`,
    Promise.all(patientIds.map((id) => findRecord<Patient>(sql, 'patient', id))),
    sql<Row[]>`SELECT a.claim_id, a.document_id, d.document_type, d.title FROM insurance_claim_attachments a JOIN insurance_documents d ON d.id = a.document_id WHERE a.facility_id = ${facilityId} AND a.claim_id = ANY(${claimIds})`,
    sql<Row[]>`SELECT * FROM insurance_claim_events WHERE facility_id = ${facilityId} AND claim_id = ANY(${claimIds}) ORDER BY at`,
    sql<Row[]>`SELECT id FROM insurance_claim_batches WHERE facility_id = ${facilityId}`,
  ]);
  void batchRows;
  // Visits found through their booking count as the charge's visit too.
  const apptEncounterIds = apptEncounters.map((e) => e.id).filter((id) => !encounterIds.includes(id));
  const moreEntries = apptEncounterIds.length ? await sql<Row[]>`SELECT * FROM encounter_entries WHERE facility_id = ${facilityId} AND encounter_id = ANY(${apptEncounterIds})` : [];
  const entries = [...entryRows, ...moreEntries].map((r) => fromRow<EncounterEntry>('encounter_entry', r));
  const byEncounter = new Map<string, EncounterEntry[]>();
  for (const e of entries) byEncounter.set(e.encounterId, [...(byEncounter.get(e.encounterId) ?? []), e]);
  const encounterForAppointment = new Map(apptEncounters.map((e) => [e.appointment_id, e.id]));
  const dispenses = new Map(dispenseRows.map((r) => { const e = fromRow<EncounterEntry>('encounter_entry', r); return [e.id, e] as const; }));
  const completions = currentCompletions(completionRows.map((r) => fromRow<ServiceCompletion>('service_completion', r)));
  const currentAllocation = new Map(currentAllocs.map((a) => [a.charge_id, a.id]));
  const profiles = new Map(profileRows.map((p) => [p.payer_id, SubmissionProfile.parse(p.profile)]));
  const names = new Map(patients.filter(Boolean).map((p) => [p!.id, p!.fullName]));
  const liveAuths = authorizations.filter((a) => !a.replacedBy);

  return claimRows.map((claim) => {
    const id = claim.id as string, payerId = claim.payer_id as string, patientId = claim.patient_id as string;
    const mine = lineRows.filter((l) => l.claim_id === id && (l.current || claim.superseded_by));
    const issues: ClaimIssue[] = [];
    const lines: ClaimLineView[] = mine.map((l) => {
      const charge = charges.get(l.charge_id as string)!;
      const inputs = l.inputs as Row;
      const serviceDate = inputs.serviceDate as string;
      const visitEncounter = charge.encounterId ?? (charge.appointmentId ? encounterForAppointment.get(charge.appointmentId) : undefined);
      const visitEntries = visitEncounter ? effectiveEncounterEntries(byEncounter.get(visitEncounter) ?? []) : [];
      const fulfillment = serviceFulfillment(charge, {
        results: charge.encounterId ? effectiveEncounterEntries(byEncounter.get(charge.encounterId) ?? []) : [],
        dispense: charge.dispenseEntryId ? dispenses.get(charge.dispenseEntryId) : undefined,
        visitEntries, completion: completions.get(charge.id),
      });
      if (fulfillment.kind === 'missing') issues.push({ code: 'fulfillment_missing', blocking: true, chargeId: charge.id, message: `${charge.description}: no record shows it was ${fulfillment.ordered ? 'performed or supplied' : 'done'}. Clinical staff can record it` });
      if (fulfillment.kind === 'not_done') issues.push({ code: 'not_performed', blocking: true, chargeId: charge.id, message: `${charge.description}: recorded as not done (${fulfillment.reason})` });
      if (currentAllocation.get(charge.id) !== l.allocation_id) issues.push({ code: 'allocation_superseded', blocking: true, chargeId: charge.id, message: `${charge.description}: the insurance split was corrected after this claim was made. Revise the claim` });
      const rule = inputs.rule as { approvalRequired?: boolean } | undefined;
      let authorization: ClaimLineView['authorization'];
      if (rule?.approvalRequired) {
        const relevant = liveAuths.filter((a) => a.kind === 'pre_authorization' && a.patientId === patientId && a.payerId === payerId && a.validFrom <= serviceDate && serviceDate <= a.validTo
          && (a.feeItemIds.includes(charge.feeItemId) || a.categories.includes(charge.category) || (Boolean(a.encounterId) && a.encounterId === charge.encounterId)));
        const approved = relevant.find((a) => a.status === 'approved');
        if (approved) authorization = { id: approved.id, reference: approved.reference, status: 'approved' };
        else if (relevant.some((a) => a.status === 'denied')) issues.push({ code: 'authorization_denied', blocking: true, chargeId: charge.id, message: `${charge.description}: the payer denied authorization` });
        else if (relevant.some((a) => a.status === 'requested')) issues.push({ code: 'authorization_pending', blocking: true, chargeId: charge.id, message: `${charge.description}: authorization was requested but not yet approved` });
        else issues.push({ code: 'authorization_missing', blocking: true, chargeId: charge.id, message: `${charge.description}: the contract requires the payer's authorization, and none is recorded` });
      }
      const tariff = ((inputs.termsSlice as { tariff?: Record<string, { payerCode?: string }> } | undefined)?.tariff ?? {})[charge.feeItemId];
      if (!tariff?.payerCode) issues.push({ code: 'payer_code_missing', blocking: false, chargeId: charge.id, message: `${charge.description}: no payer service code in the contract` });
      return {
        chargeId: charge.id, allocationId: l.allocation_id as string, contractVersionId: l.contract_version_id as string, feeItemId: charge.feeItemId, description: charge.description, category: charge.category,
        serviceDate, units: inputs.units as number, unitPriceMinor: (inputs.tariffUnitMinor as number | null) ?? null, payerShareMinor: l.payer_share_minor as number,
        patientShareMinor: l.d_patient_share as number, listPriceMinor: l.list_price_minor as number, ...(tariff?.payerCode ? { payerCode: tariff.payerCode } : {}), fulfillment, ...(authorization ? { authorization } : {}),
      };
    });
    const dates = lines.map((l) => l.serviceDate).sort();
    const serviceFrom = dates[0] ?? '', serviceTo = dates.at(-1) ?? '';
    // Diagnoses come only from clinicians' entries in the claim's visits.
    const encounters = [...new Set(lines.map((l) => charges.get(l.chargeId)!.encounterId ?? (charges.get(l.chargeId)!.appointmentId ? encounterForAppointment.get(charges.get(l.chargeId)!.appointmentId!) : undefined)).filter(Boolean))] as string[];
    const diagnoses = encounters.flatMap((e) => effectiveEncounterEntries(byEncounter.get(e) ?? []).filter((x) => x.step === 'diagnosis')).flatMap((x) => {
      const v = x.values as { diagnosis?: string; diagnoses?: { label: string; code?: string; codingSystem?: string }[] };
      return v.diagnoses?.length ? v.diagnoses.map((d) => ({ label: d.label, ...(d.code ? { code: d.code } : {}), ...(d.codingSystem ? { codingSystem: d.codingSystem } : {}) })) : v.diagnosis ? [{ label: v.diagnosis }] : [];
    });
    const profile = profiles.get(payerId);
    if (!profile) issues.push({ code: 'submission_method_missing', blocking: true, message: 'Record how this payer receives claims first' });
    const requirement = profile?.diagnosisRequirement ?? 'coded_icd10';
    if (requirement !== 'not_required' && !diagnoses.length) issues.push({ code: 'diagnosis_missing', blocking: true, message: 'No diagnosis is recorded for this visit' });
    else if (requirement === 'coded_icd10') {
      if (!diagnoses.some((d) => d.code && d.codingSystem === 'ICD-10')) issues.push({ code: 'diagnosis_code_missing', blocking: true, message: 'This payer needs an ICD-10 coded diagnosis' });
      else if (!CODE_CATALOGUE_VERIFIED) issues.push({ code: 'diagnosis_coding_unverified', blocking: true, message: 'ICD-10 codes cannot be validated yet: no verified ICD-10 catalogue is installed. Export only as a draft' });
    }
    let referral: ClaimView['referral'];
    if (profile?.referralRequired) {
      const found = liveAuths.find((a) => a.kind === 'referral' && a.status === 'approved' && a.patientId === patientId && a.payerId === payerId && a.validFrom <= serviceFrom && serviceTo <= a.validTo);
      if (found) referral = { id: found.id, reference: found.reference };
      else issues.push({ code: 'referral_missing', blocking: true, message: 'This payer needs an approved referral covering these dates' });
    }
    const attachments = attachmentRows.filter((a) => a.claim_id === id).map((a) => ({ documentId: a.document_id as string, documentType: a.document_type as string, title: a.title as string }));
    for (const required of profile?.requiredAttachments ?? []) {
      if (!attachments.some((a) => a.documentType === required)) issues.push({ code: 'attachment_missing', blocking: true, message: `Attach the ${String(required).replace(/_/g, ' ')} this payer requires` });
    }
    return {
      id, claimNumber: claim.claim_number as string, revision: claim.revision as number, ...(claim.supersedes ? { supersedes: claim.supersedes as string } : {}), ...(claim.superseded_by ? { supersededBy: claim.superseded_by as string } : {}),
      state: claim.state as ClaimState, payerId, patientId, patientName: names.get(patientId) ?? patientId,
      enrolleeNumber: (mine[0]?.inputs as { cover?: { enrolleeNumber?: string } } | undefined)?.cover?.enrolleeNumber ?? '', planCode: (mine[0]?.inputs as { planCode?: string } | undefined)?.planCode ?? '',
      coverId: claim.cover_id as string, episode: { kind: claim.episode_kind as ClaimView['episode']['kind'], key: claim.episode_key as string }, serviceFrom, serviceTo,
      currency: claim.currency as string, payerShareMinor: lines.reduce((n, l) => n + l.payerShareMinor, 0), ...(claim.batch_id ? { batchId: claim.batch_id as string } : {}),
      diagnoses, ...(referral ? { referral } : {}), lines, issues, attachments,
      events: eventRows.filter((e) => e.claim_id === id).map((e) => ({ state: e.state as ClaimState, at: new Date(e.at as string).toISOString(), by: e.staff_id as string, ...(e.note ? { note: e.note as string } : {}) })),
      createdOn: new Date(claim.created_on as string).toISOString(),
    };
  });
};

export const listClaims = async (sql: Db, facilityId: string, filter: { payerId?: string; state?: ClaimState; batchId?: string; claimIds?: string[]; includeSuperseded?: boolean }) => {
  const rows = await sql<Row[]>`SELECT * FROM insurance_claims WHERE facility_id = ${facilityId}
    AND (${filter.payerId ?? null}::text IS NULL OR payer_id = ${filter.payerId ?? null})
    AND (${filter.state ?? null}::text IS NULL OR state = ${filter.state ?? null})
    AND (${filter.batchId ?? null}::text IS NULL OR batch_id = ${filter.batchId ?? null})
    AND (${filter.claimIds ? sql.json(filter.claimIds) : null}::jsonb IS NULL OR to_jsonb(id) <@ ${filter.claimIds ? sql.json(filter.claimIds) : null}::jsonb)
    AND (${filter.includeSuperseded ?? false} OR superseded_by IS NULL)
    ORDER BY created_on DESC LIMIT 300`;
  return claimViews(sql, facilityId, rows);
};

/* ---------------- State changes ---------------- */

const lockClaims = async (tx: Tx, facilityId: string, claimIds: readonly string[]) => {
  const rows = await tx<Row[]>`SELECT * FROM insurance_claims WHERE facility_id = ${facilityId} AND id = ANY(${claimIds as string[]}) ORDER BY id FOR UPDATE`;
  if (rows.length !== new Set(claimIds).size) throw new ClaimRefusal('not_found', 'A claim is not in this hospital');
  if (rows.some((r) => r.superseded_by)) throw new ClaimRefusal('superseded', 'A claim was revised. Work on its latest revision');
  return rows;
};

/** Ready only when nothing blocks, judged now by the server; what passed is kept with the claim. */
export const markReady = async (tx: Tx, facilityId: string, staffId: string, claimIds: readonly string[]) => {
  const rows = await lockClaims(tx, facilityId, claimIds);
  const views = await claimViews(tx, facilityId, rows);
  const outcomes = [];
  for (const view of views) {
    if (view.state !== 'draft') { outcomes.push({ claimId: view.id, outcome: 'skipped' as const, reason: 'not_draft' }); continue; }
    const blocking = view.issues.filter((i) => i.blocking);
    if (blocking.length) { outcomes.push({ claimId: view.id, outcome: 'skipped' as const, reason: 'blocked', issues: blocking }); continue; }
    const snapshot = { lines: view.lines.map((l) => ({ chargeId: l.chargeId, allocationId: l.allocationId, contractVersionId: l.contractVersionId, fulfillment: l.fulfillment, authorization: l.authorization ?? null })), diagnoses: view.diagnoses, referral: view.referral ?? null, payerShareMinor: view.payerShareMinor, checkedOn: new Date().toISOString() };
    await tx`UPDATE insurance_claims SET state = 'ready', ready_snapshot = ${tx.json(snapshot as never)} WHERE id = ${view.id}`;
    await event(tx, facilityId, view.id, 'ready', staffId);
    outcomes.push({ claimId: view.id, outcome: 'ready' as const });
  }
  return { outcomes };
};

/**
 * A corrected claim: a new revision with each service's current confirmed
 * split. The earlier revision, its submission and acknowledgement stay as
 * they were; its lines are retired so no service is claimed twice.
 */
export const reviseClaim = async (tx: Tx, facilityId: string, staffId: string, claimId: string, reason: string) => {
  const [claim] = await lockClaims(tx, facilityId, [claimId]);
  const lines = await tx<{ charge_id: string }[]>`SELECT charge_id FROM insurance_claim_lines WHERE claim_id = ${claimId} AND current`;
  const fresh = await tx<Row[]>`SELECT a.id, a.charge_id, d.inputs FROM coverage_allocations a JOIN coverage_allocation_details d ON d.allocation_id = a.id AND d.facility_id = a.facility_id
    WHERE a.facility_id = ${facilityId} AND a.charge_id = ANY(${lines.map((l) => l.charge_id)}) AND a.state = 'finalised' AND a.arrangement = 'per_service' AND d.payer_share_minor > 0
      AND NOT EXISTS (SELECT 1 FROM coverage_allocations later WHERE later.facility_id = a.facility_id AND later.supersedes = a.id)`;
  const newId = `insurance_claim:${randomUUID()}`;
  await tx`UPDATE insurance_claim_lines SET current = false WHERE claim_id = ${claimId} AND current`;
  await tx`UPDATE insurance_claims SET superseded_by = ${newId} WHERE id = ${claimId}`;
  await tx`INSERT INTO insurance_claims (id, facility_id, claim_number, revision, supersedes, payer_id, patient_id, cover_id, episode_kind, episode_key, currency, state, created_by)
    VALUES (${newId}, ${facilityId}, ${claim.claim_number as string}, ${(claim.revision as number) + 1}, ${claimId}, ${claim.payer_id as string}, ${claim.patient_id as string}, ${claim.cover_id as string},
      ${claim.episode_kind as string}, ${claim.episode_key as string}, ${claim.currency as string}, 'draft', ${staffId})`;
  for (const a of fresh) await tx`INSERT INTO insurance_claim_lines (id, facility_id, claim_id, charge_id, allocation_id, contract_version_id) VALUES (${`claim_line:${randomUUID()}`}, ${facilityId}, ${newId}, ${a.charge_id as string}, ${a.id as string}, ${(a.inputs as Row).contractVersionId as string})`;
  await event(tx, facilityId, newId, 'draft', staffId, `Revision of ${claim.claim_number as string} r${claim.revision as number}: ${reason}`);
  const attachments = await tx<{ document_id: string }[]>`SELECT document_id FROM insurance_claim_attachments WHERE claim_id = ${claimId}`;
  for (const a of attachments) await tx`INSERT INTO insurance_claim_attachments (facility_id, claim_id, document_id, added_by) VALUES (${facilityId}, ${newId}, ${a.document_id}, ${staffId})`;
  return { claimId: newId, revision: (claim.revision as number) + 1, lines: fresh.length, dropped: lines.length - fresh.length };
};

export const setAttachment = async (tx: Tx, facilityId: string, staffId: string, claimId: string, documentId: string, remove: boolean) => {
  const [claim] = await lockClaims(tx, facilityId, [claimId]);
  if (claim.state !== 'draft') throw new ClaimRefusal('not_draft', 'Attachments change only while the claim is a draft. Revise it to change them');
  const [doc] = await tx`SELECT 1 FROM insurance_documents WHERE facility_id = ${facilityId} AND id = ${documentId} AND payer_id = ${claim.payer_id as string} AND verification <> 'rejected'`;
  if (!doc) throw new ClaimRefusal('unknown_document', 'Attach a document stored for this payer that was not rejected');
  if (remove) await tx`DELETE FROM insurance_claim_attachments WHERE claim_id = ${claimId} AND document_id = ${documentId}`;
  else await tx`INSERT INTO insurance_claim_attachments (facility_id, claim_id, document_id, added_by) VALUES (${facilityId}, ${claimId}, ${documentId}, ${staffId}) ON CONFLICT DO NOTHING`;
};

/** A submission batch: a payer and any period the payer asks for, holding claims already ready or further along. */
export const createBatch = async (tx: Tx, facilityId: string, staffId: string, input: { payerId: string; periodFrom: string; periodTo: string; reference?: string }) => {
  if (input.periodTo < input.periodFrom) throw new ClaimRefusal('invalid_period', 'The period must end on or after it starts');
  await tx`SELECT id FROM facilities WHERE id = ${facilityId} FOR UPDATE`;
  const [{ n }] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM insurance_claim_batches WHERE facility_id = ${facilityId}`;
  const id = `claim_batch:${randomUUID()}`, reference = input.reference?.trim() || `BATCH-${String(n + 1).padStart(4, '0')}`;
  const [clash] = await tx`SELECT 1 FROM insurance_claim_batches WHERE facility_id = ${facilityId} AND reference = ${reference}`;
  if (clash) throw new ClaimRefusal('duplicate_batch', 'A batch with this reference exists');
  const candidates = await claimViews(tx, facilityId, await tx<Row[]>`SELECT * FROM insurance_claims WHERE facility_id = ${facilityId} AND payer_id = ${input.payerId}
    AND batch_id IS NULL AND superseded_by IS NULL AND state = 'ready' FOR UPDATE`);
  const chosen = candidates.filter((c) => c.serviceFrom >= input.periodFrom && c.serviceTo <= input.periodTo);
  if (!chosen.length) throw new ClaimRefusal('no_ready_claims', 'No ready claims for this payer in that period');
  await tx`INSERT INTO insurance_claim_batches (id, facility_id, payer_id, reference, period_from, period_to, created_by) VALUES (${id}, ${facilityId}, ${input.payerId}, ${reference}, ${input.periodFrom}, ${input.periodTo}, ${staffId})`;
  await tx`UPDATE insurance_claims SET batch_id = ${id} WHERE id = ANY(${chosen.map((c) => c.id)})`;
  return { batchId: id, reference, claims: chosen.length };
};

export const listBatches = async (sql: Db, facilityId: string) =>
  (await sql<Row[]>`SELECT b.*, (SELECT COUNT(*)::int FROM insurance_claims c WHERE c.batch_id = b.id AND c.superseded_by IS NULL) AS claims FROM insurance_claim_batches b WHERE b.facility_id = ${facilityId} ORDER BY b.created_on DESC LIMIT 200`)
    .map((b) => ({ id: b.id as string, payerId: b.payer_id as string, reference: b.reference as string, periodFrom: isoDay(b.period_from), periodTo: isoDay(b.period_to), claims: b.claims as number, createdOn: new Date(b.created_on as string).toISOString() }));

/* ---------------- Export ---------------- */

const DRAFT_MARK = 'DRAFT - NOT FOR SUBMISSION';
const dmy = (iso: string) => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';

/**
 * The rows of an export, in the payer's column order under the payer's own
 * headers. A draft export may include any claim but marks every row and
 * changes nothing; a real export takes only ready (or already exported)
 * claims that still pass every check, and moves ready claims to exported.
 * Exporting never records a submission.
 */
export const exportClaims = async (tx: Tx, facilityId: string, staffId: string, input: { claimIds?: string[]; batchId?: string; draft: boolean; format: 'csv' | 'xlsx' | 'pdf'; template?: ImportTemplate }) => {
  const rows = input.batchId
    ? await tx<Row[]>`SELECT * FROM insurance_claims WHERE facility_id = ${facilityId} AND batch_id = ${input.batchId} AND superseded_by IS NULL ORDER BY claim_number FOR UPDATE`
    : await lockClaims(tx, facilityId, input.claimIds ?? []);
  if (!rows.length) throw new ClaimRefusal('no_claims', 'Choose claims to export');
  if (new Set(rows.map((r) => r.payer_id)).size > 1) throw new ClaimRefusal('mixed_payers', 'Export one payer\'s claims at a time');
  const views = await claimViews(tx, facilityId, rows);
  if (!input.draft) {
    const notReady = views.filter((v) => v.state === 'draft');
    if (notReady.length) throw new ClaimRefusal('not_ready', `${notReady.length} claim(s) are drafts. Mark them ready, or export as a marked draft`, { claimIds: notReady.map((v) => v.id) });
    const changed = views.filter((v) => v.issues.some((i) => i.blocking));
    if (changed.length) throw new ClaimRefusal('claim_changed_since_ready', `${changed.length} claim(s) no longer pass their checks. Revise them`, { claimIds: changed.map((v) => v.id) });
  }
  const facility = await findRecord<Facility>(tx, 'facility', facilityId);
  const batches = new Map((await tx<{ id: string; reference: string }[]>`SELECT id, reference FROM insurance_claim_batches WHERE facility_id = ${facilityId}`).map((b) => [b.id, b.reference]));
  const fields: ClaimExportField[] = input.template
    ? Object.entries(input.template.mapping).sort((a, b) => a[1] - b[1]).map(([f]) => f as ClaimExportField).filter((f) => (CLAIM_EXPORT_FIELDS as readonly string[]).includes(f))
    : [...DEFAULT_CLAIM_COLUMNS];
  const headers = input.template ? Object.entries(input.template.mapping).sort((a, b) => a[1] - b[1]).filter(([f]) => fields.includes(f as ClaimExportField)).map(([, column]) => input.template!.headers[column] ?? '') : fields;
  const formats = (input.template?.formats ?? {}) as Record<string, string>;
  const date = (f: string, v: string) => formats[f] === 'date_dmy' ? dmy(v) : v;
  const money = (f: string, minor: number | null) => minor === null ? '' : formats[f] === 'amount_minor' ? minor : Math.round(minor) / 100;
  const out: (string | number)[][] = [];
  for (const v of views) for (const l of v.lines) {
    const value = (f: ClaimExportField): string | number => {
      switch (f) {
        case 'claimNumber': return v.claimNumber;
        case 'claimRevision': return v.revision;
        case 'claimStatus': return input.draft ? DRAFT_MARK : v.state;
        case 'batchReference': return v.batchId ? batches.get(v.batchId) ?? '' : '';
        case 'facilityName': return facility?.name ?? '';
        case 'patientName': return v.patientName;
        case 'hospitalNumber': return v.patientId;
        case 'enrolleeNumber': return v.enrolleeNumber;
        case 'planCode': return v.planCode;
        case 'serviceDate': return date(f, l.serviceDate);
        case 'admissionDate': return v.episode.kind === 'admission' ? date(f, v.serviceFrom) : '';
        case 'dischargeDate': return v.episode.kind === 'admission' ? date(f, v.serviceTo) : '';
        case 'diagnosis': return v.diagnoses.map((d) => d.label).join('; ');
        case 'diagnosisCode': return v.diagnoses.map((d) => d.code).filter(Boolean).join('; ');
        case 'authorizationCode': return l.authorization?.reference ?? '';
        case 'referralNumber': return v.referral?.reference ?? '';
        case 'payerServiceCode': return l.payerCode ?? '';
        case 'serviceName': return l.description;
        case 'category': return l.category;
        case 'quantity': return l.units;
        case 'unitPrice': return money(f, l.unitPriceMinor);
        case 'amountClaimed': return money(f, l.payerShareMinor);
        case 'patientShare': return money(f, l.patientShareMinor);
        case 'listPrice': return money(f, l.listPriceMinor);
        case 'fulfilledOn': return 'on' in l.fulfillment ? date(f, l.fulfillment.on.slice(0, 10)) : '';
      }
    };
    out.push(fields.map(value));
  }
  const payloadSha256 = createHash('sha256').update(JSON.stringify({ headers, rows: out, draft: input.draft })).digest('hex');
  const exportId = `claim_export:${randomUUID()}`;
  await tx`INSERT INTO insurance_claim_exports (id, facility_id, claim_ids, batch_id, draft, format, template_id, rows, payload_sha256, exported_by)
    VALUES (${exportId}, ${facilityId}, ${tx.json(views.map((v) => v.id))}, ${input.batchId ?? null}, ${input.draft}, ${input.format}, ${input.template?.id ?? null}, ${out.length}, ${payloadSha256}, ${staffId})`;
  if (!input.draft) for (const v of views.filter((x) => x.state === 'ready')) {
    await tx`UPDATE insurance_claims SET state = 'exported' WHERE id = ${v.id}`;
    await event(tx, facilityId, v.id, 'exported', staffId, `${input.format.toUpperCase()} export`, exportId);
  }
  return { exportId, draft: input.draft, headers, rows: out, payloadSha256, claims: views.map((v) => ({ id: v.id, claimNumber: v.claimNumber, revision: v.revision })) };
};

/* ---------------- Submission and acknowledgement ---------------- */

/** Records that exported claims were sent through the payer's channel. It is not the payer's approval. */
export const recordSubmission = async (tx: Tx, facilityId: string, staffId: string, input: ClaimSubmissionInput) => {
  const rows = await lockClaims(tx, facilityId, input.claimIds);
  if (new Set(rows.map((r) => r.payer_id)).size > 1) throw new ClaimRefusal('mixed_payers', 'A submission goes to one payer');
  const notExported = rows.filter((r) => r.state !== 'exported');
  if (notExported.length) throw new ClaimRefusal('not_exported', 'Only exported claims can be recorded as submitted', { claimIds: notExported.map((r) => r.id) });
  if (input.evidenceDocumentId) {
    const [doc] = await tx`SELECT 1 FROM insurance_documents WHERE facility_id = ${facilityId} AND id = ${input.evidenceDocumentId} AND payer_id = ${rows[0].payer_id as string}`;
    if (!doc) throw new ClaimRefusal('unknown_document', 'Attach evidence stored for this payer');
  }
  const id = `claim_submission:${randomUUID()}`;
  await tx`INSERT INTO insurance_claim_submissions (id, facility_id, payer_id, claim_ids, channel, reference, submitted_on, evidence_document_id, note, submitted_by)
    VALUES (${id}, ${facilityId}, ${rows[0].payer_id as string}, ${tx.json(input.claimIds)}, ${input.channel}, ${input.reference}, ${input.submittedOn}, ${input.evidenceDocumentId ?? null}, ${input.note ?? null}, ${staffId})`;
  for (const r of rows) {
    await tx`UPDATE insurance_claims SET state = 'submitted' WHERE id = ${r.id as string}`;
    await event(tx, facilityId, r.id as string, 'submitted', staffId, `Sent by ${input.channel}`, input.reference);
  }
  return { submissionId: id, claims: rows.length };
};

/** The payer confirmed receipt. Nothing here says the payer accepted or will pay. */
export const recordAcknowledgement = async (tx: Tx, facilityId: string, staffId: string, input: ClaimAcknowledgementInput) => {
  const [submission] = await tx<Row[]>`SELECT * FROM insurance_claim_submissions WHERE facility_id = ${facilityId} AND id = ${input.submissionId} FOR UPDATE`;
  if (!submission) throw new ClaimRefusal('not_found', 'This submission is not in this hospital');
  const [done] = await tx`SELECT 1 FROM insurance_claim_acknowledgements WHERE submission_id = ${input.submissionId}`;
  if (done) throw new ClaimRefusal('already_acknowledged', 'This submission was already acknowledged');
  const id = `claim_ack:${randomUUID()}`;
  await tx`INSERT INTO insurance_claim_acknowledgements (id, facility_id, submission_id, reference, acknowledged_on, evidence_document_id, note, recorded_by)
    VALUES (${id}, ${facilityId}, ${input.submissionId}, ${input.reference ?? null}, ${input.acknowledgedOn}, ${input.evidenceDocumentId ?? null}, ${input.note ?? null}, ${staffId})`;
  const claimIds = submission.claim_ids as string[];
  const rows = await tx<Row[]>`SELECT id FROM insurance_claims WHERE facility_id = ${facilityId} AND id = ANY(${claimIds}) AND state = 'submitted' AND superseded_by IS NULL FOR UPDATE`;
  for (const r of rows) {
    await tx`UPDATE insurance_claims SET state = 'acknowledged' WHERE id = ${r.id as string}`;
    await event(tx, facilityId, r.id as string, 'acknowledged', staffId, 'Receipt acknowledged by the payer', input.reference);
  }
  return { acknowledgementId: id, claims: rows.length };
};

export const listSubmissions = async (sql: Db, facilityId: string) =>
  (await sql<Row[]>`SELECT s.*, a.id AS ack_id, a.reference AS ack_reference, a.acknowledged_on FROM insurance_claim_submissions s LEFT JOIN insurance_claim_acknowledgements a ON a.submission_id = s.id
    WHERE s.facility_id = ${facilityId} ORDER BY s.recorded_on DESC LIMIT 200`).map((s) => ({
    id: s.id as string, payerId: s.payer_id as string, claimIds: s.claim_ids as string[], channel: s.channel as string, reference: s.reference as string, submittedOn: isoDay(s.submitted_on),
    submittedBy: s.submitted_by as string, ...(s.evidence_document_id ? { evidenceDocumentId: s.evidence_document_id as string } : {}),
    ...(s.ack_id ? { acknowledgement: { id: s.ack_id as string, reference: (s.ack_reference as string | null) ?? undefined, acknowledgedOn: isoDay(s.acknowledged_on) } } : {}),
  }));
