import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isPostgresError, UNIQUE_VIOLATION, type Sql, type Tx } from '../db/client.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import type { DeviceCredential } from '#shared';
import { authorizeStaff } from '../auth/staffAuthorization.ts';
import type { DeviceIdentity } from '../devices/credentials.ts';
import { claimCodeAndEnroll, issueEnrollmentCode } from '../devices/enrollment.ts';
import { hasPassword } from '../auth/staffPasswords.ts';
import { findStaffEmail, saveStaffEmail } from '../email/verifications.ts';
import { EmailNotSent, maskEmail, type Mailer } from '../lib/email.ts';
import {
  hashInvitationCode,
  INVITATION_CODE_ITERATIONS,
  INVITATION_CODE_TTL_MS,
  invitationAuthorityRefusal,
  newInvitationCode,
} from './invitationCodes.ts';

const newDeviceState = (row: { allows_new_device: unknown; device_enrolled_on: unknown }) => {
  if (!row.allows_new_device) {
    return 'not_allowed';
  }

  return row.device_enrolled_on ? 'used' : 'allowed';
};

/**
 * Staff invitations (SCHEMA.md §10): an email to a contact the administrator
 * entered, whose link leads the person to choosing their password and PIN. The
 * link is exchanged on a facility device for a one-time code, which
 * POST /staff/session/enrol checks here, accepting the invitation and
 * registering their PIN in one transaction, online.
 *
 * Three things are kept apart:
 * - delivery: whether the email provider took the message (never "delivered");
 * - possession: redeeming the code proves the person reads that inbox, so it
 *   becomes their verified email — unless they already have a different one;
 * - authority: an invitation grants nothing; the staff record and its roles,
 *   at this facility only, decide what they may do.
 *
 * The code itself is shown to nobody but its recipient: not returned to the
 * administrator, not logged, stored only as a slow hash.
 */

/** Limits counted from the invitation rows themselves, so they hold across restarts and server instances. */
export const INVITATION_LIMITS = {
  resendCooldownMs: 60_000,
  perPersonPerDay: 5,
  perFacilityPerHour: 30,
  /** Wrong codes against one invitation before it stops working and must be resent. */
  failedAttempts: 5,
} as const;

export type InvitationStatus = 'pending' | 'expired' | 'locked' | 'accepted' | 'revoked';

export type InvitationDelivery =
  'sending' | 'provider_accepted' | 'provider_rejected' | 'not_configured';

/** What an administrator sees: never the code, and the address masked once it has been proven. */
export type InvitationView = {
  id: string;
  channel: 'email';
  destination: string;
  status: InvitationStatus;
  delivery: InvitationDelivery;
  createdOn: string;
  expiresOn: string;
  acceptedOn?: string;
  revokedOn?: string;
  revokedReason?: 'resent' | 'revoked' | 'pin_code_issued';
  /** Whether the link may enrol one new device, chosen by an administrator who may enrol devices. */
  allowsNewDevice: boolean;
};

type InvitationRow = {
  id: string;
  channel: 'email';
  destination: string;
  failed_attempts: number;
  created_on: Date;
  expires_on: Date;
  delivery_status: InvitationDelivery;
  accepted_on: Date | null;
  revoked_on: Date | null;
  revoked_reason: InvitationView['revokedReason'] | null;
  allows_new_device: boolean;
};

const iso = (value: Date | string) => new Date(value).toISOString();

const statusOf = (
  row: Pick<InvitationRow, 'accepted_on' | 'revoked_on' | 'failed_attempts' | 'expires_on'>,
  now = Date.now(),
): InvitationStatus => {
  if (row.accepted_on) {
    return 'accepted';
  }

  if (row.revoked_on) {
    return 'revoked';
  }

  if (row.failed_attempts >= INVITATION_LIMITS.failedAttempts) {
    return 'locked';
  }

  if (new Date(row.expires_on).getTime() <= now) {
    return 'expired';
  }

  return 'pending';
};

