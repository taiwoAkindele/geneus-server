import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Sql, Tx } from '../db/client.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import type { DeviceIdentity } from '../devices/credentials.ts';
import { findStaffEmail, saveStaffEmail } from '../email/verifications.ts';
import { EmailNotSent, maskEmail, type Mailer } from '../lib/email.ts';
import { hashPinSetupCode, newPinSetupCode, PIN_SETUP_CODE_ITERATIONS, PIN_SETUP_CODE_TTL_MS, pinAuthorityRefusal, revokeOpenPinSetupCodes } from './pinSetupCodes.ts';

/**
 * Staff invitations (SCHEMA.md §10): the PIN setup code an administrator would
 * read aloud, sent instead to a contact they entered. The person redeems it on
 * a facility device, online, through POST /staff/session/enrol — which checks
 * it here, accepts it and registers their PIN in one transaction.
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
export type InvitationDelivery = 'sending' | 'provider_accepted' | 'provider_rejected' | 'not_configured';

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
};

type InvitationRow = {
  id: string; channel: 'email'; destination: string; failed_attempts: number;
  created_on: Date; expires_on: Date; delivery_status: InvitationDelivery;
  accepted_on: Date | null; revoked_on: Date | null; revoked_reason: InvitationView['revokedReason'] | null;
};

const iso = (value: Date | string) => new Date(value).toISOString();

const statusOf = (row: InvitationRow, now = Date.now()): InvitationStatus =>
  row.accepted_on ? 'accepted'
    : row.revoked_on ? 'revoked'
      : row.failed_attempts >= INVITATION_LIMITS.failedAttempts ? 'locked'
        : new Date(row.expires_on).getTime() <= now ? 'expired'
          : 'pending';

/**
 * The address is shown in full only while it is just what the administrator
 * typed. Once it is the person's proven email — accepted, or sent to the
 * verified address on file — it is masked like any other verified contact.
 */
const viewOf = (row: InvitationRow, verifiedEmail?: string): InvitationView => {
  const status = statusOf(row);
  const proven = status === 'accepted' || (verifiedEmail !== undefined && verifiedEmail.toLowerCase() === row.destination);
  return {
    id: row.id, channel: row.channel,
    destination: proven ? maskEmail(row.destination) : row.destination,
    status, delivery: row.delivery_status, createdOn: iso(row.created_on), expiresOn: iso(row.expires_on),
    ...(row.accepted_on ? { acceptedOn: iso(row.accepted_on) } : {}),
    ...(row.revoked_on ? { revokedOn: iso(row.revoked_on), ...(row.revoked_reason ? { revokedReason: row.revoked_reason } : {}) } : {}),
  };
};

const VIEW_COLUMNS = ['id', 'channel', 'destination', 'failed_attempts', 'created_on', 'expires_on', 'delivery_status', 'accepted_on', 'revoked_on', 'revoked_reason'];

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/* ------------------------------------------------------------------ */
/* Issuing                                                             */
/* ------------------------------------------------------------------ */

export type InvitationRefusal =
  | 'unknown_staff' | 'clinical_review_required' | 'own_account'
  | 'contact_change_required' | 'email_in_use'
  | 'too_soon' | 'daily_limit' | 'facility_limit';

export type IssuedInvitation =
  | { ok: true; code: string; destination: string; invitation: InvitationView; staffName: string; facilityName: string; verifiedEmail?: string }
  | { ok: false; error: InvitationRefusal; retryAfterSeconds?: number };

/**
 * Creates an invitation for `staffId` to `email`. In one transaction, under the
 * facility row lock so limits are counted exactly: checks authority as for a
 * PIN code, the contact rules and the limits; revokes any code read aloud and
 * any earlier invitation; stores the new code's hash. Sending is a separate
 * step (`deliverInvitation`), after commit.
 */
