import { paystackDescriptor } from './paystack.ts';
import type { ProviderDescriptor } from './types.ts';

/**
 * Payment providers this server supports. Adding a provider means writing its module and listing its
 * descriptor here; the setup screen is drawn from these descriptors. Monnify and Flutterwave are added
 * after their sandbox behaviour is confirmed (docs/PAYMENT-PROVIDERS-PLAN-2026-11-21.md, step 0).
 */
export const PROVIDERS: readonly ProviderDescriptor[] = [paystackDescriptor];
export const providerDescriptor = (id: string): ProviderDescriptor | undefined => PROVIDERS.find((p) => p.id === id);
