import { createHash, pbkdf2, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Sql, Tx } from '../db/client.ts';
import type { DeviceIdentity } from '../devices/credentials.ts';

/**
 * Staff passwords (SCHEMA.md §10). A password belongs to a verified email and
 * proves the person on a new device or after too many wrong PINs; the PIN
 * remains the everyday unlock. Only a slow hash is kept, and wrong passwords
 * lock the email out the way wrong PINs lock a person out of a device.
 */

/** OWASP's floor for PBKDF2-SHA256. Hashed asynchronously, so a sign-in never blocks other requests. */
export const PASSWORD_ITERATIONS = 600_000;

const FREE_ATTEMPTS = 5;
const FIRST_LOCKOUT_MS = 60_000;
const MAX_LOCKOUT_MS = 30 * 60_000;

/** Long enough to choose a PIN after signing in, short enough that a forgotten tab is no use later. */
const PIN_GRANT_MS = 10 * 60_000;

const derive = promisify(pbkdf2);

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);

  return x.length === y.length && timingSafeEqual(x, y);
};

const hashOf = async (password: string, salt: string, iterations: number): Promise<string> => {
  const derived = await derive(password, Buffer.from(salt, 'base64'), iterations, 32, 'sha256');

  return derived.toString('base64');
};

/** Hashed for an email nobody has, so an unknown email costs as long as a known one. */
const DECOY_SALT = randomBytes(16).toString('base64');

const lockoutAfter = (failures: number): number | undefined => {
  if (failures < FREE_ATTEMPTS) {
    return undefined;
  }

  return Math.min(FIRST_LOCKOUT_MS * 2 ** (failures - FREE_ATTEMPTS), MAX_LOCKOUT_MS);
};

export type PasswordHash = { salt: string; hash: string; iterations: number };

/** Hashes a new password. Done before any transaction opens, since it takes a noticeable fraction of a second. */
export const hashNewPassword = async (password: string): Promise<PasswordHash> => {
  const salt = randomBytes(16).toString('base64');

  return {
    salt,
    hash: await hashOf(password, salt, PASSWORD_ITERATIONS),
    iterations: PASSWORD_ITERATIONS,
  };
};

export type PasswordSetBy = 'invitation' | 'reset' | 'change' | 'registration';

/** Sets or replaces the password for an email, clearing any lockout. */
export const savePassword = async (
  tx: Sql | Tx,
  email: string,
  password: PasswordHash,
  setBy: PasswordSetBy,
): Promise<void> => {
  await tx`
    INSERT INTO staff_passwords (email, salt, hash, iterations, set_by)
    VALUES (${email}, ${password.salt}, ${password.hash}, ${password.iterations}, ${setBy})
    ON CONFLICT (email) DO UPDATE SET
      salt = EXCLUDED.salt,
      hash = EXCLUDED.hash,
      iterations = EXCLUDED.iterations,
      set_by = EXCLUDED.set_by,
      set_on = now(),
      failures = 0,
      locked_until = NULL`;
};

export type PasswordCheck =
  { ok: true } | { ok: false; reason: 'wrong' } | { ok: false; reason: 'locked'; retryAt: string };

type PasswordRow = PasswordHash & { locked_until: Date | string | null };

const lockedUntilOf = (row: PasswordRow): number =>
  row.locked_until ? new Date(row.locked_until).getTime() : 0;

/**
 * Checks a password and counts the attempt. An email with no password answers
 * exactly like a wrong password, so sign-in never reveals which emails exist.
 */
export const checkPassword = async (
  sql: Sql,
  email: string,
  password: string,
): Promise<PasswordCheck> => {
  const [row] = await sql<PasswordRow[]>`
    SELECT salt, hash, iterations, locked_until FROM staff_passwords WHERE email = ${email}`;

  if (!row) {
    await hashOf(password, DECOY_SALT, PASSWORD_ITERATIONS);

    return { ok: false, reason: 'wrong' };
  }

  const lockedUntil = lockedUntilOf(row);

  if (lockedUntil > Date.now()) {
    return { ok: false, reason: 'locked', retryAt: new Date(lockedUntil).toISOString() };
  }

  if (same(await hashOf(password, row.salt, row.iterations), row.hash)) {
    await sql`UPDATE staff_passwords SET failures = 0, locked_until = NULL WHERE email = ${email}`;

    return { ok: true };
  }

  const [counted] = await sql<{ failures: number }[]>`
    UPDATE staff_passwords SET failures = failures + 1 WHERE email = ${email} RETURNING failures`;

  const lockout = lockoutAfter(counted?.failures ?? 0);

  if (!lockout) {
    return { ok: false, reason: 'wrong' };
  }

  const retryAt = new Date(Date.now() + lockout);
  await sql`UPDATE staff_passwords SET locked_until = ${retryAt} WHERE email = ${email}`;

  return { ok: false, reason: 'locked', retryAt: retryAt.toISOString() };
};

