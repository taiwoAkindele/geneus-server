import type { PaystackFetch } from '../paystack.ts';
import {
  paystackCheckAccess, paystackCreateAccount, paystackDescriptor, paystackGetAccount, paystackListAccounts, paystackMode,
  paystackVerifyTransfer, paystackWebhookReference, PaystackAccountDetails, PaystackCredentials,
} from './paystack.ts';
import {
  monnifyCheckAccess, monnifyCreateAccount, monnifyDescriptor, monnifyGetAccount, monnifyMode, monnifyVerifyTransfer,
  monnifyWebhookReference, MonnifyAccountDetails, MonnifyCredentials,
} from './monnify.ts';
import type { ProviderDescriptor, ProviderMode, ReceivingAccount, VerifiedTransfer } from './types.ts';

type Credentials = Record<string, string>;
/**
 * What the routes need from a provider. Every provider implements the same jobs, so routes never mention
 * a provider by name. Adding a provider: write its module, add an entry here, add fixture-based tests.
 */
export type PaymentProvider = {
  descriptor: ProviderDescriptor;
  /** Validated credentials, or undefined when they don't match the provider's format. */
  credentials: (input: unknown) => Credentials | undefined;
  /** Validated account-opening details, or undefined. */
  accountDetails: (input: unknown) => Credentials | undefined;
  mode: (credentials: Credentials) => ProviderMode;
  checkAccess: (credentials: Credentials, http: PaystackFetch) => Promise<void>;
  createAccount: (credentials: Credentials, hospital: { id: string; name: string }, details: Credentials, http: PaystackFetch) => Promise<ReceivingAccount>;
  getAccount: (credentials: Credentials, providerAccountId: string, http: PaystackFetch) => Promise<ReceivingAccount>;
  listAccounts?: (credentials: Credentials, http: PaystackFetch) => Promise<ReceivingAccount[]>;
  verifyTransfer: (credentials: Credentials, reference: string, http: PaystackFetch) => Promise<VerifiedTransfer | undefined>;
  /** Header that carries the webhook signature, and the check itself. */
  webhookHeader: string;
  webhookReference: (raw: string, signature: unknown, credentials: Credentials) => { ok: false } | { ok: true; reference?: string };
  /** Paystack stored a bare secret key before providers existed; others store a JSON bundle. */
  storesBareSecret?: boolean;
};

const parse = <T extends Credentials>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }) => (input: unknown) => { const r = schema.safeParse(input); return r.success ? r.data : undefined; };

const paystack: PaymentProvider = {
  descriptor: paystackDescriptor, storesBareSecret: true,
  credentials: parse(PaystackCredentials), accountDetails: parse(PaystackAccountDetails),
  mode: (c) => paystackMode(c.secretKey),
  checkAccess: (c, http) => paystackCheckAccess(c.secretKey, http),
  createAccount: (c, hospital, d, http) => paystackCreateAccount(c.secretKey, hospital, { email: d.email, phone: d.phone }, http),
  getAccount: (c, id, http) => paystackGetAccount(c.secretKey, id, http),
  listAccounts: (c, http) => paystackListAccounts(c.secretKey, http),
  verifyTransfer: (c, reference, http) => paystackVerifyTransfer(c.secretKey, reference, http),
  webhookHeader: 'x-paystack-signature',
  webhookReference: (raw, signature, c) => paystackWebhookReference(raw, signature, c.secretKey),
};

const monnify: PaymentProvider = {
  descriptor: monnifyDescriptor,
  credentials: parse(MonnifyCredentials), accountDetails: parse(MonnifyAccountDetails),
  mode: (c) => monnifyMode({ apiKey: c.apiKey }),
  checkAccess: (c, http) => monnifyCheckAccess(c as MonnifyCredentials, http),
  createAccount: (c, hospital, d, http) => monnifyCreateAccount(c as MonnifyCredentials, hospital, { email: d.email, bvn: d.bvn }, http),
  getAccount: (c, id, http) => monnifyGetAccount(c as MonnifyCredentials, id, http),
  verifyTransfer: (c, reference, http) => monnifyVerifyTransfer(c as MonnifyCredentials, reference, http),
  webhookHeader: 'monnify-signature',
  webhookReference: (raw, signature, c) => monnifyWebhookReference(raw, signature, { secretKey: c.secretKey }),
};

const REGISTRY: Record<string, PaymentProvider> = { paystack, monnify };
/** Descriptors for the setup screen, in the order offered. */
export const PROVIDERS: readonly ProviderDescriptor[] = Object.values(REGISTRY).map((p) => p.descriptor);
export const providerDescriptor = (id: string): ProviderDescriptor | undefined => REGISTRY[id]?.descriptor;
export const paymentProvider = (id: string): PaymentProvider | undefined => Object.hasOwn(REGISTRY, id) ? REGISTRY[id] : undefined;

/** Credentials are sealed as the bare key for Paystack (as before providers existed), or as JSON for others. */
export const serialiseCredentials = (provider: PaymentProvider, credentials: Credentials) => provider.storesBareSecret ? credentials.secretKey : JSON.stringify(credentials);
export const deserialiseCredentials = (provider: PaymentProvider, opened: string): Credentials => provider.storesBareSecret ? { secretKey: opened } : JSON.parse(opened) as Credentials;
