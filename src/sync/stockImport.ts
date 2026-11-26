import type { FeeItem, UploadMutation } from '#shared';
import type { Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';

const MAX_ITEMS = 500;

export const isStockImport = (mutations: readonly UploadMutation[]): boolean => {
  if (mutations.length > MAX_ITEMS * 2) {
    return false;
  }

  const stock = mutations.filter((mutation) => mutation.table === 'stock_item');
  const prices = mutations.filter((mutation) => mutation.table === 'fee_item');
  const referencedPrices = new Set(stock.map((mutation) => mutation.data.feeItemId));

  return (
    stock.length > 0 &&
    stock.length <= MAX_ITEMS &&
    prices.length <= MAX_ITEMS &&
    stock.length + prices.length === mutations.length &&
    new Set(mutations.map((mutation) => mutation.clientId)).size === mutations.length &&
    new Set(mutations.map((mutation) => mutation.id)).size === mutations.length &&
    mutations.every((mutation) => mutation.op === 'put') &&
    stock.every((mutation) => {
      const amount = mutation.previous?.amountMinor;

      return (
        mutation.data.category === 'drug' &&
        typeof mutation.data.unitOfMeasure === 'string' &&
        Boolean(mutation.data.unitOfMeasure.trim()) &&
        typeof mutation.data.feeItemId === 'string' &&
        typeof amount === 'number' &&
        Number.isSafeInteger(amount) &&
        amount >= 0
      );
    }) &&
    prices.every(
      (mutation) =>
        mutation.data.category === 'pharmacy' &&
        mutation.data.active === true &&
        referencedPrices.has(mutation.id),
    )
  );
};

/** Called while holding the facility lock, after checking the mutation receipt. */
export const stockImportIssue = async (
  tx: Tx,
  facilityId: string,
  mutation: UploadMutation,
): Promise<string | undefined> => {
  if (mutation.table === 'fee_item') {
    const existing = await findRecord(tx, 'fee_item', mutation.id);

    return existing
      ? 'An existing Pharmacy price cannot be replaced by a medicine import.'
      : undefined;
  }

  if (mutation.table !== 'stock_item') {
    return undefined;
  }

  const existing = await findRecord(tx, 'stock_item', mutation.id);
  const [duplicate] = await tx`
    SELECT id FROM stock_items
    WHERE facility_id = ${facilityId}
      AND lower(btrim(name)) = lower(btrim(${String(mutation.data.name ?? '')}))
      AND lower(btrim(unit_of_measure)) = lower(btrim(${String(mutation.data.unitOfMeasure ?? '')}))
    LIMIT 1
  `;

  if (existing || duplicate) {
    return 'A medicine and stock unit already exist. Check the file again to skip existing items.';
  }

  const feeId = String(mutation.data.feeItemId ?? '');
  const fee = await findRecord<FeeItem>(tx, 'fee_item', feeId);
  // Legacy facilities use the same default as the Prices workspace.
  const [facility] =
    await tx`SELECT COALESCE(currency, 'NGN') AS currency FROM facilities WHERE id = ${facilityId}`;

  if (
    !fee ||
    fee.facilityId !== facilityId ||
    !fee.active ||
    fee.category !== 'pharmacy' ||
    fee.currency !== facility?.currency ||
    fee.amountMinor !== mutation.previous?.amountMinor
  ) {
    return 'A selected Pharmacy price is missing or has changed. Review the current prices and try again.';
  }

  return undefined;
};
