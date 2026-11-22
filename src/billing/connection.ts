import type { Sql, Tx } from '../db/client.ts';
import type { Config } from '../lib/config.ts';
import { openPaystackSecret } from './paystack.ts';
import { deserialiseCredentials, paymentProvider } from './providers/index.ts';

const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
type ConnectionRow = { encrypted_secret: string; mode: 'test' | 'live'; provider: string };

/** The hospital's connected payment provider with its opened credentials. Throws a 409 with a safe message when there is none. */
export const providerConnection = async (sql: Sql | Tx, config: Pick<Config, 'billingEncryptionKey'>, facilityId: string) => {
  if (!config.billingEncryptionKey) throw conflict('Payment setup isn\'t finished on the server. Ask your system administrator.');
  const [row] = await sql<ConnectionRow[]>`SELECT encrypted_secret, mode, provider FROM billing_connections WHERE facility_id = ${facilityId}`;
  if (!row) throw conflict('Connect the hospital\'s payment provider first');
  const provider = paymentProvider(row.provider);
  if (!provider) throw conflict('The hospital\'s payment provider is no longer supported. Connect a supported provider.');
  const credentials = deserialiseCredentials(provider, openPaystackSecret(row.encrypted_secret, config.billingEncryptionKey, facilityId));
  return { provider, providerId: row.provider, credentials, mode: row.mode, encryptedSecret: row.encrypted_secret };
};
export type ProviderConnection = Awaited<ReturnType<typeof providerConnection>>;

/** Whether patients can pay this hospital online: a connected provider that offers a checkout. */
export const checkoutAvailable = async (
  sql: Sql | Tx,
  config: Pick<Config, 'billingEncryptionKey'>,
  facilityId: string,
  currency: string,
) => {
  if (!config.billingEncryptionKey) {
    return false;
  }

  const [row] = await sql<{ provider: string }[]>`SELECT provider FROM billing_connections WHERE facility_id = ${facilityId}`;
  const provider = row ? paymentProvider(row.provider) : undefined;

  return Boolean(provider?.checkout && provider.descriptor.currencies.includes(currency));
};
