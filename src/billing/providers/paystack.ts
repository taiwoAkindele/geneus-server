import { z } from 'zod';
import { accountFromTerminal, callPaystack, PaystackAccount, validPaystackSignature, VerifiedPaystackTransfer, type PaystackFetch } from '../paystack.ts';
import { providerReply, ProviderRefused, ProviderUnexpectedReply, type CheckoutOutcome, type CheckoutRequest, type ProviderDescriptor, type ProviderMode, type ReceivingAccount, type VerifiedTransfer } from './types.ts';

/**
 * Paystack as a provider. The hospital's central account is a Paystack dedicated virtual account
 * created for the hospital itself as a Paystack customer. Virtual Terminals already linked keep
 * working (getAccount reads them), but new ones are no longer created.
 */
export const paystackDescriptor: ProviderDescriptor = {
  id: 'paystack', name: 'Paystack', countries: ['NG'], currencies: ['NGN'],
  credentialFields: [{ key: 'secretKey', label: 'Secret key', secret: true, pattern: '^sk_(test|live)_[A-Za-z0-9]+$', help: 'From Paystack: Settings → API Keys & Webhooks. Use the test key while trying things out.' }],
  accountFields: [
    { key: 'email', label: 'Hospital contact email', type: 'email', help: 'Paystack records the account under this email.' },
    { key: 'phone', label: 'Hospital phone number', type: 'tel', help: 'For example 0803 123 4567.' },
  ],
  can: { createAccount: true, listAccounts: true, verifyByReference: true },
};

export const PaystackCredentials = z.object({ secretKey: z.string().regex(/^sk_(test|live)_[A-Za-z0-9]+$/) });
export const PaystackAccountDetails = z.object({ email: z.string().email().max(200), phone: z.string().regex(/^\+[1-9]\d{7,14}$/) });
const Customer = z.object({ customer_code: z.string().min(1) });

export const paystackMode = (secretKey: string): ProviderMode => secretKey.startsWith('sk_test_') ? 'test' : 'live';
const toAccount = (a: z.infer<typeof PaystackAccount>): ReceivingAccount =>
  ({ providerAccountId: String(a.id), accountNumber: a.account_number, accountName: a.account_name, bankName: a.bank.name, active: a.active, currency: a.currency });

/** Proves the key works before it is saved. */
export const paystackCheckAccess = async (secretKey: string, http: PaystackFetch) => { await callPaystack(secretKey, '/transaction?perPage=1', http); };

/** Existing dedicated accounts on the Paystack business, for linking. */
export const paystackListAccounts = async (secretKey: string, http: PaystackFetch) =>
  providerReply(z.array(PaystackAccount), await callPaystack(secretKey, '/dedicated_account?perPage=100', http), 'dedicated account list').map(toAccount);

/** One account, re-read from Paystack: a dedicated account id, or a Virtual Terminal code linked earlier. */
export const paystackGetAccount = async (secretKey: string, id: string, http: PaystackFetch): Promise<ReceivingAccount> => id.startsWith('VT_')
  ? toAccount(accountFromTerminal(await callPaystack(secretKey, `/virtual_terminal/${encodeURIComponent(id)}`, http)))
  : toAccount(providerReply(PaystackAccount, await callPaystack(secretKey, `/dedicated_account/${encodeURIComponent(id)}`, http), 'dedicated account'));

/**
 * Creates the hospital's central account: the hospital becomes a Paystack customer, then gets a dedicated account.
 * Test keys use Paystack's test bank; in live mode Paystack chooses the bank for the business.
 */
export const paystackCreateAccount = async (secretKey: string, hospital: { name: string }, details: z.infer<typeof PaystackAccountDetails>, http: PaystackFetch): Promise<ReceivingAccount> => {
  const customer = providerReply(Customer, await callPaystack(secretKey, '/customer', http, {
    email: details.email, first_name: hospital.name.slice(0, 100), last_name: 'Hospital', phone: details.phone,
  }), 'customer');
  const created = await callPaystack(secretKey, '/dedicated_account', http, {
    customer: customer.customer_code, ...(paystackMode(secretKey) === 'test' ? { preferred_bank: 'test-bank' } : {}),
  });
  return toAccount(providerReply(PaystackAccount, created, 'dedicated account'));
};

