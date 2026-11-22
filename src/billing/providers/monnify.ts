import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { providerFailure, ProviderRefused, ProviderUnavailable, ProviderUnexpectedReply, providerReply, toMinor, type CheckoutOutcome, type CheckoutRequest, type ProviderDescriptor, type ProviderHttp, type ProviderMode, type ReceivingAccount, type VerifiedTransfer } from './types.ts';

/**
 * Partner banks the hospital can choose for its one account number. Wema and Sterling open reserved
 * accounts in the sandbox (checked 21 Nov 2026); GTBank, Fidelity and Moniepoint MFB answered 503 there.
 * Monnify also answers 503 when asked for a bank it doesn't offer, so the list is kept to banks seen working.
 */
export const MONNIFY_BANKS = [{ value: '035', label: 'Wema Bank' }, { value: '232', label: 'Sterling Bank' }] as const;

/**
 * Moniepoint's collections API (Monnify). The hospital's central account is a reserved account under the
 * hospital's contract code, at the one partner bank the hospital chooses.
 *
 * UNCONFIRMED until the end-to-end sandbox run: the webhook hash (SHA-512 assumed), the transaction
 * lookup's field names and date timezone. A mismatch is reported as ProviderUnexpectedReply with the
 * field named in the server log, never guessed past.
 */
export const monnifyDescriptor: ProviderDescriptor = {
  id: 'monnify', name: 'Moniepoint (Monnify)', countries: ['NG'], currencies: ['NGN'],
  credentialFields: [
    { key: 'apiKey', label: 'API key', secret: false, pattern: '^MK_[A-Z]+_[A-Za-z0-9]+$', help: 'From Monnify: Developer → API keys. Use the sandbox keys while trying things out.' },
    { key: 'secretKey', label: 'Secret key', secret: true, pattern: '^[A-Za-z0-9]{16,}$' },
    { key: 'contractCode', label: 'Contract code', secret: false, pattern: '^\\d{6,20}$' },
  ],
  accountFields: [
    { key: 'bank', label: 'Bank for the hospital\'s account', type: 'select', options: [...MONNIFY_BANKS], help: 'Patients transfer to an account number at this bank.' },
    { key: 'email', label: 'Hospital contact email', type: 'email', help: 'Monnify records the account under this email.' },
    { key: 'bvn', label: 'BVN of the hospital\'s owner or director', type: 'text', pattern: '^\\d{11}$', sensitive: true, help: 'Required by Monnify to open the account. Sent to Monnify only; Geneus doesn\'t store it.' },
  ],
  can: { createAccount: true, listAccounts: false, verifyByReference: true },
};

export const MonnifyCredentials = z.object({ apiKey: z.string().regex(/^MK_[A-Z]+_[A-Za-z0-9]+$/), secretKey: z.string().regex(/^[A-Za-z0-9]{16,}$/), contractCode: z.string().regex(/^\d{6,20}$/) });
export type MonnifyCredentials = z.infer<typeof MonnifyCredentials>;
export const MonnifyAccountDetails = z.object({
  bank: z.enum(MONNIFY_BANKS.map((b) => b.value) as [string, ...string[]]),
  email: z.string().email().max(200), bvn: z.string().regex(/^\d{11}$/),
});
export const monnifyMode = (c: Pick<MonnifyCredentials, 'apiKey'>): ProviderMode => c.apiKey.startsWith('MK_TEST_') ? 'test' : 'live';
const base = (c: MonnifyCredentials) => monnifyMode(c) === 'test' ? 'https://sandbox.monnify.com' : 'https://api.monnify.com';

type Envelope = { requestSuccessful?: boolean; responseMessage?: unknown; responseBody?: unknown };
const request = async (http: ProviderHttp, url: string, init: RequestInit): Promise<unknown> => {
  let response: Response;
  try { response = await http(url, { ...init, signal: AbortSignal.timeout(15_000) }); } catch { throw new ProviderUnavailable(); }
  const payload = await response.json().catch(() => undefined) as Envelope | undefined;
  if (!payload) throw new ProviderUnexpectedReply(`HTTP ${response.status} without JSON`);
  if (!response.ok || payload.requestSuccessful !== true) throw providerFailure(typeof payload.responseMessage === 'string' ? payload.responseMessage : undefined, response.status, new URL(url).pathname);
  return payload.responseBody;
};

