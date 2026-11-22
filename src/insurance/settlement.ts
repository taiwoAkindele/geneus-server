import { randomUUID } from 'node:crypto';
import {
  matchRemittanceRows,
  type ClaimView,
  type DisputeOpen,
  type DisputeResolve,
  type PayerDecisionInput,
  type RemittanceAllocate,
  type RemittanceInput,
  type RemittanceRow,
  type RemittanceReverse,
  type WriteOffInput,
} from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { ClaimRefusal, claimViews } from './claims.ts';
import { reserveSource } from '../billing/sourceCapacity.ts';
import { integratedEnabled } from '../billing/integrated.ts';

/**
 * Hospital-side settlement (Slice 4): what payers decided and paid, and what
 * the hospital disputed or gave up. Every record is insert-only, kept apart
 * from patient billing, and none of it ever changes what a patient owes.
 */
type Row = Record<string, unknown>;
type Db = Sql | Tx;

const RESPONDED = ['submitted', 'acknowledged'];
const isoDay = (value: unknown) =>
  value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value).slice(0, 10);

/** The current revision of each claim, locked, with its full view. */
const lockedViews = async (tx: Tx, facilityId: string, claimIds: readonly string[]) => {
  const rows = await tx<
    Row[]
  >`SELECT * FROM insurance_claims WHERE facility_id = ${facilityId} AND id = ANY(${claimIds as string[]}) ORDER BY id FOR UPDATE`;
  if (rows.length !== new Set(claimIds).size) {
    throw new ClaimRefusal('not_found', 'A claim is not in this hospital');
  }
  if (rows.some((r) => r.superseded_by)) {
    throw new ClaimRefusal('superseded', 'A claim was revised. Work on its latest revision');
  }
  return claimViews(tx, facilityId, rows);
};

const checkEvidence = async (tx: Tx, facilityId: string, payerId: string, documentId?: string) => {
  if (!documentId) {
    return;
  }
  const [doc] =
    await tx`SELECT 1 FROM insurance_documents WHERE facility_id = ${facilityId} AND id = ${documentId} AND payer_id = ${payerId} AND verification <> 'rejected'`;
  if (!doc) {
    throw new ClaimRefusal('unknown_document', 'Attach a document stored for this payer');
  }
};

/* ---------------- Payer decisions ---------------- */

/**
 * Records the payer's decision on a submitted claim revision, in total and
 * per service. A later decision supersedes the earlier one; both stay.
 * Approved amounts can never exceed what was claimed.
 */
