import type { z } from 'zod';

/**
 * A payment provider that holds a hospital's central receiving account. Each provider is one module
 * registered in ./index.ts; routes, the setup screen and stored records refer to it only by `id`.
 */
export type ProviderMode = 'test' | 'live';

export type CredentialField = {
  key: string;
  label: string;
  secret: boolean;
  pattern?: string;
  help?: string;
};

/** A detail the provider needs to open the hospital's account. `select` fields offer only `options`. */
export type AccountField = {
  key: string;
  label: string;
  type: 'email' | 'tel' | 'text' | 'select';
  pattern?: string;
  help?: string;
  sensitive?: boolean;
  options?: { value: string; label: string }[];
};

/**
 * A transfer the provider has confirmed. The receiving account is identified by its number, or by the
 * provider's own account reference when the provider reports that instead (Monnify reserved accounts).
 */
export type VerifiedTransfer = {
  reference: string;
  mode: ProviderMode;
  amountMinor: number;
  currency: string;
  paidAt: string;
  receivingAccountNumber?: string;
  receivingAccountRef?: string;
  payerName?: string;
};

/** Naira (or any 2-decimal currency) as the provider reports it, to integer minor units, without floating-point arithmetic. */
export const toMinor = (value: unknown): number | undefined => {
  const textFor = () => {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? String(value) : '';
    }

    return typeof value === 'string' ? value.trim() : '';
  };

  const text = textFor();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);

  if (!match) {
    return undefined;
  }

  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));

  return Number.isSafeInteger(minor) && minor > 0 && minor <= 2_147_483_647 ? minor : undefined;
};

/** What the setup screen needs to know. Sent to devices as data: never contains a secret. */
export type ProviderDescriptor = {
  id: string;
  name: string;
  countries: string[];
  currencies: string[];
  credentialFields: CredentialField[];
  /** Details the provider needs to open the hospital's account (for example a contact email). */
  accountFields: AccountField[];
  can: { createAccount: boolean; listAccounts: boolean; verifyByReference: boolean };
};

export type ReceivingAccount = {
  providerAccountId: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  active: boolean;
  currency: string;
};

export type ProviderHttp = typeof fetch;

/** Display-safe provider ids, also accepted by the database and the shared contract. */
export const PROVIDER_ID = /^[a-z][a-z0-9_]{1,31}$/;

/**
 * The provider said no. Its own reason is kept only when it reads as plain guidance;
 * the message never names the provider, a key, an address or internal detail.
 */
export class ProviderRefused extends Error {
  readonly statusCode = 502;
  readonly code = 'provider_refused';
  readonly providerReason: string | undefined;
  readonly providerStatus: number | undefined;
  /** Which provider call failed (path only, never keys or personal details), for the server log. */
  providerCall?: string;
  constructor(providerReason: string | undefined, providerStatus?: number) {
    const reason = safeProviderReason(providerReason);
    super(
      reason
        ? `The provider refused this operation: ${reason}`
        : "The provider refused this operation. Check the account's access and settings with the provider.",
    );

    this.providerReason = providerReason;
    this.providerStatus = providerStatus;
  }
}

/**
 * The provider couldn't be reached, timed out, or said it is unavailable (5xx). A specific message can replace
 * the default when the caller knows more (for example, a bank the provider can't open accounts at).
 */
export class ProviderUnavailable extends Error {
  readonly statusCode = 502;
  readonly code = 'provider_unavailable';
  readonly providerReason: string | undefined;
  readonly providerStatus: number | undefined;
  providerCall?: string;
  constructor(providerReason?: string, providerStatus?: number, message?: string) {
    const reason = safeProviderReason(providerReason);
    super(
      message ??
        (reason
          ? `The provider is unavailable right now: ${reason}${/try again/i.test(reason) ? '' : ' Try again later.'}`
          : 'The provider could not be reached. Try again in a moment.'),
    );

    this.providerReason = providerReason;
    this.providerStatus = providerStatus;
  }
}

/** A refusal or an unavailable answer, chosen by the provider's HTTP status. */
export const providerFailure = (reason: string | undefined, status: number, call: string) => {
  const error =
    status >= 500 ? new ProviderUnavailable(reason, status) : new ProviderRefused(reason, status);

  error.providerCall = call;

  return error;
};

/** The provider answered, but not in the form expected; details go to the server log only. */
export class ProviderUnexpectedReply extends Error {
  readonly statusCode = 502;
  readonly code = 'provider_unexpected_reply';
  readonly detail: string;
  constructor(detail: string) {
    super("The provider's reply wasn't in the expected form. Try again, or contact support.");
    this.detail = detail;
  }
}

export const PROVIDER_ERROR_CODES: readonly string[] = [
  'provider_refused',
  'provider_unavailable',
  'provider_unexpected_reply',
];

const UNSAFE =
  /(sk|pk)_(test|live)|https?:\/\/|www\.|[{}<>`\\]|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b(secret|token|password|stack|exception)\b/i;

export const safeProviderReason = (reason: unknown): string | undefined => {
  if (typeof reason !== 'string') {
    return undefined;
  }

  const text = reason
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '');

  if (!text || text.length > 160 || UNSAFE.test(text)) {
    return undefined;
  }

  return `${text}.`;
};

/** Parse a provider reply; a mismatch becomes ProviderUnexpectedReply instead of an unexplained server error. */
export const providerReply = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new ProviderUnexpectedReply(
      `${what}: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.code}`).join(', ')}`,
    );
  }

  return result.data;
};

/** What a provider's hosted checkout needs to take one payment for one bill. Amounts are minor units. */
export type CheckoutRequest = {
  reference: string;
  amountMinor: number;
  currency: string;
  email: string;
  name: string;
  description: string;
  returnUrl: string;
};

/** The provider's answer about a checkout, asked directly by the server (a redirect or webhook is never proof). */
export type CheckoutOutcome =
  | {
      status: 'paid';
      reference: string;
      mode: ProviderMode;
      amountMinor: number;
      currency: string;
      paidAt: string;
      payerName?: string;
    }
  | { status: 'pending' }
  | { status: 'failed' };