export const issueStaffInvitation = async (
  sql: Sql,
  input: { facilityId: string; staffId: string; issuedBy: string; issuedFrom: string; email: string },
): Promise<IssuedInvitation> =>
  sql.begin(async (tx): Promise<IssuedInvitation> => {
    const [facility] = await tx<{ name: string }[]>`SELECT name FROM facilities WHERE id = ${input.facilityId} FOR UPDATE`;
    if (input.staffId === input.issuedBy) return { ok: false, error: 'own_account' };
    const refusal = await pinAuthorityRefusal(tx, input, true);
    if (refusal) return { ok: false, error: refusal };

    const email = input.email.trim().toLowerCase();
    // A proven address is changed only by its owner (with codes to old and new), never redirected by an invitation.
    const verified = await findStaffEmail(tx, input.facilityId, input.staffId);
    if (verified && verified.toLowerCase() !== email) return { ok: false, error: 'contact_change_required' };
    const [taken] = await tx`
      SELECT 1 FROM staff s
      WHERE s.facility_id = ${input.facilityId} AND s.id <> ${input.staffId} AND s.active AND (
        EXISTS (SELECT 1 FROM staff_contacts c WHERE c.facility_id = s.facility_id AND c.staff_id = s.id AND lower(c.email) = ${email})
        OR EXISTS (SELECT 1 FROM staff_invitations i WHERE i.facility_id = s.facility_id AND i.staff_id = s.id AND i.destination = ${email}
          AND i.accepted_on IS NULL AND i.revoked_on IS NULL AND i.expires_on > now()))`;
    if (taken) return { ok: false, error: 'email_in_use' };

    const [counts] = await tx<{ since_last_ms: number | null; today: number; this_hour: number }[]>`
      SELECT
        (SELECT extract(epoch FROM now() - max(created_on)) * 1000 FROM staff_invitations WHERE facility_id = ${input.facilityId} AND staff_id = ${input.staffId})::float8 AS since_last_ms,
        (SELECT count(*) FROM staff_invitations WHERE facility_id = ${input.facilityId} AND staff_id = ${input.staffId} AND created_on > now() - interval '1 day')::int AS today,
        (SELECT count(*) FROM staff_invitations WHERE facility_id = ${input.facilityId} AND created_on > now() - interval '1 hour')::int AS this_hour`;
    if (counts.since_last_ms !== null && counts.since_last_ms < INVITATION_LIMITS.resendCooldownMs) {
      return { ok: false, error: 'too_soon', retryAfterSeconds: Math.ceil((INVITATION_LIMITS.resendCooldownMs - counts.since_last_ms) / 1000) };
    }
    if (counts.today >= INVITATION_LIMITS.perPersonPerDay) return { ok: false, error: 'daily_limit' };
    if (counts.this_hour >= INVITATION_LIMITS.perFacilityPerHour) return { ok: false, error: 'facility_limit' };

    await revokeOpenPinSetupCodes(tx, input);
    await tx`
      UPDATE staff_invitations SET revoked_on = now(), revoked_by = ${input.issuedBy}, revoked_reason = 'resent'
      WHERE facility_id = ${input.facilityId} AND staff_id = ${input.staffId} AND accepted_on IS NULL AND revoked_on IS NULL`;

    const code = newPinSetupCode();
    const salt = randomBytes(16).toString('base64');
    const id = `staff_invitation:${randomUUID()}`;
    const expiresOn = new Date(Date.now() + PIN_SETUP_CODE_TTL_MS).toISOString();
    const [row] = await tx<InvitationRow[]>`
      INSERT INTO staff_invitations (id, facility_id, staff_id, channel, destination, code_hash, code_salt, code_iterations, created_by, created_from, expires_on)
      VALUES (${id}, ${input.facilityId}, ${input.staffId}, 'email', ${email}, ${hashPinSetupCode(code, salt, PIN_SETUP_CODE_ITERATIONS)}, ${salt},
        ${PIN_SETUP_CODE_ITERATIONS}, ${input.issuedBy}, ${input.issuedFrom}, ${expiresOn})
      RETURNING ${tx(VIEW_COLUMNS)}`;
    const [staff] = await tx<{ full_name: string }[]>`SELECT full_name FROM staff WHERE facility_id = ${input.facilityId} AND id = ${input.staffId}`;
    await recordAuditEvent(tx, {
      facilityId: input.facilityId, deviceId: input.issuedFrom, actorStaffId: input.issuedBy, action: 'create', entityType: 'staff', entityId: input.staffId,
      metadata: { context: 'staff_invitation_created', invitationId: id, channel: 'email', email: maskEmail(email), resend: counts.since_last_ms !== null },
    });
    return { ok: true, code, destination: email, invitation: viewOf(row, verified), staffName: staff.full_name, facilityName: facility.name, ...(verified ? { verifiedEmail: verified } : {}) };
  });