export const recordDecision = async (
  tx: Tx,
  facilityId: string,
  staffId: string,
  input: PayerDecisionInput,
) => {
  const [view] = await lockedViews(tx, facilityId, [input.claimId]);
  if (!RESPONDED.includes(view.state)) {
    throw new ClaimRefusal(
      'not_submitted',
      "Record the payer's decision once the claim is submitted",
    );
  }
  await checkEvidence(tx, facilityId, view.payerId, input.evidenceDocumentId);
  const claimed = new Map(view.lines.map((l) => [l.chargeId, l.payerShareMinor]));
  const total = view.payerShareMinor;
  let lines: {
    chargeId: string;
    claimedMinor: number;
    approvedMinor: number;
    reasonCode?: string;
    reason?: string;
  }[] = [];
  let approvedMinor = 0;
  if (input.decision === 'approved') {
    if (input.lines.some((l) => l.approvedMinor !== claimed.get(l.chargeId))) {
      throw new ClaimRefusal(
        'not_full_approval',
        'Some services were approved for less. Record a partial approval',
      );
    }
    lines = view.lines.map((l) => ({
      chargeId: l.chargeId,
      claimedMinor: l.payerShareMinor,
      approvedMinor: l.payerShareMinor,
    }));
    approvedMinor = total;
  } else if (input.decision === 'denied') {
    if (input.lines.some((l) => l.approvedMinor !== 0)) {
      throw new ClaimRefusal(
        'denial_with_amount',
        'A denial approves nothing. Record a partial approval instead',
      );
    }
    lines = view.lines.map((l) => ({
      chargeId: l.chargeId,
      claimedMinor: l.payerShareMinor,
      approvedMinor: 0,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    }));
  } else if (input.decision === 'partially_approved') {
    if (input.lines.length) {
      const given = new Map(input.lines.map((l) => [l.chargeId, l]));
      if (given.size !== input.lines.length) {
        throw new ClaimRefusal('duplicate_line', 'Enter each service once');
      }
      for (const id of given.keys()) {
        if (!claimed.has(id)) {
          throw new ClaimRefusal('unknown_line', 'A service is not on this claim revision');
        }
      }
      // Services the advice does not mention are taken as approved in full: the payer listed only its deductions.
      lines = view.lines.map((l) => {
        const g = given.get(l.chargeId);
        if (g && g.approvedMinor > l.payerShareMinor) {
          throw new ClaimRefusal(
            'approved_above_claimed',
            `${l.description}: the payer cannot approve more than was claimed`,
          );
        }
        return {
          chargeId: l.chargeId,
          claimedMinor: l.payerShareMinor,
          approvedMinor: g ? g.approvedMinor : l.payerShareMinor,
          ...(g?.reasonCode ? { reasonCode: g.reasonCode } : {}),
          ...(g?.reason ? { reason: g.reason } : {}),
        };
      });
      approvedMinor = lines.reduce((n, l) => n + l.approvedMinor, 0);
    } else {
      approvedMinor = input.approvedMinor!;
    }
    if (approvedMinor >= total) {
      throw new ClaimRefusal(
        'not_partial',
        'Everything claimed was approved. Record a full approval',
      );
    }
  }
  const [current] = await tx<
    { id: string }[]
  >`SELECT d.id FROM insurance_claim_decisions d WHERE d.facility_id = ${facilityId} AND d.claim_id = ${view.id}
    AND NOT EXISTS (SELECT 1 FROM insurance_claim_decisions later WHERE later.supersedes = d.id)`;
  const id = `claim_decision:${randomUUID()}`;
  await tx`INSERT INTO insurance_claim_decisions (id, facility_id, claim_id, decision, decided_on, approved_minor, payer_reference, reason_code, reason, evidence_document_id, supersedes, recorded_by)
    VALUES (${id}, ${facilityId}, ${view.id}, ${input.decision}, ${input.decidedOn}, ${approvedMinor}, ${input.payerReference ?? null}, ${input.reasonCode ?? null}, ${input.reason ?? null}, ${input.evidenceDocumentId ?? null}, ${current?.id ?? null}, ${staffId})`;
  for (const l of lines) {
    await tx`INSERT INTO insurance_claim_line_decisions (decision_id, facility_id, charge_id, claimed_minor, approved_minor, reason_code, reason)
    VALUES (${id}, ${facilityId}, ${l.chargeId}, ${l.claimedMinor}, ${l.approvedMinor}, ${l.reasonCode ?? null}, ${l.reason ?? null})`;
  }
  return {
    decisionId: id,
    claimId: view.id,
    decision: input.decision,
    approvedMinor,
    supersedes: current?.id ?? null,
  };
};

/* ---------------- Remittances ---------------- */

const remittanceTotals = async (sql: Db, remittanceId: string) => {
  const [r] = await sql<
    { allocated: string }[]
  >`SELECT COALESCE(SUM(amount_minor), 0)::text AS allocated FROM insurance_remittance_allocations WHERE remittance_id = ${remittanceId}`;
  return Number(r.allocated);
};

/**
 * Allocates part of a payer's payment to claims. Each claim takes no more
 * than it has outstanding, and the remittance never allocates more than was
 * received, so the same money is never counted twice.
 */