/** Access tokens live in memory only, per API key, until shortly before they expire. */
const tokens = new Map<string, { token: string; until: number }>();
const Login = z.object({ accessToken: z.string().min(1), expiresIn: z.number().positive() });
const accessToken = async (c: MonnifyCredentials, http: ProviderHttp, now = Date.now()) => {
  const cached = tokens.get(c.apiKey);
  if (cached && cached.until > now) return cached.token;
  const body = providerReply(Login, await request(http, `${base(c)}/api/v1/auth/login`, {
    method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${c.apiKey}:${c.secretKey}`).toString('base64')}`, accept: 'application/json' },
  }), 'login');
  tokens.set(c.apiKey, { token: body.accessToken, until: now + Math.max(0, body.expiresIn - 60) * 1000 });
  return body.accessToken;
};
const call = async (c: MonnifyCredentials, http: ProviderHttp, path: string, body?: unknown) => request(http, `${base(c)}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { authorization: `Bearer ${await accessToken(c, http)}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
/** For tests: forget cached tokens. */
export const resetMonnifyTokens = () => tokens.clear();

const Reserved = z.object({
  accountReference: z.string().min(1), accountName: z.string().min(1), currencyCode: z.string(), status: z.string().optional(),
  accounts: z.array(z.object({ bankCode: z.string().optional(), bankName: z.string().min(1), accountNumber: z.string().min(1), accountName: z.string().optional() })).min(1),
});
const toAccount = (r: z.infer<typeof Reserved>, bank?: string): ReceivingAccount => {
  // One account number per hospital: the chosen bank's, if Monnify returned several.
  const chosen = r.accounts.find((a) => a.bankCode === bank) ?? r.accounts[0];
  return { providerAccountId: r.accountReference, accountNumber: chosen.accountNumber, accountName: chosen.accountName ?? r.accountName,
    bankName: chosen.bankName, active: (r.status ?? 'ACTIVE').toUpperCase() === 'ACTIVE', currency: r.currencyCode };
};

export const monnifyCheckAccess = async (c: MonnifyCredentials, http: ProviderHttp) => { tokens.delete(c.apiKey); await accessToken(c, http); };

/** The hospital's reserved account; the account reference is derived from the facility so a retry finds the same account. */
export const monnifyAccountReference = (facilityId: string) => `geneus-${facilityId}`;
export const monnifyCreateAccount = async (c: MonnifyCredentials, hospital: { id: string; name: string }, details: z.infer<typeof MonnifyAccountDetails>, http: ProviderHttp) => {
  let reply: unknown;
  try {
    reply = await call(c, http, '/api/v2/bank-transfer/reserved-accounts', {
      accountReference: monnifyAccountReference(hospital.id), accountName: hospital.name.slice(0, 100), currencyCode: 'NGN', contractCode: c.contractCode,
      customerEmail: details.email, customerName: hospital.name.slice(0, 100), bvn: details.bvn, getAllAvailableBanks: false, preferredBanks: [details.bank],
    });
  } catch (error) {
    // Monnify says "unavailable" both during outages and for a bank it can't open accounts at; say both.
    if (error instanceof ProviderUnavailable && error.providerStatus !== undefined) {
      const specific = new ProviderUnavailable(error.providerReason, error.providerStatus, 'The provider couldn\'t open an account at that bank right now. Choose another bank, or try again later.');
      specific.providerCall = error.providerCall; throw specific;
    }
    throw error;
  }
  return toAccount(providerReply(Reserved, reply, 'reserved account'), details.bank);
};

export const monnifyGetAccount = async (c: MonnifyCredentials, accountReference: string, http: ProviderHttp) =>
  toAccount(providerReply(Reserved, await call(c, http, `/api/v2/bank-transfer/reserved-accounts/${encodeURIComponent(accountReference)}`), 'reserved account'));

const Transaction = z.object({
  transactionReference: z.string().min(1), paymentStatus: z.string(), amountPaid: z.union([z.number(), z.string()]),
  currencyCode: z.string().optional(), currency: z.string().optional(),
  paidOn: z.string().optional(), completedOn: z.string().optional(),
  product: z.object({ type: z.string(), reference: z.string().optional() }).optional(),
  customer: z.object({ name: z.string().optional() }).optional(),
  paymentSourceInformation: z.array(z.object({ accountName: z.string().optional() })).optional(),
  destinationAccountInformation: z.object({ accountNumber: z.string().optional() }).optional(),
});
/** Monnify dates may come without a "T" or with "+0000"; normalise to ISO or refuse. */
const isoDate = (value: string | undefined) => {
  if (!value) return undefined;
  const normalised = value.trim().replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const at = Date.parse(normalised);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
};

/** Asks Monnify directly whether a payment into a reserved account succeeded. Only PAID reserved-account payments pass. */
export const monnifyVerifyTransfer = async (c: MonnifyCredentials, reference: string, http: ProviderHttp): Promise<VerifiedTransfer | undefined> => {
  const t = providerReply(Transaction, await call(c, http, `/api/v2/transactions/${encodeURIComponent(reference)}`), 'transaction');
  if (t.transactionReference !== reference || t.paymentStatus.toUpperCase() !== 'PAID' || t.product?.type !== 'RESERVED_ACCOUNT') return undefined;
  const amountMinor = toMinor(t.amountPaid), paidAt = isoDate(t.paidOn ?? t.completedOn), currency = t.currencyCode ?? t.currency ?? 'NGN';
  if (!amountMinor || !paidAt) throw new ProviderUnexpectedReply(`transaction: ${!amountMinor ? 'amountPaid' : 'paidOn'} not understood`);
  return { reference, mode: monnifyMode(c), amountMinor, currency, paidAt,
    receivingAccountNumber: t.destinationAccountInformation?.accountNumber, receivingAccountRef: t.product.reference,
    payerName: t.paymentSourceInformation?.[0]?.accountName || t.customer?.name || undefined };
};

/** The webhook only prompts a check: a valid signature yields the transaction reference to verify. */
export const monnifyWebhookReference = (raw: string, signature: unknown, c: Pick<MonnifyCredentials, 'secretKey'>): { ok: false } | { ok: true; reference?: string; checkoutReference?: string } => {
  if (typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)) return { ok: false };
  if (!timingSafeEqual(createHmac('sha512', c.secretKey).update(raw).digest(), Buffer.from(signature, 'hex'))) return { ok: false };
  const event = z.object({ eventType: z.string(), eventData: z.object({ transactionReference: z.string().min(1), paymentReference: z.string().optional(), product: z.object({ type: z.string(), reference: z.string().optional() }).optional() }).optional() }).safeParse((() => { try { return JSON.parse(raw); } catch { return undefined; } })());
  if (!event.success) return { ok: true };
  if (event.data.eventType !== 'SUCCESSFUL_TRANSACTION' || !event.data.eventData) return { ok: true };
  const product = event.data.eventData.product;
  // A bill checkout reports our payment reference as the product reference; a reserved account reports a transfer.
  const checkoutReference = event.data.eventData.paymentReference ?? product?.reference;

  if (product?.type !== 'RESERVED_ACCOUNT' && checkoutReference?.startsWith('geneus-co-')) {
    return { ok: true, checkoutReference };
  }
  return product?.type === 'RESERVED_ACCOUNT' ? { ok: true, reference: event.data.eventData.transactionReference } : { ok: true };
};