const invitationEmail = (input: { code: string; expiresOn: string; staffName: string; facilityName: string }) => ({
  subject: `Your Geneus invitation from ${input.facilityName}`,
  text: [
    `${input.staffName}, you have been added as staff at ${input.facilityName} on Geneus.`,
    '',
    `Your Geneus PIN code is ${input.code}.`,
    '',
    `To start: open Geneus on one of ${input.facilityName}'s phones or computers, tap your name on the sign-in screen, choose "I have a code from my admin", enter this code and choose your PIN. The device needs an internet connection for this step; after it, you sign in with your PIN, even offline.`,
    '',
    `The code works once, until ${new Date(input.expiresOn).toUTCString()}. Never share it — nobody from Geneus or your facility will ask for it.`,
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
  issued: { code: string; destination: string; invitation: InvitationView; staffName: string; facilityName: string; verifiedEmail?: string },
): Promise<InvitationView> => {
  let delivery: InvitationDelivery, messageId: string | null = null, problem: string | null = null;
  try {
    const receipt = await mailer.send({ to: issued.destination, ...invitationEmail({ code: issued.code, expiresOn: issued.invitation.expiresOn, staffName: issued.staffName, facilityName: issued.facilityName }) });
    delivery = mailer.configured ? 'provider_accepted' : 'not_configured';
    messageId = receipt?.providerMessageId ?? null;
  } catch (cause) {
    if (!(cause instanceof EmailNotSent)) throw cause;
    delivery = 'provider_rejected';
    problem = cause.message.slice(0, 500);
  }
  const [row] = await sql<InvitationRow[]>`
    UPDATE staff_invitations SET delivery_status = ${delivery}, provider_message_id = ${messageId}, delivery_error = ${problem}, delivery_attempted_on = now()
    WHERE id = ${issued.invitation.id} RETURNING ${sql(VIEW_COLUMNS)}`;
  return viewOf(row, issued.verifiedEmail);
};

/** Withdraws the invitation waiting for this person, if any. */
export const revokeStaffInvitation = async (sql: Sql, input: { facilityId: string; staffId: string; revokedBy: string; deviceId: string }): Promise<boolean> =>
  sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      UPDATE staff_invitations SET revoked_on = now(), revoked_by = ${input.revokedBy}, revoked_reason = 'revoked'
      WHERE facility_id = ${input.facilityId} AND staff_id = ${input.staffId} AND accepted_on IS NULL AND revoked_on IS NULL RETURNING id`;
    if (!row) return false;
    await recordAuditEvent(tx, {
      facilityId: input.facilityId, deviceId: input.deviceId, actorStaffId: input.revokedBy, action: 'revoke', entityType: 'staff', entityId: input.staffId,
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
export const matchInvitationCode = async (sql: Sql, facilityId: string, staffId: string, code: string): Promise<string | undefined> => {
  const [open] = await sql<{ id: string; code_hash: string; code_salt: string; code_iterations: number }[]>`
    SELECT id, code_hash, code_salt, code_iterations FROM staff_invitations
    WHERE facility_id = ${facilityId} AND staff_id = ${staffId} AND accepted_on IS NULL AND revoked_on IS NULL
      AND expires_on > now() AND failed_attempts < ${INVITATION_LIMITS.failedAttempts}`;
  if (!open) return undefined;
  if (same(hashPinSetupCode(code, open.code_salt, open.code_iterations), open.code_hash)) return open.id;
  await sql`UPDATE staff_invitations SET failed_attempts = failed_attempts + 1 WHERE id = ${open.id}`;
  return undefined;
};

/**
 * Accepts a matched invitation inside the caller's PIN-registration
 * transaction: false when it was revoked, accepted or expired meanwhile, and
 * then nothing may happen. The address is saved as the person's verified email
 * — possession proven — unless they already have a different verified address
 * (kept: an invitation never replaces one) or another active person here
 * proved it first.
 */
export const acceptInvitation = async (tx: Tx, identity: DeviceIdentity, staffId: string, invitationId: string): Promise<boolean> => {
  const [row] = await tx<{ destination: string }[]>`
    UPDATE staff_invitations SET accepted_on = now(), accepted_on_device = ${identity.deviceId}
    WHERE id = ${invitationId} AND facility_id = ${identity.facilityId} AND staff_id = ${staffId}
      AND accepted_on IS NULL AND revoked_on IS NULL AND expires_on > now() AND failed_attempts < ${INVITATION_LIMITS.failedAttempts}
    RETURNING destination`;
  if (!row) return false;
  const current = await findStaffEmail(tx, identity.facilityId, staffId);
  const [taken] = await tx`
    SELECT 1 FROM staff_contacts c JOIN staff s ON s.facility_id = c.facility_id AND s.id = c.staff_id
    WHERE c.facility_id = ${identity.facilityId} AND lower(c.email) = ${row.destination} AND c.staff_id <> ${staffId} AND s.active`;
  const contact = current && current.toLowerCase() !== row.destination ? 'kept_existing' : taken ? 'in_use_elsewhere' : 'verified';
  if (contact === 'verified') await saveStaffEmail(tx, identity.facilityId, staffId, row.destination);
  await recordAuditEvent(tx, {
    facilityId: identity.facilityId, deviceId: identity.deviceId, actorStaffId: staffId, action: 'update', entityType: 'staff', entityId: staffId,
    metadata: { context: 'staff_invitation_accepted', invitationId, channel: 'email', email: maskEmail(row.destination), contact },
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
  /** When the next invitation may be sent, while the resend cooldown runs. */
  nextSendAllowedOn?: string;
};

export const contactActivation = async (sql: Sql, facilityId: string, staffId: string): Promise<ContactActivation> => {
  const email = await findStaffEmail(sql, facilityId, staffId);
  const [latest] = await sql<InvitationRow[]>`
    SELECT ${sql(VIEW_COLUMNS)} FROM staff_invitations WHERE facility_id = ${facilityId} AND staff_id = ${staffId} ORDER BY created_on DESC LIMIT 1`;
  const [pins] = await sql<{ devices: number; last: Date | null }[]>`
    SELECT count(*)::int AS devices, max(enrolled_on) AS last FROM staff_device_pins WHERE facility_id = ${facilityId} AND staff_id = ${staffId}`;
  const nextSend = latest ? new Date(latest.created_on).getTime() + INVITATION_LIMITS.resendCooldownMs : 0;
  return {
    ...(email ? { email: { address: maskEmail(email), verified: true as const } } : {}),
    ...(latest ? { invitation: viewOf(latest, email) } : {}),
    activation: { serverPinDevices: pins.devices, ...(pins.last ? { lastPinRegisteredOn: iso(pins.last) } : {}) },
    ...(nextSend > Date.now() ? { nextSendAllowedOn: new Date(nextSend).toISOString() } : {}),
  };
};

export type StaffOnboardingSummary = { staffId: string; activated: boolean; invitation?: { status: InvitationStatus; delivery: InvitationDelivery; expiresOn: string } };

/** One line per person with an invitation or a server-registered PIN: for the Staff directory. */
export const onboardingSummaries = async (sql: Sql, facilityId: string): Promise<StaffOnboardingSummary[]> => {
  const latest = await sql<(InvitationRow & { staff_id: string })[]>`
    SELECT DISTINCT ON (staff_id) staff_id, ${sql(VIEW_COLUMNS)} FROM staff_invitations WHERE facility_id = ${facilityId} ORDER BY staff_id, created_on DESC`;
  const activated = new Set((await sql<{ staff_id: string }[]>`SELECT DISTINCT staff_id FROM staff_device_pins WHERE facility_id = ${facilityId}`).map((r) => r.staff_id));
  const summaries = new Map<string, StaffOnboardingSummary>();
  for (const staffId of activated) summaries.set(staffId, { staffId, activated: true });
  for (const row of latest) summaries.set(row.staff_id, { staffId: row.staff_id, activated: activated.has(row.staff_id), invitation: { status: statusOf(row), delivery: row.delivery_status, expiresOn: iso(row.expires_on) } });
  return [...summaries.values()];
};
