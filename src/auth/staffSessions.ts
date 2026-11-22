import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Staff, StaffSession } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import type { DeviceIdentity } from '../devices/credentials.ts';
import { hashPinSetupCode } from '../staff/pinSetupCodes.ts';
import { acceptInvitation, matchInvitationCode } from '../staff/invitations.ts';
import { completePrivateAccess } from '../workforce/privateAccess.ts';

/**
 * Server-verified staff identity on shared devices. The device proves which
 * device it is; the PIN, checked here, proves which person is using it. A
 * session belongs to one person on one device, ends after 30 minutes idle or
 * 12 hours, and ends at once when anyone else signs in on that device.
 */
export const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_MAX_MS = 12 * 60 * 60_000;
const PIN_ITERATIONS = 210_000;
const FREE_ATTEMPTS = 5;
const FIRST_LOCKOUT_MS = 60_000;
const MAX_LOCKOUT_MS = 30 * 60_000;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const pinHash = (pin: string, salt: string, iterations: number) =>
  pbkdf2Sync(pin, Buffer.from(salt, 'base64'), iterations, 32, 'sha256').toString('base64');
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class StaffSessionRefusal extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'StaffSessionRefusal';
    this.code = code;
    this.details = details;
  }
}

const activeStaff = async (sql: Sql | Tx, facilityId: string, staffId: string) => {
  const staff = await findRecord<Staff>(sql, 'staff', staffId);
  return staff?.active && staff.facilityId === facilityId ? staff : undefined;
};

/** Ends every open session on a device: someone else is now using it, or its holder signed out. */
export const endDeviceSessions = (sql: Sql | Tx, deviceId: string) =>
  sql`UPDATE staff_sessions SET ended_on = now() WHERE device_id = ${deviceId} AND ended_on IS NULL`;

const openSession = async (
  tx: Tx,
  identity: DeviceIdentity,
  staffId: string,
): Promise<StaffSession> => {
  await endDeviceSessions(tx, identity.deviceId);
  const token = randomBytes(32).toString('base64url');
  const expiresOn = new Date(Date.now() + SESSION_MAX_MS).toISOString();
  await tx`INSERT INTO staff_sessions (token_hash, facility_id, staff_id, device_id, expires_on) VALUES (${sha(token)}, ${identity.facilityId}, ${staffId}, ${identity.deviceId}, ${expiresOn})`;
  return { token, staffId, expiresOn, idleMinutes: SESSION_IDLE_MS / 60_000 };
};

/**
 * Registers a PIN with the server for this person on this device, and opens a
 * session. Proof of who they are: a PIN setup code an administrator issued to
 * them (read aloud, or sent as an invitation — accepted here, online only), or
 * a code sent to their own verified email, for PINs set before server sessions
 * existed.
 */