/* ---- Online checkout for a bill (Monnify: init-transaction, then the transaction query by payment reference) ---- */
const Started = z.object({ checkoutUrl: z.string().url(), paymentReference: z.string().min(1) });
export const monnifyStartCheckout = async (c: MonnifyCredentials, input: CheckoutRequest, http: ProviderHttp) => {
  const body = providerReply(Started, await call(c, http, '/api/v1/merchant/transactions/init-transaction', {
    amount: (input.amountMinor / 100).toFixed(2),
    customerName: input.name,
    customerEmail: input.email,
    paymentReference: input.reference,
    paymentDescription: input.description,
    currencyCode: input.currency,
    contractCode: c.contractCode,
    redirectUrl: input.returnUrl,
    paymentMethods: ['CARD', 'ACCOUNT_TRANSFER', 'USSD'],
  }), 'checkout');

  if (body.paymentReference !== input.reference) {
    throw new ProviderUnexpectedReply('checkout: payment reference changed');
  }

  return { checkoutUrl: body.checkoutUrl };
};

const Queried = z.object({
  paymentReference: z.string().min(1),
  paymentStatus: z.string(),
  amountPaid: z.union([z.number(), z.string()]).optional(),
  currencyCode: z.string().optional(),
  currency: z.string().optional(),
  paidOn: z.string().nullable().optional(),
  completedOn: z.string().nullable().optional(),
  customerName: z.string().optional(),
});

export const monnifyVerifyCheckout = async (c: MonnifyCredentials, reference: string, http: ProviderHttp): Promise<CheckoutOutcome> => {
  let raw: unknown;

  try {
    raw = await call(c, http, `/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(reference)}`);
  } catch (cause) {
    if (cause instanceof ProviderRefused && cause.providerStatus === 404) {
      return { status: 'pending' };
    }

    throw cause;
  }

  const transaction = providerReply(Queried, raw, 'checkout query');

  if (transaction.paymentReference !== reference) {
    return { status: 'pending' };
  }

  const status = transaction.paymentStatus.toUpperCase();

  // Money arrived in every one of these; a partial or excess amount is applied up to what's due and the rest held.
  if (status === 'PAID' || status === 'OVERPAID' || status === 'PARTIALLY_PAID') {
    const amountMinor = toMinor(transaction.amountPaid);
    const paidAt = isoDate(transaction.paidOn ?? transaction.completedOn ?? undefined);
    const currency = transaction.currencyCode ?? transaction.currency;

    if (!amountMinor || !paidAt || !currency) {
      throw new ProviderUnexpectedReply('checkout query: amountPaid, paidOn or currency missing or invalid');
    }

    return {
      status: 'paid',
      reference,
      mode: monnifyMode(c),
      amountMinor,
      currency,
      paidAt,
      ...(transaction.customerName ? { payerName: transaction.customerName } : {}),
    };
  }

  return ['FAILED', 'CANCELLED', 'EXPIRED', 'REVERSED'].includes(status) ? { status: 'failed' } : { status: 'pending' };
};
