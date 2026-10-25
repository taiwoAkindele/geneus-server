import type { Tx } from '../db/client.ts';

/** Call with the charge row locked before deciding a reduction or allocating a transfer. */
export const availableOnCharge = async (tx: Tx, facilityId: string, chargeId: string): Promise<number> => {
  const [charge] = await tx<{ amount_minor: number }[]>`SELECT amount_minor FROM charges WHERE facility_id = ${facilityId} AND id = ${chargeId}`;
  if (!charge) throw new Error('Charge not found');
  const adjustments = await tx<{ amount_minor: number }[]>`SELECT amount_minor FROM billing_adjustments WHERE facility_id = ${facilityId} AND charge_id = ${chargeId}`;
  const payments = await tx<{ allocations: { chargeId: string; amountMinor: number }[]; reverses: string | null }[]>`
    SELECT allocations, reverses FROM payments WHERE facility_id = ${facilityId} AND allocations @> ${tx.json([{ chargeId }])}`;
  const reduced = adjustments.reduce((n, a) => n + a.amount_minor, 0);
  const paid = payments.reduce((n, p) => n + (p.reverses ? -1 : 1) * p.allocations.filter((a) => a.chargeId === chargeId).reduce((v, a) => v + a.amountMinor, 0), 0);
  return charge.amount_minor - reduced - paid;
};