/**
 * The address is shown in full only while it is just what the administrator
 * typed. Once it is the person's proven email — accepted, or sent to the
 * verified address on file — it is masked like any other verified contact.
 */
const viewOf = (row: InvitationRow, verifiedEmail?: string): InvitationView => {
  const status = statusOf(row);

  const proven =
    status === 'accepted' ||
    (verifiedEmail !== undefined && verifiedEmail.toLowerCase() === row.destination);

  return {
    id: row.id,
    channel: row.channel,
    destination: proven ? maskEmail(row.destination) : row.destination,
    status,
    delivery: row.delivery_status,
    createdOn: iso(row.created_on),
    expiresOn: iso(row.expires_on),
    allowsNewDevice: row.allows_new_device,
    ...(row.accepted_on ? { acceptedOn: iso(row.accepted_on) } : {}),
    ...(row.revoked_on
      ? {
          revokedOn: iso(row.revoked_on),
          ...(row.revoked_reason ? { revokedReason: row.revoked_reason } : {}),
        }
      : {}),
  };
};

const VIEW_COLUMNS = [
  'id',
  'channel',
  'destination',
  'failed_attempts',
  'created_on',
  'expires_on',
  'delivery_status',
  'accepted_on',
  'revoked_on',
  'revoked_reason',
  'allows_new_device',
];

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);

  return x.length === y.length && timingSafeEqual(x, y);
};

/* ------------------------------------------------------------------ */
/* Issuing                                                             */
/* ------------------------------------------------------------------ */

export type InvitationRefusal =
  | 'unknown_staff'
  | 'clinical_review_required'
  | 'own_account'
  | 'contact_change_required'
  | 'email_in_use'
  | 'too_soon'
  | 'daily_limit'
  | 'facility_limit';

export type IssuedInvitation =
  | {
      ok: true;
      code: string;
      linkToken: string;
      destination: string;
      invitation: InvitationView;
      staffName: string;
      facilityName: string;
      verifiedEmail?: string;
    }
  | { ok: false; error: InvitationRefusal; retryAfterSeconds?: number };

/** A link token is 256 random bits: unguessable, so a fast hash is enough to keep it out of the database. */
const newLinkToken = () => randomBytes(32).toString('base64url');
const linkHash = (token: string) => createHash('sha256').update(token.trim()).digest('hex');

/**
 * Creates an invitation for `staffId` to `email`. In one transaction, under the
 * facility row lock so limits are counted exactly: checks the inviter's
 * authority, the contact rules and the limits; revokes any earlier invitation; stores the hashes of the new code and link. Sending
 * is a separate step (`deliverInvitation`), after commit. `allowNewDevice` is
 * only passed by a route that has checked the sender may enrol devices.
 */
