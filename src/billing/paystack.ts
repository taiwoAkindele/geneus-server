import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const sealPaystackSecret = (secret: string, master: string, facilityId: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(master, 'hex'), iv);
  cipher.setAAD(Buffer.from(facilityId));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((v) => v.toString('base64')).join('.');
};
export const openPaystackSecret = (sealed: string, master: string, facilityId: string): string => {
  const [iv, tag, encrypted] = sealed.split('.').map((v) => Buffer.from(v, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(master, 'hex'), iv);
  decipher.setAAD(Buffer.from(facilityId)); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};
export const validPaystackSignature = (raw: string, signature: unknown, secret: string): boolean => {
  if (typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  return timingSafeEqual(createHmac('sha512', secret).update(raw).digest(), Buffer.from(signature, 'hex'));
};

export type PaystackFetch = typeof fetch;
export const callPaystack = async (secret: string, path: string, fetcher: PaystackFetch = fetch, body?: unknown): Promise<unknown> => {
  const response = await fetcher(`https://api.paystack.co${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${secret}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as { status?: boolean; data?: unknown };
  if (!response.ok || !payload.status) throw Object.assign(new Error('Paystack could not complete the request. Check the connection and account access.'), { statusCode: 502 });
  return payload.data;
};

export const PaystackAccount = z.object({
  id: z.union([z.string(), z.number()]), account_number: z.string().min(1), account_name: z.string().min(1),
  active: z.boolean(), currency: z.string(), bank: z.object({ name: z.string() }),
});
export const PaystackTerminal = z.object({
  code: z.string().regex(/^VT_[A-Za-z0-9]+$/), active: z.boolean(), currency: z.string(),
  paymentMethods: z.array(z.object({ type: z.string(), account_number: z.string().optional(), account_name: z.string().optional(), bank: z.string().optional() })),
});
export const accountFromTerminal = (value: unknown) => {
  const terminal = PaystackTerminal.parse(value);
  const method = terminal.paymentMethods.find((m) => m.type === 'dedicated_nuban' && m.account_number && m.account_name && m.bank);
  if (!terminal.active || terminal.currency !== 'NGN' || !method) throw Object.assign(new Error(`Paystack terminal ${terminal.code} has no active NGN bank details yet. Complete its setup in Paystack, then link its code here.`), { statusCode: 409 });
  return PaystackAccount.parse({ id: terminal.code, active: true, currency: terminal.currency, account_number: method.account_number, account_name: method.account_name, bank: { name: method.bank } });
};
export const VerifiedPaystackTransfer = z.object({
  reference: z.string().min(1), status: z.literal('success'),
  amount: z.number().int().positive().max(2_147_483_647), currency: z.literal('NGN'),
  domain: z.enum(['test', 'live']), paid_at: z.string().datetime({ offset: true }),
  authorization: z.object({
    channel: z.enum(['dedicated_nuban', 'bank_transfer']),
    receiver_bank_account_number: z.string().min(1), sender_name: z.string().optional(),
  }),
});