const allocate = async (
  tx: Tx,
  facilityId: string,
  staffId: string,
  remittance: Row,
  allocations: readonly { claimId: string; amountMinor: number }[],
) => {
  if (!allocations.length) {
    return 0;
  }
  const views = await lockedViews(
    tx,
    facilityId,
    allocations.map((a) => a.claimId),
  );
  const byId = new Map(views.map((v) => [v.id, v]));
  const already = await remittanceTotals(tx, remittance.id as string);
  const adding = allocations.reduce((n, a) => n + a.amountMinor, 0);
  if (already + adding > Number(remittance.amount_minor)) {
    throw new ClaimRefusal('over_allocated', 'More would be allocated than this payment holds');
  }
  for (const a of allocations) {
    const view = byId.get(a.claimId)!;
    if (view.payerId !== remittance.payer_id) {
      throw new ClaimRefusal('other_payer', `Claim ${view.claimNumber} belongs to another payer`);
    }
    if (view.currency !== remittance.currency) {
      throw new ClaimRefusal(
        'currency_mismatch',
        `Claim ${view.claimNumber} is in ${view.currency}`,
      );
    }
    if (!RESPONDED.includes(view.state)) {
      throw new ClaimRefusal('not_submitted', `Claim ${view.claimNumber} has not been submitted`);
    }
    const outstanding = view.settlement?.outstandingMinor ?? 0;
    if (a.amountMinor > outstanding) {
      throw new ClaimRefusal(
        'above_outstanding',
        `Claim ${view.claimNumber} has ${outstanding} outstanding; leave the rest unallocated`,
      );
    }
    await tx`INSERT INTO insurance_remittance_allocations (id, facility_id, remittance_id, claim_id, amount_minor, recorded_by)
      VALUES (${`remittance_allocation:${randomUUID()}`}, ${facilityId}, ${remittance.id as string}, ${a.claimId}, ${a.amountMinor}, ${staffId})`;
  }
  return adding;
};

export const recordRemittance = async (
  tx: Tx,
  facilityId: string,
  staffId: string,
  input: RemittanceInput,
) => {
  await tx`SELECT id FROM facilities WHERE id = ${facilityId} FOR UPDATE`;
  const [payer] =
    await tx`SELECT id FROM payers WHERE facility_id = ${facilityId} AND id = ${input.payerId}`;
  if (!payer) {
    throw new ClaimRefusal('unknown_payer', 'Choose a payer of this hospital');
  }
  await checkEvidence(tx, facilityId, input.payerId, input.evidenceDocumentId);
  const [duplicate] =
    await tx`SELECT 1 FROM insurance_remittances r WHERE r.facility_id = ${facilityId} AND r.payer_id = ${input.payerId} AND lower(btrim(r.reference)) = lower(btrim(${input.reference}))
    AND NOT EXISTS (SELECT 1 FROM insurance_remittance_reversals v WHERE v.remittance_id = r.id)`;
  if (duplicate) {
    throw new ClaimRefusal(
      'duplicate_remittance',
      'A payment with this reference from this payer is already recorded',
    );
  }
  if (input.incomingTransferId && input.method !== 'transfer') {
    throw new ClaimRefusal(
      'invalid_source',
      'A verified bank receipt is used only for a transfer remittance',
    );
  }
  const candidates =
    input.method === 'transfer'
      ? await tx`SELECT id FROM incoming_transfers WHERE facility_id=${facilityId} AND currency=${input.currency}
    AND (id=${input.incomingTransferId ?? null} OR (${input.incomingTransferId ?? null}::text IS NULL AND lower(btrim(provider_reference))=lower(btrim(${input.reference}))))`
      : [];
  if (candidates.length > 1) {
    throw new ClaimRefusal(
      'ambiguous_source',
      'Choose the exact verified receipt; its reference is ambiguous',
    );
  }
  const incomingTransferId = input.incomingTransferId ?? (candidates[0]?.id as string | undefined);
  if (
    input.method === 'transfer' &&
    !incomingTransferId &&
    (await integratedEnabled(tx, facilityId))
  ) {
    throw new ClaimRefusal(
      'verified_receipt_required',
      'Import or select the verified hospital bank receipt before recognizing this transfer',
    );
  }
  if (incomingTransferId) {
    await reserveSource(tx, facilityId, incomingTransferId, input.amountMinor, input.currency);
  }
  const id = `remittance:${randomUUID()}`;
  const [remittance] = await tx<
    Row[]
  >`INSERT INTO insurance_remittances (id, facility_id, payer_id, received_on, reference, amount_minor, currency, method, receiving_account, evidence_document_id, note, source, recorded_by, incoming_transfer_id)
    VALUES (${id}, ${facilityId}, ${input.payerId}, ${input.receivedOn}, ${input.reference}, ${input.amountMinor}, ${input.currency}, ${input.method}, ${input.receivingAccount ?? null},
      ${input.evidenceDocumentId ?? null}, ${input.note ?? null}, ${input.source ? tx.json(input.source as never) : null}, ${staffId},${incomingTransferId ?? null}) RETURNING *`;
  const allocated = await allocate(tx, facilityId, staffId, remittance, input.allocations);
  return {
    remittanceId: id,
    allocatedMinor: allocated,
    unallocatedMinor: input.amountMinor - allocated,
  };
};