export const issueStaffInvitation = async (
  sql: Sql,
  input: {
    facilityId: string;
    staffId: string;
    issuedBy: string;
    issuedFrom: string;
    email: string;
    allowNewDevice?: boolean;
  },
): Promise<IssuedInvitation> =>
  sql.begin(async (tx): Promise<IssuedInvitation> => {
    const [facility] = await tx<
      { name: string }[]
    >`SELECT name FROM facilities WHERE id = ${input.facilityId} FOR UPDATE`;

    if (input.staffId === input.issuedBy) {
      return { ok: false, error: 'own_account' };
    }

    const refusal = await invitationAuthorityRefusal(tx, input);

    if (refusal) {
      return { ok: false, error: refusal };
    }

    const email = input.email.trim().toLowerCase();
    // A proven address is changed only by its owner (with codes to old and new), never redirected by an invitation.
    const verified = await findStaffEmail(tx, input.facilityId, input.staffId);

    if (verified && verified.toLowerCase() !== email) {
      return { ok: false, error: 'contact_change_required' };
    }

    const [taken] = await tx`
      SELECT 1 FROM staff s
      WHERE s.facility_id = ${input.facilityId} AND s.id <> ${input.staffId} AND s.active AND (
        EXISTS (SELECT 1 FROM staff_contacts c WHERE c.facility_id = s.facility_id AND c.staff_id = s.id AND lower(c.email) = ${email})
        OR EXISTS (SELECT 1 FROM staff_invitations i WHERE i.facility_id = s.facility_id AND i.staff_id = s.id AND i.destination = ${email}
          AND i.accepted_on IS NULL AND i.revoked_on IS NULL AND i.expires_on > now()))`;

    if (taken) {
      return { ok: false, error: 'email_in_use' };
    }

    const [counts] = await tx<{ since_last_ms: number | null; today: number; this_hour: number }[]>`
      SELECT
        (SELECT extract(epoch FROM now() - max(created_on)) * 1000 FROM staff_invitations WHERE facility_id = ${input.facilityId} AND staff_id = ${input.staffId})::float8 AS since_last_ms,
        (SELECT count(*) FROM staff_invitations WHERE facility_id = ${input.facilityId} AND staff_id = ${input.staffId} AND created_on > now() - interval '1 day')::int AS today,
        (SELECT count(*) FROM staff_invitations WHERE facility_id = ${input.facilityId} AND created_on > now() - interval '1 hour')::int AS this_hour`;

    if (
      counts.since_last_ms !== null &&
      counts.since_last_ms < INVITATION_LIMITS.resendCooldownMs
    ) {
      return {
        ok: false,
        error: 'too_soon',
        retryAfterSeconds: Math.ceil(
          (INVITATION_LIMITS.resendCooldownMs - counts.since_last_ms) / 1000,
        ),
      };
    }

    if (counts.today >= INVITATION_LIMITS.perPersonPerDay) {
      return { ok: false, error: 'daily_limit' };
    }

    if (counts.this_hour >= INVITATION_LIMITS.perFacilityPerHour) {
      return { ok: false, error: 'facility_limit' };
    }

    await tx`
      UPDATE staff_invitations SET revoked_on = now(), revoked_by = ${input.issuedBy}, revoked_reason = 'resent'
      WHERE facility_id = ${input.facilityId} AND staff_id = ${input.staffId} AND accepted_on IS NULL AND revoked_on IS NULL`;

    const code = newInvitationCode();
    const linkToken = newLinkToken();
    const salt = randomBytes(16).toString('base64');
    const id = `staff_invitation:${randomUUID()}`;
    const expiresOn = new Date(Date.now() + INVITATION_CODE_TTL_MS).toISOString();

    const [row] = await tx<InvitationRow[]>`
      INSERT INTO staff_invitations (id, facility_id, staff_id, channel, destination, code_hash, code_salt, code_iterations, created_by, created_from, expires_on, link_hash, allows_new_device)
      VALUES (${id}, ${input.facilityId}, ${input.staffId}, 'email', ${email}, ${hashInvitationCode(code, salt, INVITATION_CODE_ITERATIONS)}, ${salt},
        ${INVITATION_CODE_ITERATIONS}, ${input.issuedBy}, ${input.issuedFrom}, ${expiresOn}, ${linkHash(linkToken)}, ${input.allowNewDevice === true})
      RETURNING ${tx(VIEW_COLUMNS)}`;

    const [staff] = await tx<
      { full_name: string }[]
    >`SELECT full_name FROM staff WHERE facility_id = ${input.facilityId} AND id = ${input.staffId}`;

    await recordAuditEvent(tx, {
      facilityId: input.facilityId,
      deviceId: input.issuedFrom,
      actorStaffId: input.issuedBy,
      action: 'create',
      entityType: 'staff',
      entityId: input.staffId,
      metadata: {
        context: 'staff_invitation_created',
        invitationId: id,
        channel: 'email',
        email: maskEmail(email),
        resend: counts.since_last_ms !== null,
        allowsNewDevice: input.allowNewDevice === true,
      },
    });

    return {
      ok: true,
      code,
      linkToken,
      destination: email,
      invitation: viewOf(row, verified),
      staffName: staff.full_name,
      facilityName: facility.name,
      ...(verified ? { verifiedEmail: verified } : {}),
    };
  });

