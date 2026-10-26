import type { StockMovement } from '#shared';

export const stockMovementIssue = (movement: Pick<StockMovement, 'change' | 'reason' | 'note'>): string | undefined => {
  if (!Number.isFinite(movement.change) || movement.change === 0) return 'Stock movements must record a non-zero quantity';
  if (movement.reason === 'received' && movement.change <= 0) return 'Received stock must increase the quantity';
  if (['dispensed', 'expired'].includes(movement.reason) && movement.change >= 0) return 'Dispensed or expired stock must decrease the quantity';
  if (['adjustment', 'transfer'].includes(movement.reason) && !movement.note?.trim()) return 'A stock adjustment or transfer needs an explanation';
  return undefined;
};
