import { z } from 'zod';
import { accountFromTerminal, callPaystack, PaystackAccount, validPaystackSignature, VerifiedPaystackTransfer, type PaystackFetch } from '../paystack.ts';
import { providerReply, type ProviderDescriptor, type ProviderMode, type ReceivingAccount, type VerifiedTransfer } from './types.ts';

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
export const paystackWebhookReference = (raw: string, signature: unknown, secretKey: string): { ok: false } | { ok: true; reference?: string } => {
  if (!validPaystackSignature(raw, signature, secretKey)) return { ok: false };
  const event = z.object({ event: z.string(), data: z.object({ reference: z.string().min(1) }).partial().optional() }).safeParse((() => { try { return JSON.parse(raw); } catch { return undefined; } })());
  if (!event.success || event.data.event !== 'charge.success') return { ok: true };
  return { ok: true, reference: event.data.data?.reference };
};