export const hasPassword = async (sql: Sql | Tx, email: string): Promise<boolean> => {
  const [row] = await sql`SELECT 1 FROM staff_passwords WHERE email = ${email}`;

  return Boolean(row);
};

/**
 * Where a new device signs this email in: the active membership at their
 * organization's original facility (the first to join it, or a facility in no
 * organization), or else the first membership they were given.
 */
export const primaryMembership = async (
  sql: Sql | Tx,
  email: string,
): Promise<{ facilityId: string; staffId: string } | undefined> => {
  const [row] = await sql<{ facility_id: string; staff_id: string }[]>`
    SELECT s.facility_id, s.id AS staff_id
    FROM staff_contacts c
    JOIN staff s ON s.facility_id = c.facility_id AND s.id = c.staff_id
    LEFT JOIN organization_facilities link ON link.facility_id = s.facility_id
    WHERE lower(c.email) = ${email} AND s.active
    ORDER BY
      (link.facility_id IS NULL OR link.joined_on = (
        SELECT min(first.joined_on) FROM organization_facilities first
        WHERE first.organization_id = link.organization_id
      )) DESC,
      s.created_on ASC
    LIMIT 1`;

  return row ? { facilityId: row.facility_id, staffId: row.staff_id } : undefined;
};

/** The active member of staff at this facility whose verified email this is. */
export const staffWithEmail = async (
  sql: Sql | Tx,
  facilityId: string,
  email: string,
): Promise<string | undefined> => {
  const [row] = await sql<{ id: string }[]>`
    SELECT s.id FROM staff_contacts c
    JOIN staff s ON s.facility_id = c.facility_id AND s.id = c.staff_id
    WHERE c.facility_id = ${facilityId} AND lower(c.email) = ${email} AND s.active
    LIMIT 1`;

  return row?.id;
};

/** Permission to register this person's PIN on this device, given by a password sign-in. */
export const issuePinGrant = async (
  tx: Tx,
  identity: DeviceIdentity,
  staffId: string,
): Promise<{ pinGrant: string; pinGrantExpiresOn: string }> => {
  const pinGrant = randomBytes(32).toString('base64url');
  const pinGrantExpiresOn = new Date(Date.now() + PIN_GRANT_MS).toISOString();

  await tx`
    INSERT INTO staff_pin_grants (token_hash, facility_id, staff_id, device_id, expires_on)
    VALUES (${sha(pinGrant)}, ${identity.facilityId}, ${staffId}, ${identity.deviceId}, ${pinGrantExpiresOn})`;

  return { pinGrant, pinGrantExpiresOn };
};

/** Spends a PIN grant. False when it is not this person's on this device, was used, or has expired. */
export const spendPinGrant = async (
  tx: Tx,
  identity: DeviceIdentity,
  staffId: string,
  pinGrant: string,
): Promise<boolean> => {
  const spent = await tx`
    UPDATE staff_pin_grants SET used_on = now()
    WHERE token_hash = ${sha(pinGrant)} AND facility_id = ${identity.facilityId}
      AND device_id = ${identity.deviceId} AND staff_id = ${staffId}
      AND used_on IS NULL AND expires_on > now()`;

  return spent.count === 1;
};

/**
 * After a password reset: everyone holding this email is signed out
 * everywhere, their PINs are no longer accepted by the server, and unspent PIN
 * grants die. A PIN stored on an offline device still opens it offline until
 * that device next reaches the server.
 */
export const endAccessForEmail = async (tx: Tx, email: string): Promise<void> => {
  await tx`
    UPDATE staff_sessions SET ended_on = now()
    WHERE ended_on IS NULL AND (facility_id, staff_id) IN (
      SELECT facility_id, staff_id FROM staff_contacts WHERE lower(email) = ${email})`;

  await tx`
    DELETE FROM staff_device_pins
    WHERE (facility_id, staff_id) IN (
      SELECT facility_id, staff_id FROM staff_contacts WHERE lower(email) = ${email})`;

  await tx`
    UPDATE staff_pin_grants SET used_on = now()
    WHERE used_on IS NULL AND (facility_id, staff_id) IN (
      SELECT facility_id, staff_id FROM staff_contacts WHERE lower(email) = ${email})`;
};

/**
 * An account event with no facility device to record it against — a password
 * reset from a device set up nowhere. Kept on the server only, attributed to
 * the person's primary membership when they have one.
 */
export const recordAccountEvent = async (
  tx: Tx,
  email: string,
  action: 'password_reset',
): Promise<void> => {
  const membership = await primaryMembership(tx, email);

  await tx`
    INSERT INTO staff_account_events (id, email, action, facility_id, staff_id)
    VALUES (${`account_event:${randomUUID()}`}, ${email}, ${action},
      ${membership?.facilityId ?? null}, ${membership?.staffId ?? null})`;
};