export const enrolPin = async (
  sql: Sql,
  identity: DeviceIdentity,
  input: { staffId: string; pin: string; setupCode?: string; emailCode?: string },
): Promise<StaffSession> => {
  if (!(await activeStaff(sql, identity.facilityId, input.staffId))) {
    throw new StaffSessionRefusal('unknown_staff', 'No such member of staff here');
  }
  let proof: 'setup_code' | 'email' | 'invitation';
  let invitationId: string | undefined;
  if (input.setupCode) {
    const codes = await sql<
      {
        id: string;
        code_hash: string;
        code_salt: string;
        code_iterations: number;
        used_on: Date | null;
        used_on_device: string | null;
      }[]
    >`
      SELECT id, code_hash, code_salt, code_iterations, used_on, used_on_device FROM pin_setup_codes
      WHERE facility_id = ${identity.facilityId} AND staff_id = ${input.staffId} AND revoked_on IS NULL AND expires_on > now()
        AND (used_on IS NULL OR (used_on_device = ${identity.deviceId} AND used_on > now() - interval '1 day'))`;
    const match = codes.find((c) =>
      same(hashPinSetupCode(input.setupCode!, c.code_salt, c.code_iterations), c.code_hash),
    );
    if (match) {
      if (!match.used_on) {
        await sql`UPDATE pin_setup_codes SET used_on = now(), used_on_device = ${identity.deviceId}, updated_by = ${input.staffId}, updated_on = now() WHERE id = ${match.id} AND used_on IS NULL`;
      }
      proof = 'setup_code';
    } else {
      invitationId = await matchInvitationCode(
        sql,
        identity.facilityId,
        input.staffId,
        input.setupCode,
      );
      if (!invitationId) {
        throw new StaffSessionRefusal(
          'invalid_setup_code',
          'This PIN code is not right, has expired or was already used. Ask your administrator for a new one',
        );
      }
      proof = 'invitation';
    }
  } else {
    const session = await completePrivateAccess(
      sql,
      identity,
      input.staffId,
      input.emailCode ?? '',
    );
    if (!session) {
      throw new StaffSessionRefusal(
        'invalid_email_code',
        'The email code is not right, or has expired',
      );
    }
    proof = 'email';
  }
  const salt = randomBytes(16).toString('base64');
  return sql.begin(async (tx) => {
    // Accepted with the PIN or not at all: a revocation or expiry that won the race stops both.
    if (invitationId && !(await acceptInvitation(tx, identity, input.staffId, invitationId))) {
      throw new StaffSessionRefusal(
        'invalid_setup_code',
        'This invitation code has expired or was withdrawn. Ask your administrator to send a new one',
      );
    }
    await tx`INSERT INTO staff_device_pins (facility_id, staff_id, device_id, salt, hash, iterations, enrolled_by)
      VALUES (${identity.facilityId}, ${input.staffId}, ${identity.deviceId}, ${salt}, ${pinHash(input.pin, salt, PIN_ITERATIONS)}, ${PIN_ITERATIONS}, ${proof})
      ON CONFLICT (facility_id, staff_id, device_id) DO UPDATE SET salt = EXCLUDED.salt, hash = EXCLUDED.hash, iterations = EXCLUDED.iterations, failures = 0, locked_until = NULL, enrolled_by = EXCLUDED.enrolled_by, enrolled_on = now()`;
    return openSession(tx, identity, input.staffId);
  });
};

/** Opens a session from the PIN the person just signed in with. Wrong PINs lock out like the device keypad does. */
export const signInSession = async (
  sql: Sql,
  identity: DeviceIdentity,
  input: { staffId: string; pin: string },
): Promise<StaffSession> => {
  // A wrong PIN must be counted even though the attempt fails, so the refusal is raised after the count commits.
  const outcome = await sql.begin(async (tx): Promise<StaffSession | StaffSessionRefusal> => {
    if (!(await activeStaff(tx, identity.facilityId, input.staffId))) {
      return new StaffSessionRefusal('unknown_staff', 'No such member of staff here');
    }
    const [row] = await tx<
      {
        salt: string;
        hash: string;
        iterations: number;
        failures: number;
        locked_until: Date | string | null;
      }[]
    >`
      SELECT salt, hash, iterations, failures, locked_until FROM staff_device_pins WHERE facility_id = ${identity.facilityId} AND staff_id = ${input.staffId} AND device_id = ${identity.deviceId} FOR UPDATE`;
    if (!row) {
      return new StaffSessionRefusal(
        'pin_not_enrolled',
        'Your PIN is not yet registered with the server on this device',
      );
    }
    const lockedUntil = row.locked_until
      ? Date.parse(
          String(
            row.locked_until instanceof Date ? row.locked_until.toISOString() : row.locked_until,
          ),
        )
      : 0;
    if (lockedUntil > Date.now()) {
      return new StaffSessionRefusal('locked', 'Too many wrong PINs. Try again later', {
        retryAt: new Date(lockedUntil).toISOString(),
      });
    }
    if (!same(pinHash(input.pin, row.salt, row.iterations), row.hash)) {
      const failures = row.failures + 1;
      const lockout =
        failures < FREE_ATTEMPTS
          ? undefined
          : Math.min(FIRST_LOCKOUT_MS * 2 ** (failures - FREE_ATTEMPTS), MAX_LOCKOUT_MS);
      await tx`UPDATE staff_device_pins SET failures = ${failures}, locked_until = ${lockout ? new Date(Date.now() + lockout) : null} WHERE facility_id = ${identity.facilityId} AND staff_id = ${input.staffId} AND device_id = ${identity.deviceId}`;
      return new StaffSessionRefusal(
        lockout ? 'locked' : 'wrong_pin',
        lockout ? 'Too many wrong PINs. Try again later' : 'That PIN is not right',
      );
    }
    await tx`UPDATE staff_device_pins SET failures = 0, locked_until = NULL WHERE facility_id = ${identity.facilityId} AND staff_id = ${input.staffId} AND device_id = ${identity.deviceId}`;
    return openSession(tx, identity, input.staffId);
  });
  if (outcome instanceof StaffSessionRefusal) {
    throw outcome;
  }
  return outcome;
};