/** Asks Paystack directly about a transfer. Only successful NGN bank transfers into a dedicated account or terminal pass. */
export const paystackVerifyTransfer = async (secretKey: string, reference: string, http: PaystackFetch): Promise<VerifiedTransfer | undefined> => {
  const verified = providerReply(VerifiedPaystackTransfer, await callPaystack(secretKey, `/transaction/verify/${encodeURIComponent(reference)}`, http), 'transfer verification');
  if (verified.reference !== reference) return undefined;
  return { reference, mode: verified.domain, amountMinor: verified.amount, currency: verified.currency, paidAt: verified.paid_at,
    receivingAccountNumber: verified.authorization.receiver_bank_account_number, payerName: verified.authorization.sender_name || undefined };
};

/** The webhook only prompts a check: a valid signature yields the reference of a successful charge. */
export const paystackWebhookReference = (raw: string, signature: unknown, secretKey: string): { ok: false } | { ok: true; reference?: string; checkoutReference?: string } => {
  if (!validPaystackSignature(raw, signature, secretKey)) return { ok: false };
  const event = z.object({ event: z.string(), data: z.object({ reference: z.string().min(1) }).partial().optional() }).safeParse((() => { try { return JSON.parse(raw); } catch { return undefined; } })());
  if (!event.success || event.data.event !== 'charge.success') return { ok: true };
  const reference = event.data.data?.reference;
  // A bill checkout uses Geneus's own reference; anything else is a transfer into the hospital's account.
  return reference?.startsWith('geneus-co-') ? { ok: true, checkoutReference: reference } : { ok: true, reference };
};

/* ---- Online checkout for a bill (Paystack Standard: /transaction/initialize, /transaction/verify) ---- */
const Initialized = z.object({ authorization_url: z.string().url(), reference: z.string().min(1) });
export const paystackStartCheckout = async (secretKey: string, input: CheckoutRequest, http: PaystackFetch) => {
  const data = providerReply(Initialized, await callPaystack(secretKey, '/transaction/initialize', http, {
    email: input.email, amount: input.amountMinor, currency: input.currency, reference: input.reference, callback_url: input.returnUrl,
    metadata: { geneus_checkout: input.reference, cancel_action: input.returnUrl, custom_fields: [{ display_name: 'Bill', variable_name: 'bill', value: input.description }] },
  }), 'checkout');
  if (data.reference !== input.reference) throw new ProviderUnexpectedReply('checkout: reference changed');
  return { checkoutUrl: data.authorization_url };
};
const CheckoutTransaction = z.object({
  reference: z.string().min(1), status: z.string(), amount: z.number().int().nonnegative(), currency: z.string(),
  domain: z.enum(['test', 'live']), paid_at: z.string().nullable().optional(), customer: z.object({ first_name: z.string().nullable().optional(), last_name: z.string().nullable().optional() }).optional(),
});
export const paystackVerifyCheckout = async (secretKey: string, reference: string, http: PaystackFetch): Promise<CheckoutOutcome> => {
  let raw: unknown;
  try { raw = await callPaystack(secretKey, `/transaction/verify/${encodeURIComponent(reference)}`, http); }
  // Paystack answers 400 "Transaction reference not found" until the patient has started paying.
  catch (cause) { if (cause instanceof ProviderRefused && cause.providerStatus === 400) return { status: 'pending' }; throw cause; }
  const t = providerReply(CheckoutTransaction, raw, 'checkout verification');
  if (t.reference !== reference) return { status: 'pending' };
  if (t.status === 'success' && t.paid_at) {
    const payerName = [t.customer?.first_name, t.customer?.last_name].filter(Boolean).join(' ') || undefined;
    return { status: 'paid', reference, mode: t.domain, amountMinor: t.amount, currency: t.currency, paidAt: new Date(t.paid_at).toISOString(), ...(payerName ? { payerName } : {}) };
  }
  // "abandoned" means the patient left the checkout page; they may still come back and pay.
  return ['failed', 'reversed'].includes(t.status) ? { status: 'failed' } : { status: 'pending' };
};
