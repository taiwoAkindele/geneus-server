import type { Tx } from '../db/client.ts';
import { chargePositions, chargesById } from '../insurance/coverage.ts';

/**
 * Call with the charge row locked before deciding a reduction or allocating a transfer.
 *
 * What the patient still owes on the charge: their responsibility (the full
 * price for a cash patient, exactly as before insurance; the patient share for
 * an insured one; nothing while cover is undetermined) less reductions and
 * payments, plus refunds. A payer's part is never available to reduce or to
 * collect from the patient.
 */
export const availableOnCharge = async (tx: Tx, facilityId: string, chargeId: string): Promise<number> => {
  const [charge] = await chargesById(tx, facilityId, [chargeId]);
  if (!charge) throw new Error('Charge not found');
  return (await chargePositions(tx, facilityId, [charge])).get(chargeId)!.balanceMinor;
};
