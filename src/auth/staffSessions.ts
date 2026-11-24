import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ExistingAccountProof, Staff, StaffPasswordSession, StaffSession } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import type { DeviceIdentity } from '../devices/credentials.ts';
import {
  checkVerificationCode,
  consumeVerification,
  findStaffEmail,
} from '../email/verifications.ts';
import {
  acceptInvitation,
  invitationDestination,
  matchInvitationCode,
} from '../staff/invitations.ts';
import {
  checkPassword,
  hasPassword,
  hashNewPassword,
  issuePinGrant,
  savePassword,
  spendPinGrant,
  staffWithEmail,
  type PasswordHash,
} from './staffPasswords.ts';

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

/** Opens a session for one person on one device, ending whoever else was signed in there. */
export const openSession = async (
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
 * How accepting an invitation settles the password of the invited email,
 * worked out before the transaction (hashing and checking a password are slow):
 * a first password to save, an emailed account code to spend, or nothing.
 */
type InvitationAccount = { newPassword?: PasswordHash; accountCodeId?: string };

const EXISTING_ACCOUNT_MESSAGE =
  'This email already has a Geneus password. Enter it, or use the code we email you';

/**
 * An invitation never replaces a password the email already has: the person
 * proves it is them with that password or an emailed account code. An email
 * with no password may choose its first one here.
 */
const settleInvitationAccount = async (
  sql: Sql,
  invitationId: string,
  input: { password?: string; existingAccount?: ExistingAccountProof },
): Promise<InvitationAccount> => {
  const email = (await invitationDestination(sql, invitationId)) ?? '';

  if (!(await hasPassword(sql, email))) {
    if (input.existingAccount) {
      throw new StaffSessionRefusal(
        'no_existing_account',
        'This email has no Geneus password yet. Choose one',
      );
    }

    return input.password ? { newPassword: await hashNewPassword(input.password) } : {};
  }

  if (!input.existingAccount || input.password) {
    throw new StaffSessionRefusal('existing_account', EXISTING_ACCOUNT_MESSAGE);
  }

  if ('accountCode' in input.existingAccount) {
    const accountCodeId = await checkVerificationCode(sql, {
      purpose: 'staff_account',
      subject: invitationId,
      email,
      code: input.existingAccount.accountCode,
    });

    if (!accountCodeId) {
      throw new StaffSessionRefusal(
        'invalid_account_code',
        'The email code is not right, or has expired',
      );
    }

    return { accountCodeId };
  }

  const check = await checkPassword(sql, email, input.existingAccount.currentPassword);

  if (!check.ok && check.reason === 'locked') {
    throw new StaffSessionRefusal('locked', 'Too many wrong passwords. Try again later', {
      retryAt: check.retryAt,
    });
  }

  if (!check.ok) {
    throw new StaffSessionRefusal('wrong_password', 'That password is not right');
  }

  return {};
};

/**
 * Inside the acceptance: spends the account code, and saves a first password
 * only when the invitation's address is now the person's verified email — the
 * invitation proved that inbox and no other.
 */
const applyInvitationAccount = async (
  tx: Tx,
  identity: DeviceIdentity,
  staffId: string,
  invitationId: string,
  account: InvitationAccount,
): Promise<void> => {
  if (account.accountCodeId && !(await consumeVerification(tx, account.accountCodeId))) {
    throw new StaffSessionRefusal(
      'invalid_account_code',
      'The email code is not right, or has expired',
    );
  }

  if (!account.newPassword) {
    return;
  }

  const destination = await invitationDestination(tx, invitationId);
  const email = (await findStaffEmail(tx, identity.facilityId, staffId))?.toLowerCase();

  if (!destination || email !== destination) {
    throw new StaffSessionRefusal(
      'invitation_email_mismatch',
      'Your password cannot be set from this invitation. Use "Forgot password" with the email your administrator has on file',
    );
  }

  await savePassword(tx, email, account.newPassword, 'invitation');
};

/**
 * Registers a PIN with the server for this person on this device, and opens a
 * session. Proof of who they are: the PIN grant from signing in with their
 * password on this device, or the code of an invitation emailed to them
 * (accepted here, online only), which is also where the first password is chosen.
 */
export const enrolPin = async (
  sql: Sql,
  identity: DeviceIdentity,
  input: {
    staffId: string;
    pin: string;
    pinGrant?: string;
    setupCode?: string;
    password?: string;
    existingAccount?: ExistingAccountProof;
  },
): Promise<StaffSession> => {
  if (!(await activeStaff(sql, identity.facilityId, input.staffId))) {
    throw new StaffSessionRefusal('unknown_staff', 'No such member of staff here');
  }

  let proof: 'password' | 'invitation';
  let invitationId: string | undefined;

  if (input.pinGrant) {
    // Spent with the PIN below, so a refused registration leaves the grant usable.
    proof = 'password';
  } else {
    invitationId = await matchInvitationCode(
      sql,
      identity.facilityId,
      input.staffId,
      input.setupCode ?? '',
    );

    if (!invitationId) {
      throw new StaffSessionRefusal(
        'invalid_setup_code',
        'This invitation code is not right, has expired or was already used. Ask your administrator to send a new invitation',
      );
    }

    proof = 'invitation';
  }

  const salt = randomBytes(16).toString('base64');

  if ((input.password || input.existingAccount) && proof !== 'invitation') {
    throw new StaffSessionRefusal(
      'password_needs_invitation',
      'A password is settled here only when accepting an email invitation',
    );
  }

  const account = invitationId
    ? await settleInvitationAccount(sql, invitationId, input)
    : undefined;

  return sql.begin(async (tx) => {
    if (input.pinGrant && !(await spendPinGrant(tx, identity, input.staffId, input.pinGrant))) {
      throw new StaffSessionRefusal(
        'invalid_pin_grant',
        'Your sign-in has expired. Sign in with your email and password again',
      );
    }

    // Accepted with the PIN or not at all: a revocation or expiry that won the race stops both.
    if (invitationId && !(await acceptInvitation(tx, identity, input.staffId, invitationId))) {
      throw new StaffSessionRefusal(
        'invalid_setup_code',
        'This invitation code has expired or was withdrawn. Ask your administrator to send a new one',
      );
    }

    if (invitationId && account) {
      await applyInvitationAccount(tx, identity, input.staffId, invitationId, account);
    }

    await tx`INSERT INTO staff_device_pins (facility_id, staff_id, device_id, salt, hash, iterations, enrolled_by)
      VALUES (${identity.facilityId}, ${input.staffId}, ${identity.deviceId}, ${salt}, ${pinHash(input.pin, salt, PIN_ITERATIONS)}, ${PIN_ITERATIONS}, ${proof})
      ON CONFLICT (facility_id, staff_id, device_id) DO UPDATE SET salt = EXCLUDED.salt, hash = EXCLUDED.hash, iterations = EXCLUDED.iterations, failures = 0, locked_until = NULL, enrolled_by = EXCLUDED.enrolled_by, enrolled_on = now()`;

    return openSession(tx, identity, input.staffId);
  });
};

/** Opens a session from the PIN the person just signed in with. Wrong PINs lock out like the device keypad does. */
type PinHolder = { facilityId: string; staffId: string; deviceId: string };

/**
 * One PIN per person on a device: when a signed-in person switches to their
 * membership at another facility of the organization, the PIN they registered
 * where they came from is registered at the destination too, on that
 * facility's enrollment of the same device. Only into an empty slot — a PIN
 * already registered there is never replaced. The caller has proven the
 * source session and the destination enrollment, and that both memberships
 * are the same person.
 */
export const carryPinAcrossSwitch = async (
  tx: Tx,
  from: PinHolder,
  to: PinHolder,
): Promise<void> => {
  await tx`
    INSERT INTO staff_device_pins (facility_id, staff_id, device_id, salt, hash, iterations, enrolled_by)
    SELECT ${to.facilityId}, ${to.staffId}, ${to.deviceId}, salt, hash, iterations, 'facility_switch'
    FROM staff_device_pins
    WHERE facility_id = ${from.facilityId} AND staff_id = ${from.staffId} AND device_id = ${from.deviceId}
    ON CONFLICT (facility_id, staff_id, device_id) DO NOTHING`;
};

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
 * Signs in with email and password on an enrolled device: opens a session for
 * the active member of staff at this facility with that verified email, and
 * gives permission to register their PIN on this device. A wrong password and
 * an unknown email get the same answer.
 */
export const signInWithPassword = async (
  sql: Sql,
  identity: DeviceIdentity,
  input: { email: string; password: string },
): Promise<StaffPasswordSession> => {
  const check = await checkPassword(sql, input.email, input.password);

  if (!check.ok && check.reason === 'locked') {
    throw new StaffSessionRefusal('locked', 'Too many wrong passwords. Try again later', {
      retryAt: check.retryAt,
    });
  }

  if (!check.ok) {
    throw new StaffSessionRefusal('wrong_password', 'That email or password is not right');
  }

  const staffId = await staffWithEmail(sql, identity.facilityId, input.email);

  if (!staffId) {
    throw new StaffSessionRefusal(
      'not_at_facility',
      'You are not set up at this facility. Ask its administrator to add you',
    );
  }

  return sql.begin(async (tx) => {
    const session = await openSession(tx, identity, staffId);
    const grant = await issuePinGrant(tx, identity, staffId);

    return { ...session, ...grant };
  });
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