export const allocateRemittance = async (
  tx: Tx,
  facilityId: string,
  staffId: string,
  input: RemittanceAllocate,
) => {
  const [remittance] = await tx<
    Row[]
  >`SELECT * FROM insurance_remittances WHERE facility_id = ${facilityId} AND id = ${input.remittanceId} FOR UPDATE`;
  if (!remittance) {
    throw new ClaimRefusal('not_found', 'This payment is not in this hospital');
  }
  const [reversed] =
    await tx`SELECT 1 FROM insurance_remittance_reversals WHERE remittance_id = ${input.remittanceId}`;
  if (reversed) {
    throw new ClaimRefusal('reversed', 'This payment was reversed');
  }
  const allocated = await allocate(tx, facilityId, staffId, remittance, input.allocations);
  const total = await remittanceTotals(tx, input.remittanceId);
  return {
    remittanceId: input.remittanceId,
    allocatedMinor: allocated,
    unallocatedMinor: Number(remittance.amount_minor) - total,
  };
};

/** A payment recorded in error is reversed whole: its allocations stop counting, and nothing is deleted. */
export const reverseRemittance = async (
  tx: Tx,
  facilityId: string,
  staffId: string,
  input: RemittanceReverse,
) => {
  const [remittance] = await tx<
    Row[]
  >`SELECT id FROM insurance_remittances WHERE facility_id = ${facilityId} AND id = ${input.remittanceId} FOR UPDATE`;
  if (!remittance) {
    throw new ClaimRefusal('not_found', 'This payment is not in this hospital');
  }
  const [reversed] =
    await tx`SELECT 1 FROM insurance_remittance_reversals WHERE remittance_id = ${input.remittanceId}`;
  if (reversed) {
    throw new ClaimRefusal('already_reversed', 'This payment was already reversed');
  }
  await tx`INSERT INTO insurance_remittance_reversals (remittance_id, facility_id, reason, reversed_by) VALUES (${input.remittanceId}, ${facilityId}, ${input.reason}, ${staffId})`;
  return { remittanceId: input.remittanceId, reversed: true };
};

export type RemittanceView = {
  id: string;
  payerId: string;
  receivedOn: string;
  reference: string;
  amountMinor: number;
  currency: string;
  method: string;
  receivingAccount?: string;
  allocatedMinor: number;
  unallocatedMinor: number;
  reversed?: { reason: string; by: string; on: string };
  allocations: { claimId: string; claimNumber: string; revision: number; amountMinor: number }[];
  recordedBy: string;
  recordedOn: string;
  source?: unknown;
};
export const listRemittances = async (
  sql: Db,
  facilityId: string,
  payerId?: string,
): Promise<RemittanceView[]> => {
  const rows = await sql<
    Row[]
  >`SELECT r.*, v.reason AS reversal_reason, v.reversed_by, v.reversed_on FROM insurance_remittances r LEFT JOIN insurance_remittance_reversals v ON v.remittance_id = r.id
    WHERE r.facility_id = ${facilityId} AND (${payerId ?? null}::text IS NULL OR r.payer_id = ${payerId ?? null}) ORDER BY r.received_on DESC, r.recorded_on DESC LIMIT 300`;
  const ids = rows.map((r) => r.id as string);
  const allocations = ids.length
    ? await sql<
        Row[]
      >`SELECT a.remittance_id, a.claim_id, a.amount_minor, c.claim_number, c.revision FROM insurance_remittance_allocations a JOIN insurance_claims c ON c.id = a.claim_id WHERE a.remittance_id = ANY(${ids}) ORDER BY a.recorded_on`
    : [];
  return rows.map((r) => {
    const mine = allocations
      .filter((a) => a.remittance_id === r.id)
      .map((a) => ({
        claimId: a.claim_id as string,
        claimNumber: a.claim_number as string,
        revision: a.revision as number,
        amountMinor: Number(a.amount_minor),
      }));
    const allocated = mine.reduce((n, a) => n + a.amountMinor, 0);
    return {
      id: r.id as string,
      payerId: r.payer_id as string,
      receivedOn: isoDay(r.received_on),
      reference: r.reference as string,
      amountMinor: Number(r.amount_minor),
      currency: r.currency as string,
      method: r.method as string,
      ...(r.receiving_account ? { receivingAccount: r.receiving_account as string } : {}),
      allocatedMinor: allocated,
      unallocatedMinor: r.reversal_reason ? 0 : Number(r.amount_minor) - allocated,
      ...(r.reversal_reason
        ? {
            reversed: {
              reason: r.reversal_reason as string,
              by: r.reversed_by as string,
              on: new Date(r.reversed_on as string).toISOString(),
            },
          }
        : {}),
      allocations: mine,
      recordedBy: r.recorded_by as string,
      recordedOn: new Date(r.recorded_on as string).toISOString(),
      ...(r.source ? { source: r.source } : {}),
    };
  });
};

