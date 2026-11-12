import { Refund, RefundMethod, SCHEMA_VERSION, currencyCode, minorUnits } from '#shared';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Tx } from '../db/client.ts';
import { fromRow, insertRecord } from '../db/records.ts';
import { chargePositions, chargesById } from './coverage.ts';

export const RefundRequest = z.strictObject({
  /** Minted by the client so a retry is recognised; a different body under the same id is refused. */
  id: z.string().regex(/^refund:[A-Za-z0-9_-]{8,100}$/),
  patientId: z.string().min(1),
  method: RefundMethod,
  currency: currencyCode,
  allocations: z.array(z.strictObject({ chargeId: z.string().min(1), amountMinor: minorUnits.positive() })).min(1).max(100),
  reason: z.string().trim().min(1).max(1000),
  reference: z.string().trim().min(1).max(200).optional(),
});
export type RefundRequest = z.infer<typeof RefundRequest>;

export class RefundRefusal extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) { super(message); this.name = 'RefundRefusal'; this.code = code; this.details = details; }
}

const sameRequest = (refund: Refund, request: RefundRequest, staffId: string) =>
  refund.patientId === request.patientId && refund.method === request.method && refund.currency === request.currency && refund.createdBy === staffId
  && refund.reason === request.reason && (refund.reference ?? undefined) === request.reference && isDeepStrictEqual(refund.allocations, request.allocations);

/**
 * Hands money back from a credit. Each charge is locked, and the refund must
 * fit both the credit (what was paid beyond the patient's final responsibility)
 * and the money actually received (a waiver is not cash to give back). A
 * charge whose responsibility can still change — an estimate, or undetermined
 * cover — has no refundable credit yet. Payments are never altered.
 */
export const recordRefund = async (tx: Tx, input: { facilityId: string; deviceId: string; staffId: string; request: RefundRequest }): Promise<{ refund: Refund; replayed: boolean }> => {
  const { request } = input;
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`${input.facilityId}:${request.id}`}))`;
  const [prior] = await tx`SELECT * FROM refunds WHERE facility_id = ${input.facilityId} AND id = ${request.id}`;
  if (prior) {
    const refund = fromRow<Refund>('refund', prior);
    if (!sameRequest(refund, request, input.staffId)) throw new RefundRefusal('request_reused', 'This refund request was already used for a different refund');
    return { refund, replayed: true };
  }
  const ids = request.allocations.map((a) => a.chargeId);
  if (new Set(ids).size !== ids.length) throw new RefundRefusal('invalid_request', 'Refund each charge once');
  const charges = await chargesById(tx, input.facilityId, ids, true);
  const positions = await chargePositions(tx, input.facilityId, charges);
  for (const allocation of request.allocations) {
    const position = positions.get(allocation.chargeId);
    if (!position || position.charge.patientId !== request.patientId || position.charge.currency !== request.currency) throw new RefundRefusal('invalid_charge', "Choose this patient's charges in the refund currency");
    if (!position.final) throw new RefundRefusal('responsibility_not_final', 'Insurance responsibility for this charge is not final yet. Confirm it before refunding', { chargeId: allocation.chargeId });
    const credit = -position.balanceMinor;
    const cashHeld = position.money.receivedMinor - position.money.refundedMinor;
    if (allocation.amountMinor > credit || allocation.amountMinor > cashHeld) throw new RefundRefusal('exceeds_credit', 'The refund is more than the credit on this charge. Refresh the patient account', { chargeId: allocation.chargeId, creditMinor: Math.max(0, credit), cashHeldMinor: Math.max(0, cashHeld) });
  }
  await tx`SELECT id FROM facilities WHERE id = ${input.facilityId} FOR UPDATE`;
  const [{ n }] = await tx<{ n: number }[]>`SELECT COUNT(*)::int + 1 AS n FROM refunds WHERE facility_id = ${input.facilityId}`;
  if (n > 999_999) throw new RefundRefusal('sequence_exhausted', 'Refund sequence exhausted');
  const refund = Refund.parse({
    id: request.id, type: 'refund', facilityId: input.facilityId, schemaVersion: SCHEMA_VERSION, createdBy: input.staffId, createdOn: new Date().toISOString(),
    deviceId: input.deviceId, patientId: request.patientId, refundNumber: `${input.facilityId}-F-${String(n).padStart(6, '0')}`,
    method: request.method, amountMinor: request.allocations.reduce((sum, a) => sum + a.amountMinor, 0), currency: request.currency,
    allocations: request.allocations, reason: request.reason, ...(request.reference ? { reference: request.reference } : {}),
  });
  await insertRecord(tx, 'refund', refund);
  return { refund, replayed: false };
};
