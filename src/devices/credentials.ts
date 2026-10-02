import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql, Tx } from '../db/client.ts';

/**
 * The device credential: the long-lived secret an enrolled device holds and
 * presents to geneus-server (root §4.3a). It answers "which device, of which
 * facility" and nothing about who is signed in. It is what CouchDB's per-device
 * `_users` document used to be — inspectable state (a row) rather than a
 * stateless token, so revocation is an UPDATE and sync dies at next contact.
 *
 * Format on the wire: `<deviceId>.<secret>`. The device id is in clear so the
 * lookup is by primary key; the secret is 256 random bits, so a plain SHA-256
 * is a sound store — there is no low-entropy password here to stretch.
 */
const SECRET_BYTES = 32;

export type DeviceIdentity = { deviceId: string; facilityId: string };

export type CredentialFailure = 'malformed' | 'unknown_device' | 'wrong_secret' | 'revoked' | 'wipe_requested';

const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex');

const split = (credential: string): { deviceId: string; secret: string } | undefined => {
  const at = credential.indexOf('.');
  if (at <= 0 || at === credential.length - 1) return undefined;
  return { deviceId: credential.slice(0, at), secret: credential.slice(at + 1) };
};

/**
 * Mints and stores a credential for a device row that exists (or is being
 * inserted in the same transaction). The clear secret is returned exactly once.
 */
export const issueCredential = async (sql: Sql | Tx, deviceId: string): Promise<string> => {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  await sql`INSERT INTO device_credentials (device_id, credential_hash) VALUES (${deviceId}, ${hashSecret(secret)})`;
  return `${deviceId}.${secret}`;
};

type Lookup = { credential_hash: string; facility_id: string; status: string; wipe_requested: boolean };

/**
 * Resolves a presented credential to a trusted device identity, or says why
 * not. The distinct failures are for the log, not the client — the client
 * learns only that it was refused.
 */
export const verifyCredential = async (
  sql: Sql | Tx,
  credential: string,
): Promise<{ identity: DeviceIdentity } | { failure: CredentialFailure }> => {
  const parts = split(credential);
  if (!parts) return { failure: 'malformed' };

  const [row] = await sql<Lookup[]>`
    SELECT c.credential_hash, d.facility_id, d.status, d.wipe_requested
    FROM device_credentials c
    JOIN devices d ON d.id = c.device_id
    WHERE c.device_id = ${parts.deviceId}`;
  if (!row) return { failure: 'unknown_device' };

  const presented = Buffer.from(hashSecret(parts.secret), 'hex');
  const stored = Buffer.from(row.credential_hash, 'hex');
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return { failure: 'wrong_secret' };

  if (row.status !== 'active') return { failure: 'revoked' };
  if (row.wipe_requested) return { failure: 'wipe_requested' };

  return { identity: { deviceId: parts.deviceId, facilityId: row.facility_id } };
};