/* ---------------- Disputes and write-offs ---------------- */

export const openDispute = async (
  tx: Tx,
  facilityId: string,
  staffId: string,
  input: DisputeOpen,
) => {
  const [view] = await lockedViews(tx, facilityId, [input.claimId]);
  if (!view.settlement || view.settlement.status === 'not_submitted') {
    throw new ClaimRefusal('not_submitted', 'Dispute a claim once the payer has it');
  }
  const room = view.settlement.outstandingMinor - view.settlement.disputedMinor;
  if (input.amountMinor > room) {
    throw new ClaimRefusal(
      'above_outstanding',
      `At most ${room} of this claim is outstanding and not already disputed`,
    );
  }
  const id = `claim_dispute:${randomUUID()}`;
  await tx`INSERT INTO insurance_claim_disputes (id, facility_id, claim_id, amount_minor, reason, payer_reference, opened_by) VALUES (${id}, ${facilityId}, ${view.id}, ${input.amountMinor}, ${input.reason}, ${input.payerReference ?? null}, ${staffId})`;
  return { disputeId: id };
};

export const resolveDispute = async (
  tx: Tx,
  facilityId: string,
  staffId: string,
  input: DisputeResolve,
) => {
  const [dispute] = await tx<
    Row[]
  >`SELECT id FROM insurance_claim_disputes WHERE facility_id = ${facilityId} AND id = ${input.disputeId} FOR UPDATE`;
  if (!dispute) {
    throw new ClaimRefusal('not_found', 'This dispute is not in this hospital');
  }
  const [done] =
    await tx`SELECT 1 FROM insurance_claim_dispute_resolutions WHERE dispute_id = ${input.disputeId}`;
  if (done) {
    throw new ClaimRefusal('already_resolved', 'This dispute was already resolved');
  }
  await tx`INSERT INTO insurance_claim_dispute_resolutions (dispute_id, facility_id, outcome, note, resolved_by) VALUES (${input.disputeId}, ${facilityId}, ${input.outcome}, ${input.note}, ${staffId})`;
  return { disputeId: input.disputeId, outcome: input.outcome };
};

/**
 * Gives up part of what a payer owes on a claim. Limited to what is
 * outstanding and not under dispute. The amount leaves the hospital's
 * receivable; it is never charged to the patient.
 */
export const writeOff = async (
  tx: Tx,
  facilityId: string,
  staffId: string,
  input: WriteOffInput,
) => {
  const [view] = await lockedViews(tx, facilityId, [input.claimId]);
  if (!view.settlement || view.settlement.status === 'not_submitted') {
    throw new ClaimRefusal('not_submitted', 'Write off only after the payer has the claim');
  }
  const room = view.settlement.outstandingMinor - view.settlement.disputedMinor;
  if (input.amountMinor > room) {
    throw new ClaimRefusal(
      'above_outstanding',
      `At most ${room} is outstanding and not under dispute`,
    );
  }
  const id = `write_off:${randomUUID()}`;
  await tx`INSERT INTO insurance_write_offs (id, facility_id, claim_id, amount_minor, reason, written_off_by) VALUES (${id}, ${facilityId}, ${view.id}, ${input.amountMinor}, ${input.reason}, ${staffId})`;
  return { writeOffId: id };
};