/**
 * The person behind a request: an open, unexpired, recently used session on
 * this device, held by staff who are still active. Permissions are always
 * read fresh from the staff record, so a revoked permission applies at once.
 */
export const sessionStaff = async (
  sql: Sql,
  identity: DeviceIdentity,
  token: string | undefined,
): Promise<Staff | undefined> => {
  if (!token || token.length > 200) {
    return undefined;
  }
  const [row] = await sql<{ staff_id: string }[]>`UPDATE staff_sessions SET last_used_on = now()
    WHERE token_hash = ${sha(token)} AND facility_id = ${identity.facilityId} AND device_id = ${identity.deviceId} AND ended_on IS NULL
      AND expires_on > now() AND last_used_on > now() - ${`${SESSION_IDLE_MS / 1000} seconds`}::interval RETURNING staff_id`;
  if (!row) {
    return undefined;
  }
  return activeStaff(sql, identity.facilityId, row.staff_id);
};

export const endSession = (sql: Sql, identity: DeviceIdentity, token: string) =>
  sql`UPDATE staff_sessions SET ended_on = now() WHERE token_hash = ${sha(token)} AND device_id = ${identity.deviceId} AND ended_on IS NULL`;

type RequestHeaders = Record<string, string | string[] | undefined>;
const pick = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

/**
 * The person behind a request as the server itself has proven them: a
 * PIN-proven staff session, or an emailed-code session. Never a staff id the
 * device merely asserts. Binding or changing a contact and handing out PIN
 * authority use this, because an asserted id there would let anyone holding a
 * facility phone take over a colleague's account.
 */
export const verifiedRequestStaff = async (
  sql: Sql,
  identity: DeviceIdentity,
  headers: RequestHeaders,
): Promise<Staff | undefined> => {
  const viaSession = await sessionStaff(sql, identity, pick(headers['x-staff-session']));
  if (viaSession) {
    return viaSession;
  }
  const { privateStaff } = await import('../workforce/privateAccess.ts');
  return privateStaff(sql, identity, pick(headers['x-workforce-access']));
};

/**
 * The person behind a request: their verified session when the device has
 * one, otherwise the person the enrolled device says is signed in on it
 * (x-actor-staff-id), as offline uploads and documents already are. That
 * person must be active in the device's own facility; the staff record is
 * read fresh, so each route's role and permission checks and any revocation
 * apply at once. Contact and PIN-authority routes use `verifiedRequestStaff`.
 */
export const requestStaff = async (
  sql: Sql,
  identity: DeviceIdentity,
  headers: RequestHeaders,
): Promise<Staff | undefined> => {
  const verified = await verifiedRequestStaff(sql, identity, headers);
  if (verified) {
    return verified;
  }
  const actor = pick(headers['x-actor-staff-id']);
  return actor && actor.length <= 200 ? activeStaff(sql, identity.facilityId, actor) : undefined;
};