/** Where the invitation opens. The token is in the fragment, which browsers never send to a server or pass on as a referrer. */
export const invitationLink = (appUrl: string, token: string) =>
  `${appUrl.replace(/\/+$/, '')}/onboarding/invitation#token=${token}`;

const invitationEmail = (input: {
  link: string;
  expiresOn: string;
  staffName: string;
  facilityName: string;
}) => ({
  subject: `Your Geneus invitation from ${input.facilityName}`,
  text: [
    `${input.staffName}, you have been added as staff at ${input.facilityName} on Geneus.`,
    '',
    'Accept invitation:',
    input.link,
    '',
    `Open the link on one of ${input.facilityName}'s phones or computers, or on the device your administrator set up for you. It guides you through choosing your password and your PIN. The device needs an internet connection for this step; after it, you sign in with your PIN, even offline.`,
    '',
    `The link works once, until ${new Date(input.expiresOn).toUTCString()}. Never share it — nobody from Geneus or your facility will ask for it.`,
    'If you were not expecting this, you can ignore this email.',
  ].join('\n'),
});

/**
 * Sends the invitation and records what the provider said. A refusal is
 * recorded, not thrown: the invitation stays, and the administrator sees that
 * delivery failed and can resend. `not_configured` is a development server
 * writing the message to its own log — never reported as sent.
 */
export const deliverInvitation = async (
  sql: Sql,
  mailer: Mailer,
  issued: {
    code: string;
    linkToken: string;
    destination: string;
    invitation: InvitationView;
    staffName: string;
    facilityName: string;
    verifiedEmail?: string;
  },
  appUrl: string,
): Promise<InvitationView> => {
  let delivery: InvitationDelivery;
  let messageId: string | null = null;
  let problem: string | null = null;

  try {
    const receipt = await mailer.send({
      to: issued.destination,
      ...invitationEmail({
        link: invitationLink(appUrl, issued.linkToken),
        expiresOn: issued.invitation.expiresOn,
        staffName: issued.staffName,
        facilityName: issued.facilityName,
      }),
    });

    delivery = mailer.configured ? 'provider_accepted' : 'not_configured';
    messageId = receipt?.providerMessageId ?? null;
  } catch (cause) {
    if (!(cause instanceof EmailNotSent)) {
      throw cause;
    }

    delivery = 'provider_rejected';
    problem = cause.message.slice(0, 500);
  }

  const [row] = await sql<InvitationRow[]>`
    UPDATE staff_invitations SET delivery_status = ${delivery}, provider_message_id = ${messageId}, delivery_error = ${problem}, delivery_attempted_on = now()
    WHERE id = ${issued.invitation.id} RETURNING ${sql(VIEW_COLUMNS)}`;

  return viewOf(row, issued.verifiedEmail);
};