export const listDisputes = async (sql: Db, facilityId: string) =>
  (
    await sql<
      Row[]
    >`SELECT d.*, c.claim_number, c.revision, c.payer_id, r.outcome, r.note AS resolution_note, r.resolved_by, r.resolved_on FROM insurance_claim_disputes d JOIN insurance_claims c ON c.id = d.claim_id
    LEFT JOIN insurance_claim_dispute_resolutions r ON r.dispute_id = d.id WHERE d.facility_id = ${facilityId} ORDER BY d.opened_on DESC LIMIT 300`
  ).map((d) => ({
    id: d.id as string,
    claimId: d.claim_id as string,
    claimNumber: d.claim_number as string,
    revision: d.revision as number,
    payerId: d.payer_id as string,
    amountMinor: Number(d.amount_minor),
    reason: d.reason as string,
    ...(d.payer_reference ? { payerReference: d.payer_reference as string } : {}),
    openedBy: d.opened_by as string,
    openedOn: new Date(d.opened_on as string).toISOString(),
    ...(d.outcome
      ? {
          resolution: {
            outcome: d.outcome as string,
            note: d.resolution_note as string,
            by: d.resolved_by as string,
            on: new Date(d.resolved_on as string).toISOString(),
          },
        }
      : {}),
  }));

/* ---------------- Outstanding balances ---------------- */

export type OutstandingClaim = Pick<
  ClaimView,
  | 'id'
  | 'claimNumber'
  | 'revision'
  | 'payerId'
  | 'patientId'
  | 'patientName'
  | 'enrolleeNumber'
  | 'state'
  | 'serviceFrom'
  | 'serviceTo'
  | 'currency'
> & { settlement: NonNullable<ClaimView['settlement']> };

/**
 * Every claim the payer has (or has paid), current revisions only, with its
 * money position. Totals are per payer and currency, each figure apart.
 */
export const outstandingClaims = async (
  sql: Db,
  facilityId: string,
  payerId?: string,
): Promise<{ claims: OutstandingClaim[]; totals: Record<string, Record<string, number>> }> => {
  const rows = await sql<
    Row[]
  >`SELECT * FROM insurance_claims c WHERE c.facility_id = ${facilityId} AND c.superseded_by IS NULL
    AND (${payerId ?? null}::text IS NULL OR c.payer_id = ${payerId ?? null})
    AND (c.state IN ('submitted', 'acknowledged') OR EXISTS (SELECT 1 FROM insurance_claims r JOIN insurance_remittance_allocations a ON a.claim_id = r.id WHERE r.facility_id = c.facility_id AND r.claim_number = c.claim_number))
    ORDER BY c.created_on LIMIT 2000`;
  const views = await claimViews(sql, facilityId, rows);
  const claims = views.map((v) => ({
    id: v.id,
    claimNumber: v.claimNumber,
    revision: v.revision,
    payerId: v.payerId,
    patientId: v.patientId,
    patientName: v.patientName,
    enrolleeNumber: v.enrolleeNumber,
    state: v.state,
    serviceFrom: v.serviceFrom,
    serviceTo: v.serviceTo,
    currency: v.currency,
    settlement: v.settlement!,
  }));
  const totals: Record<string, Record<string, number>> = {};
  for (const c of claims) {
    const key = `${c.payerId}|${c.currency}`;
    const t = (totals[key] ??= {
      expected: 0,
      approved: 0,
      deducted: 0,
      paid: 0,
      writtenOff: 0,
      disputed: 0,
      outstanding: 0,
      payerOwes: 0,
      overdue: 0,
    });
    const s = c.settlement;
    t.expected += s.expectedMinor;
    t.approved += s.approvedMinor ?? 0;
    t.deducted += s.deductedMinor;
    t.paid += s.paidMinor;
    t.writtenOff += s.writtenOffMinor;
    t.disputed += s.disputedMinor;
    t.outstanding += s.outstandingMinor;
    t.payerOwes += s.payerOwesMinor;
    if (s.overdue) {
      t.overdue += s.payerOwesMinor;
    }
  }
  return { claims, totals };
};

/** Proposed matches for a payer's remittance spreadsheet. Nothing is recorded: a person confirms each row. */
export const matchRemittance = async (
  sql: Db,
  facilityId: string,
  payerId: string,
  rows: readonly RemittanceRow[],
) => {
  const { claims } = await outstandingClaims(sql, facilityId, payerId);
  return matchRemittanceRows(
    rows,
    claims.map((c) => ({
      claimId: c.id,
      claimNumber: c.claimNumber,
      enrolleeNumber: c.enrolleeNumber,
      patientName: c.patientName,
      outstandingMinor: c.settlement.outstandingMinor,
    })),
  );
};
