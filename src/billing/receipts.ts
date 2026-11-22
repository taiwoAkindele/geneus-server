import { randomBytes } from 'node:crypto';
import type { Tx } from '../db/client.ts';

/**
 * The next server-issued receipt number for a hospital, e.g. SH-R-000105-3F. Call inside the transaction that
 * records the payment, after locking the facility row, so two server payments never take the same number.
 */
export const nextReceiptNumber = async (tx: Tx, facilityId: string): Promise<string> => {
  const [receiptSequence] = await tx<{ n: number }[]>`SELECT COALESCE(MAX(substring(receipt_number FROM char_length(${facilityId}) + 4 FOR 6)::int), 0) + 1 AS n FROM payments WHERE facility_id = ${facilityId}`;
  const next = receiptSequence.n;

  if (next > 999999) {
    throw Object.assign(new Error('Receipt sequence exhausted'), { statusCode: 409 });
  }

  return `${facilityId}-R-${String(next).padStart(6, '0')}-${randomBytes(1).toString('hex').toUpperCase()}`;
};