/** Withdraws the invitation waiting for this person, if any. */
export const revokeStaffInvitation = async (
  sql: Sql,
  input: { facilityId: string; staffId: string; revokedBy: string; deviceId: string },
): Promise<boolean> =>
  sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      UPDATE staff_invitations SET revoked_on = now(), revoked_by = ${input.revokedBy}, revoked_reason = 'revoked'
      WHERE facility_id = ${input.facilityId} AND staff_id = ${input.staffId} AND accepted_on IS NULL AND revoked_on IS NULL RETURNING id`;

    if (!row) {
      return false;
    }

    await recordAuditEvent(tx, {
      facilityId: input.facilityId,
      deviceId: input.deviceId,
      actorStaffId: input.revokedBy,
      action: 'revoke',
      entityType: 'staff',
      entityId: input.staffId,
      metadata: { context: 'staff_invitation_revoked', invitationId: row.id },
    });

    return true;
  });

/* ------------------------------------------------------------------ */
/* Accepting                                                           */
/* ------------------------------------------------------------------ */

/**
 * The invitation waiting for this person whose code matches, or undefined. A
 * wrong code counts against it at once, outside any transaction the caller
 * holds, so a later rollback never hands the guess back; after a few it stops
 * working until it is resent.
 */
export const matchInvitationCode = async (
  sql: Sql,
  facilityId: string,
  staffId: string,
  code: string,
): Promise<string | undefined> => {
  const [open] = await sql<
    { id: string; code_hash: string; code_salt: string; code_iterations: number }[]
  >`
    SELECT id, code_hash, code_salt, code_iterations FROM staff_invitations
    WHERE facility_id = ${facilityId} AND staff_id = ${staffId} AND accepted_on IS NULL AND revoked_on IS NULL
      AND expires_on > now() AND failed_attempts < ${INVITATION_LIMITS.failedAttempts}`;

  if (!open) {
    return undefined;
  }

  if (same(hashInvitationCode(code, open.code_salt, open.code_iterations), open.code_hash)) {
    return open.id;
  }

  await sql`UPDATE staff_invitations SET failed_attempts = failed_attempts + 1 WHERE id = ${open.id}`;

  return undefined;
};

/** The email an invitation was sent to, lower-case. */
export const invitationDestination = async (
  sql: Sql | Tx,
  invitationId: string,
): Promise<string | undefined> => {
  const [row] = await sql<{ destination: string }[]>`
    SELECT destination FROM staff_invitations WHERE id = ${invitationId}`;

  return row?.destination.toLowerCase();
};

/**
 * Accepts a matched invitation inside the caller's PIN-registration
 * transaction: false when it was revoked, accepted or expired meanwhile, and
 * then nothing may happen. The address is saved as the person's verified email
 * — possession proven — unless they already have a different verified address
 * (kept: an invitation never replaces one) or another active person here
 * proved it first.
 */
export const acceptInvitation = async (
  tx: Tx,
  identity: DeviceIdentity,
  staffId: string,
  invitationId: string,
): Promise<boolean> => {
  const [row] = await tx<{ destination: string }[]>`
    UPDATE staff_invitations SET accepted_on = now(), accepted_on_device = ${identity.deviceId}
    WHERE id = ${invitationId} AND facility_id = ${identity.facilityId} AND staff_id = ${staffId}
      AND accepted_on IS NULL AND revoked_on IS NULL AND expires_on > now() AND failed_attempts < ${INVITATION_LIMITS.failedAttempts}
    RETURNING destination`;

  if (!row) {
    return false;
  }

  const current = await findStaffEmail(tx, identity.facilityId, staffId);

  const [taken] = await tx`
    SELECT 1 FROM staff_contacts c JOIN staff s ON s.facility_id = c.facility_id AND s.id = c.staff_id
    WHERE c.facility_id = ${identity.facilityId} AND lower(c.email) = ${row.destination} AND c.staff_id <> ${staffId} AND s.active`;

  // A person who already has a different email keeps it; an address someone else uses is not taken over.
  const contactOutcome = () => {
    if (current && current.toLowerCase() !== row.destination) {
      return 'kept_existing';
    }

    return taken ? 'in_use_elsewhere' : 'verified';
  };

  const contact = contactOutcome();

  if (contact === 'verified') {
    await saveStaffEmail(tx, identity.facilityId, staffId, row.destination);
  }

  await recordAuditEvent(tx, {
    facilityId: identity.facilityId,
    deviceId: identity.deviceId,
    actorStaffId: staffId,
    action: 'update',
    entityType: 'staff',
    entityId: staffId,
    metadata: {
      context: 'staff_invitation_accepted',
      invitationId,
      channel: 'email',
      email: maskEmail(row.destination),
      contact,
    },
  });

  return true;
};

/* ------------------------------------------------------------------ */
/* What an administrator sees                                          */
/* ------------------------------------------------------------------ */

export type ContactActivation = {
  email?: { address: string; verified: true };
  invitation?: InvitationView;
  /** Facility devices where the server holds this person's PIN. A PIN set only offline is not counted until it reaches the server. */
  activation: { serverPinDevices: number; lastPinRegisteredOn?: string };
  /** Whether their verified email has a Geneus password, for new devices and a forgotten PIN. */
  password: 'set' | 'not_set';
  /** When the next invitation may be sent, while the resend cooldown runs. */
  nextSendAllowedOn?: string;
};

export const contactActivation = async (
  sql: Sql,
  facilityId: string,
  staffId: string,
): Promise<ContactActivation> => {
  const email = await findStaffEmail(sql, facilityId, staffId);

  const [latest] = await sql<InvitationRow[]>`
    SELECT ${sql(VIEW_COLUMNS)} FROM staff_invitations WHERE facility_id = ${facilityId} AND staff_id = ${staffId} ORDER BY created_on DESC LIMIT 1`;

  const [pins] = await sql<{ devices: number; last: Date | null }[]>`
    SELECT count(*)::int AS devices, max(enrolled_on) AS last FROM staff_device_pins WHERE facility_id = ${facilityId} AND staff_id = ${staffId}`;

  const nextSend = latest
    ? new Date(latest.created_on).getTime() + INVITATION_LIMITS.resendCooldownMs
    : 0;

  return {
    ...(email ? { email: { address: maskEmail(email), verified: true as const } } : {}),
    ...(latest ? { invitation: viewOf(latest, email) } : {}),
    activation: {
      serverPinDevices: pins.devices,
      ...(pins.last ? { lastPinRegisteredOn: iso(pins.last) } : {}),
    },
    password: email && (await hasPassword(sql, email.toLowerCase())) ? 'set' : 'not_set',
    ...(nextSend > Date.now() ? { nextSendAllowedOn: new Date(nextSend).toISOString() } : {}),
  };
};

export type StaffOnboardingSummary = {
  staffId: string;
  activated: boolean;
  /** A verified email: needed for a password, and so for new devices and a forgotten PIN. */
  hasEmail: boolean;
  passwordSet: boolean;
  invitation?: { status: InvitationStatus; delivery: InvitationDelivery; expiresOn: string };
};

/** One line per member of staff, for the Staff directory: email, password, PIN and invitation. */
export const onboardingSummaries = async (
  sql: Sql,
  facilityId: string,
): Promise<StaffOnboardingSummary[]> => {
  const latest = await sql<(InvitationRow & { staff_id: string })[]>`
    SELECT DISTINCT ON (staff_id) staff_id, ${sql(VIEW_COLUMNS)} FROM staff_invitations WHERE facility_id = ${facilityId} ORDER BY staff_id, created_on DESC`;

  const activated = new Set(
    (
      await sql<
        { staff_id: string }[]
      >`SELECT DISTINCT staff_id FROM staff_device_pins WHERE facility_id = ${facilityId}`
    ).map((r) => r.staff_id),
  );

  const accounts = await sql<{ staff_id: string; has_email: boolean; password_set: boolean }[]>`
    SELECT s.id AS staff_id, c.email IS NOT NULL AS has_email, p.email IS NOT NULL AS password_set
    FROM staff s
    LEFT JOIN staff_contacts c ON c.facility_id = s.facility_id AND c.staff_id = s.id
    LEFT JOIN staff_passwords p ON p.email = lower(c.email)
    WHERE s.facility_id = ${facilityId}`;

  const summaries = new Map<string, StaffOnboardingSummary>();

  for (const account of accounts) {
    summaries.set(account.staff_id, {
      staffId: account.staff_id,
      activated: activated.has(account.staff_id),
      hasEmail: account.has_email,
      passwordSet: account.password_set,
    });
  }

  for (const row of latest) {
    const account = summaries.get(row.staff_id);

    summaries.set(row.staff_id, {
      staffId: row.staff_id,
      activated: activated.has(row.staff_id),
      hasEmail: account?.hasEmail ?? false,
      passwordSet: account?.passwordSet ?? false,
      invitation: {
        status: statusOf(row),
        delivery: row.delivery_status,
        expiresOn: iso(row.expires_on),
      },
    });
  }

  return [...summaries.values()];
};

/* ------------------------------------------------------------------ */
/* Invitation links                                                    */
/* ------------------------------------------------------------------ */

/** What the person opening a link sees: who it is for and what this link can still do. Never a code. */
export type InvitationLinkView = {
  staffId: string;
  staffName: string;
  role: string;
  facilityId: string;
  facilityName: string;
  expiresOn: string;
  status: InvitationStatus;
  /** Whether a device not yet enrolled at the facility can be enrolled from this link. */
  newDevice: 'allowed' | 'used' | 'not_allowed';
};

type LinkRow = {
  id: string;
  facility_id: string;
  staff_id: string;
  failed_attempts: number;
  expires_on: Date;
  accepted_on: Date | null;
  revoked_on: Date | null;
  allows_new_device: boolean;
  device_enrolled_on: Date | null;
  created_by: string;
  created_from: string;
  full_name: string;
  role: string;
  staff_active: boolean;
  facility_name: string;
};

const findByLink = async (
  tx: Sql | Tx,
  token: string,
  lock: boolean,
): Promise<LinkRow | undefined> => {
  const [row] = await tx<LinkRow[]>`
    SELECT i.id, i.facility_id, i.staff_id, i.failed_attempts, i.expires_on, i.accepted_on, i.revoked_on, i.allows_new_device,
      i.device_enrolled_on, i.created_by, i.created_from, s.full_name, s.role, s.active AS staff_active, f.name AS facility_name
    FROM staff_invitations i
    JOIN staff s ON s.facility_id = i.facility_id AND s.id = i.staff_id
    JOIN facilities f ON f.id = i.facility_id
    WHERE i.link_hash = ${linkHash(token)}
    ${lock ? tx`FOR UPDATE OF i` : tx``}`;

  return row;
};

/** Pending, and still for an active member of staff: the only state in which a link does anything. */
const usable = (row: LinkRow | undefined): row is LinkRow =>
  Boolean(row && row.staff_active && statusOf(row) === 'pending');

/** Reads a link without spending anything. Undefined when no invitation has this link. */
export const openInvitationLink = async (
  sql: Sql,
  token: string,
): Promise<InvitationLinkView | undefined> => {
  const row = await findByLink(sql, token, false);

  if (!row) {
    return undefined;
  }

  return {
    staffId: row.staff_id,
    staffName: row.full_name,
    role: row.role,
    facilityId: row.facility_id,
    facilityName: row.facility_name,
    expiresOn: iso(row.expires_on),
    status: row.staff_active ? statusOf(row) : 'revoked',
    newDevice: newDeviceState(row),
  };
};

export type LinkDeviceOutcome =
  | { ok: true; credential: DeviceCredential }
  | { ok: false; error: 'invalid_invitation' | 'device_not_allowed' | 'device_already_enrolled' };

/**
 * Enrols the device opening the link, when the invitation allows one new device
 * and its sender may still enrol devices. In one transaction: the allowance is
 * locked and spent, and an enrollment code is issued in the sender's name and
 * claimed by this device through the same path as a code typed by hand, so the
 * device, its credential and the audit trail are exactly those of any enrollment.
 * The person's PIN is set up afterwards, as on any facility device.
 */
export const enrolDeviceFromInvitation = async (
  sql: Sql,
  request: { token: string; deviceId: string; deviceLabel?: string },
  syncEndpoint: string,
): Promise<LinkDeviceOutcome> => {
  try {
    return await sql.begin(async (tx): Promise<LinkDeviceOutcome> => {
      const row = await findByLink(tx, request.token, true);

      if (!usable(row)) {
        return { ok: false, error: 'invalid_invitation' };
      }

      if (!row.allows_new_device || row.device_enrolled_on) {
        return { ok: false, error: 'device_not_allowed' };
      }

      // The allowance is the sender's authority, so it lapses if they lose it.
      if (
        'denial' in (await authorizeStaff(tx, row.facility_id, row.created_by, 'device:enroll'))
      ) {
        return { ok: false, error: 'device_not_allowed' };
      }

      const { code } = await issueEnrollmentCode(
        tx,
        row.facility_id,
        row.created_by,
        row.created_from,
      );

      const enrolled = await claimCodeAndEnroll(
        tx,
        { code, deviceId: request.deviceId, deviceLabel: request.deviceLabel },
        syncEndpoint,
      );

      if (!enrolled.ok) {
        throw new Error(
          `An enrollment code issued for invitation ${row.id} could not be claimed: ${enrolled.error}`,
        );
      }

      await tx`UPDATE staff_invitations SET device_enrolled_on = now(), device_enrolled_id = ${request.deviceId} WHERE id = ${row.id}`;
      await recordAuditEvent(tx, {
        facilityId: row.facility_id,
        deviceId: request.deviceId,
        actorStaffId: row.created_by,
        action: 'enroll',
        entityType: 'device',
        entityId: request.deviceId,
        metadata: {
          context: 'staff_invitation_device_enrolled',
          invitationId: row.id,
          staffId: row.staff_id,
        },
      });

      return { ok: true, credential: enrolled.credential };
    });
  } catch (cause) {
    if (isPostgresError(cause, UNIQUE_VIOLATION)) {
      return { ok: false, error: 'device_already_enrolled' };
    }

    throw cause;
  }
};

export type LinkCodeOutcome =
  | { ok: true; staffId: string; code: string }
  | { ok: false; error: 'invalid_invitation' | 'other_facility' };

/**
 * On a device enrolled at the invitation's facility, exchanges the link for a
 * fresh one-time PIN setup code, so the person never copies one by hand. It
 * replaces the stored code (the one in the email stops working) and spends
 * nothing: the invitation is accepted, as before, only when the PIN is enrolled
 * with this code through POST /staff/session/enrol.
 */
export const invitationLinkCode = async (
  sql: Sql,
  identity: DeviceIdentity,
  token: string,
): Promise<LinkCodeOutcome> =>
  sql.begin(async (tx): Promise<LinkCodeOutcome> => {
    const row = await findByLink(tx, token, true);

    if (!usable(row)) {
      return { ok: false, error: 'invalid_invitation' };
    }

    if (row.facility_id !== identity.facilityId) {
      return { ok: false, error: 'other_facility' };
    }

    const code = newInvitationCode();
    const salt = randomBytes(16).toString('base64');
    await tx`
      UPDATE staff_invitations SET code_hash = ${hashInvitationCode(code, salt, INVITATION_CODE_ITERATIONS)}, code_salt = ${salt}, code_iterations = ${INVITATION_CODE_ITERATIONS}
      WHERE id = ${row.id}`;

    await recordAuditEvent(tx, {
      facilityId: row.facility_id,
      deviceId: identity.deviceId,
      actorStaffId: row.staff_id,
      action: 'update',
      entityType: 'staff',
      entityId: row.staff_id,
      metadata: { context: 'staff_invitation_link_opened', invitationId: row.id },
    });

    return { ok: true, staffId: row.staff_id, code };
  });
