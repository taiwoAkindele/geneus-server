import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasRole,
  mayApprovePin,
  PinSetupCodeRequest,
  StaffEmailConfirmation,
  StaffEmailRequest,
  type ApiErrorBody,
  type EmailSent,
  type PinSetupCodeIssued,
} from '#shared';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { verifiedRequestStaff } from '../auth/staffSessions.ts';
import type { DeviceIdentity } from '../devices/credentials.ts';
import { authorizeStaff, describeDenial, findStaffInFacility } from '../auth/staffAuthorization.ts';
import type { Sql } from '../db/client.ts';
import {
  checkVerificationCode,
  consumeVerification,
  createVerificationCode,
  findStaffEmail,
  saveStaffEmail,
  staffEmailSubject,
  verificationEmail,
} from '../email/verifications.ts';
import { maskEmail, type Mailer } from '../lib/email.ts';
import { issuePinSetupCode } from '../staff/pinSetupCodes.ts';
import {
  contactActivation,
  deliverInvitation,
  issueStaffInvitation,
  matchInvitationCode,
  onboardingSummaries,
  revokeStaffInvitation,
  type InvitationRefusal,
} from '../staff/invitations.ts';
import { z } from 'zod';

/**
 * Staff access that has to be decided online. Every route is called from an
 * enrolled device, and the facility comes from its credential, so a member of
 * staff of another facility is simply not found.
 *
 * - Issuing a PIN setup code for someone: an admin holding `staff:manage`,
 *   proven by their own server session (PIN or emailed code), never by a
 *   staff id the device asserts.
 * - A facility admin's recovery email: set only by that admin in their own
 *   proven session, plus a code to the new inbox (and the current one).
 * - A PIN setup code sent to the recovery email: the inbox protects it — a
 *   code is only ever emailed to the admin's own proven address.
 */
const pinCodeEmail = (code: string, expiresOn: string) => ({
  subject: 'Your Geneus PIN code',
  text: [
    `Your Geneus PIN code is ${code}.`,
    '',
    'On the sign-in screen, tap your name, choose "I have a code from my admin", enter this code and choose a new PIN.',
    `It works once, until ${new Date(expiresOn).toUTCString()}.`,
    '',
    'If you did not ask for it, someone with one of your facility\'s phones did. Nobody can use it without this email, but tell your team.',
  ].join('\n'),
});

const refuse = (reply: FastifyReply, status: number, error: string, message: string) =>
  reply.code(status).send({ error, message } satisfies ApiErrorBody);

export const registerStaffRoutes = (app: FastifyInstance, sql: Sql, mailer: Mailer) => {
  /** Only an active facility admin of the device's facility has a recovery email. */
  const findAdmin = async (facilityId: string, staffId: string) => {
    const staff = await findStaffInFacility(sql, facilityId, staffId);
    return staff?.active && hasRole(staff, 'facility_admin') ? staff : undefined;
  };

  /**
   * A recovery email decides where PIN codes go, so it is set only by the
   * admin themselves as the server has proven them — never by a device that
   * merely names them.
   */
  const ownRecoveryEmailRefusal = async (request: FastifyRequest<{ Params: { staffId: string } }>, identity: DeviceIdentity, requestedBy: string) => {
    if (requestedBy !== request.params.staffId || !(await findAdmin(identity.facilityId, requestedBy))) {
      return { error: 'forbidden', message: 'A facility admin can set only their own recovery email' };
    }
    const proven = await verifiedRequestStaff(sql, identity, request.headers);
    if (proven?.id !== requestedBy) return { error: 'staff_session_required', message: 'Confirm your PIN to change your recovery email' };
    return undefined;
  };

  app.post<{ Params: { staffId: string } }>('/staff/:staffId/pin-codes', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;

    const parsed = PinSetupCodeRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'issuedBy is required', issues: parsed.error.issues } satisfies ApiErrorBody);
    }

    // A PIN code makes whoever holds it that person on a device, so the issuer must be proven, not asserted.
    const issuer = await verifiedRequestStaff(sql, identity, request.headers);
    if (!issuer) return refuse(reply, 403, 'staff_session_required', 'Confirm your PIN to issue a PIN code');
    if (issuer.id !== parsed.data.issuedBy) return refuse(reply, 403, 'attribution_mismatch', 'A PIN code is issued in the name of the person signed in');
    const authorized = await authorizeStaff(sql, identity.facilityId, issuer.id, 'staff:manage');
    if ('denial' in authorized) {
      request.log.warn({ deviceId: identity.deviceId, denial: authorized.denial }, 'PIN setup code refused');
      return reply.code(403).send({ error: 'forbidden', message: describeDenial(authorized.denial) } satisfies ApiErrorBody);
    }

    const target = await findStaffInFacility(sql, identity.facilityId, request.params.staffId);
    if (!target?.active) return refuse(reply, 404, 'unknown_staff', 'No active member of staff with that id at this facility');
    if (!mayApprovePin(authorized.staff, target)) {
      return refuse(reply, 403, 'forbidden', 'You cannot reset a PIN for someone with access you do not hold');
    }

    const outcome = await issuePinSetupCode(sql, {
      facilityId: identity.facilityId,
      staffId: request.params.staffId,
      issuedBy: parsed.data.issuedBy,
      issuedFrom: identity.deviceId,
    });
    if (!outcome.ok) {
      if (outcome.error === 'clinical_review_required') return refuse(reply, 403, 'clinical_review_required', 'An authorized clinical reviewer must approve this account reset');
      return reply.code(404).send({ error: 'unknown_staff', message: 'No active member of staff with that id at this facility' } satisfies ApiErrorBody);
    }

    request.log.info({ facilityId: identity.facilityId, staffId: request.params.staffId, issuedBy: parsed.data.issuedBy }, 'PIN setup code issued');
    const response: PinSetupCodeIssued = { code: outcome.code, expiresOn: outcome.record.expiresOn };
    return reply.code(201).send(response);
  });

  /**
   * A facility admin who forgot their PIN gets a PIN setup code at their
   * recovery email. Anyone holding a facility phone can ask; only the admin's
   * inbox receives the code.
   */
  app.post<{ Params: { staffId: string } }>('/staff/:staffId/pin-codes/email', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;

    const admin = await findAdmin(identity.facilityId, request.params.staffId);
    if (!admin) return refuse(reply, 404, 'not_an_admin', 'Only a facility admin can get a PIN code by email');
    const email = await findStaffEmail(sql, identity.facilityId, admin.id);
    if (!email) {
      return refuse(reply, 404, 'no_recovery_email', 'No recovery email is on file for this admin — ask another admin for a code');
    }

    const outcome = await issuePinSetupCode(sql, {
      facilityId: identity.facilityId,
      staffId: admin.id,
      issuedBy: 'system',
      issuedFrom: identity.deviceId,
      channel: 'email',
    });
    if (!outcome.ok) return refuse(reply, 404, 'not_an_admin', 'Only a facility admin can get a PIN code by email');

    await mailer.send({ to: email, ...pinCodeEmail(outcome.code, outcome.record.expiresOn) });
    request.log.info({ facilityId: identity.facilityId, staffId: admin.id }, 'PIN setup code emailed');
    const response: EmailSent = { sentTo: maskEmail(email), expiresOn: outcome.record.expiresOn };
    return reply.code(202).send(response);
  });

  /**
   * Step one of adding or changing an admin's own recovery email: a code to the
   * new address, and — when one is already on file — a second code to that
   * address, so a phone in the wrong hands cannot redirect recovery.
   */
  app.post<{ Params: { staffId: string } }>('/staff/:staffId/email/code', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;

    const parsed = StaffEmailRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'A valid email address is needed', issues: parsed.error.issues } satisfies ApiErrorBody);
    }
    const { email, requestedBy } = parsed.data;
    const refusal = await ownRecoveryEmailRefusal(request, identity, requestedBy);
    if (refusal) return refuse(reply, 403, refusal.error, refusal.message);

    const subject = staffEmailSubject(identity.facilityId, requestedBy);
    const fresh = await createVerificationCode(sql, { purpose: 'staff_email', subject, email });
    await mailer.send({ to: email, ...verificationEmail(fresh.code, 'staff_email') });

    const current = await findStaffEmail(sql, identity.facilityId, requestedBy);
    let currentSentTo: string | undefined;
    if (current && current !== email) {
      const confirm = await createVerificationCode(sql, { purpose: 'staff_email_current', subject, email: current });
      await mailer.send({ to: current, ...verificationEmail(confirm.code, 'staff_email_current') });
      currentSentTo = maskEmail(current);
    }

    const response: EmailSent = { sentTo: maskEmail(email), currentSentTo, expiresOn: fresh.expiresOn };
    return reply.code(202).send(response);
  });

  /** Step two: both codes check out, and the new address replaces the old in one transaction. */
  app.post<{ Params: { staffId: string } }>('/staff/:staffId/email', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;

    const parsed = StaffEmailConfirmation.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'The email and its 6-digit code are needed', issues: parsed.error.issues } satisfies ApiErrorBody);
    }
    const { email, code, currentCode, requestedBy } = parsed.data;
    const refusal = await ownRecoveryEmailRefusal(request, identity, requestedBy);
    if (refusal) return refuse(reply, 403, refusal.error, refusal.message);

    const subject = staffEmailSubject(identity.facilityId, requestedBy);
    const fresh = await checkVerificationCode(sql, { purpose: 'staff_email', subject, email, code });
    if (!fresh) return refuse(reply, 403, 'invalid_email_code', 'The code for the new email is not right, or has expired — ask for a new one');

    const current = await findStaffEmail(sql, identity.facilityId, requestedBy);
    let confirmed: string | undefined;
    if (current && current !== email) {
      confirmed = currentCode
        ? await checkVerificationCode(sql, { purpose: 'staff_email_current', subject, email: current, code: currentCode })
        : undefined;
      if (!confirmed) {
        return refuse(reply, 403, 'invalid_current_code', `The code sent to ${maskEmail(current)} is not right, or has expired`);
      }
    }

    const saved = await sql.begin(async (tx) => {
      if (!(await consumeVerification(tx, fresh))) return false;
      if (confirmed && !(await consumeVerification(tx, confirmed))) throw new Error('current-address code spent concurrently');
      await saveStaffEmail(tx, identity.facilityId, requestedBy, email);
      await recordAuditEvent(tx, {
        facilityId: identity.facilityId,
        deviceId: identity.deviceId,
        actorStaffId: requestedBy,
        action: 'update',
        entityType: 'staff',
        entityId: requestedBy,
        metadata: { recoveryEmail: current ? 'replaced' : 'added' },
      });
      return true;
    });
    if (!saved) return refuse(reply, 403, 'invalid_email_code', 'That code was already used — ask for a new one');

    request.log.info({ facilityId: identity.facilityId, staffId: requestedBy }, 'recovery email saved');
    return reply.code(204).send();
  });

  /* ---------------- Invitations (SCHEMA.md §10) ---------------- */

  /**
   * Invitations hand out PIN authority, so every administrator action on them
   * comes from a proven session holding `staff:manage` — never an asserted id.
   */
  const provenManager = async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;
    const actor = await verifiedRequestStaff(sql, identity, request.headers);
    if (!actor) { refuse(reply, 403, 'staff_session_required', 'Confirm your PIN to manage invitations'); return; }
    const authorized = await authorizeStaff(sql, identity.facilityId, actor.id, 'staff:manage');
    if ('denial' in authorized) { refuse(reply, 403, 'forbidden', describeDenial(authorized.denial)); return; }
    return { identity, actor: authorized.staff };
  };

  const INVITATION_REFUSALS: Record<InvitationRefusal, [number, string]> = {
    unknown_staff: [404, 'No active member of staff with that id at this facility'],
    clinical_review_required: [403, 'An authorized clinical reviewer must approve access for this person'],
    own_account: [403, 'You cannot send an invitation to yourself'],
    contact_change_required: [409, 'This person already has a verified email. Invitations go to that address; they change it themselves from My profile'],
    email_in_use: [409, 'Another member of staff here uses this email address'],
    too_soon: [429, 'An invitation was just sent. Wait a minute before sending another'],
    daily_limit: [429, 'Five invitations were sent to this person today. Try again tomorrow, or give them a PIN code in person'],
    facility_limit: [429, 'Too many invitations were sent from this facility in the last hour. Try again later'],
  };

  /**
   * Sends (or resends) an invitation by email. With no address, it goes to the
   * person's verified email — which the administrator sees only masked. The
   * answer never contains the code.
   */
  app.post<{ Params: { staffId: string } }>('/staff/:staffId/invitations', async (request, reply) => {
    const who = await provenManager(request, reply); if (!who) return;
    // A pasted address often carries spaces or capitals; neither makes it a different address.
    const body = z.strictObject({ channel: z.literal('email'), email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional() }).safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request', 'Enter a valid email address');
    const target = await findStaffInFacility(sql, who.identity.facilityId, request.params.staffId);
    if (!target?.active) return refuse(reply, 404, 'unknown_staff', 'No active member of staff with that id at this facility');
    if (!mayApprovePin(who.actor, target)) return refuse(reply, 403, 'forbidden', 'You cannot invite someone with access you do not hold');
    const email = body.data.email ?? await findStaffEmail(sql, who.identity.facilityId, target.id);
    if (!email) return refuse(reply, 400, 'email_required', 'Enter the email address to send the invitation to');

    const issued = await issueStaffInvitation(sql, { facilityId: who.identity.facilityId, staffId: target.id, issuedBy: who.actor.id, issuedFrom: who.identity.deviceId, email });
    if (!issued.ok) {
      const [status, message] = INVITATION_REFUSALS[issued.error];
      if (issued.retryAfterSeconds) reply.header('retry-after', String(issued.retryAfterSeconds));
      return refuse(reply, status, issued.error, message);
    }
    const invitation = await deliverInvitation(sql, mailer, issued);
    // Never the code or the address: the facility, the person and what the provider said.
    request.log.info({ facilityId: who.identity.facilityId, staffId: target.id, invitationId: invitation.id, delivery: invitation.delivery }, 'staff invitation sent');
    return reply.code(201).send({ invitation });
  });

  app.post<{ Params: { staffId: string } }>('/staff/:staffId/invitations/revoke', async (request, reply) => {
    const who = await provenManager(request, reply); if (!who) return;
    const target = await findStaffInFacility(sql, who.identity.facilityId, request.params.staffId);
    if (!target) return refuse(reply, 404, 'unknown_staff', 'No member of staff with that id at this facility');
    if (!mayApprovePin(who.actor, target)) return refuse(reply, 403, 'forbidden', 'You cannot manage access for someone with access you do not hold');
    const revoked = await revokeStaffInvitation(sql, { facilityId: who.identity.facilityId, staffId: target.id, revokedBy: who.actor.id, deviceId: who.identity.deviceId });
    if (!revoked) return refuse(reply, 404, 'no_open_invitation', 'There is no invitation waiting to be accepted');
    return { revoked: true };
  });

  /** One person's contacts, invitation and activation, for their profile. */
  app.post<{ Params: { staffId: string } }>('/staff/:staffId/contact-activation', async (request, reply) => {
    const who = await provenManager(request, reply); if (!who) return;
    const target = await findStaffInFacility(sql, who.identity.facilityId, request.params.staffId);
    if (!target) return refuse(reply, 404, 'unknown_staff', 'No member of staff with that id at this facility');
    return contactActivation(sql, who.identity.facilityId, target.id);
  });

  /** Invitation and activation state for everyone at the facility who has any, for the Staff directory. */
  app.post('/staff/invitations/list', async (request, reply) => {
    const who = await provenManager(request, reply); if (!who) return;
    return { staff: await onboardingSummaries(sql, who.identity.facilityId) };
  });

  /**
   * Checks an invitation code before the person chooses a PIN, so a mistyped
   * code is caught first. The person has no PIN or session yet: the code is the
   * proof, each wrong one counts against the invitation, and nothing is spent.
   */
  app.post<{ Params: { staffId: string } }>('/staff/:staffId/invitations/check', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply); if (!identity) return;
    const body = z.strictObject({ code: z.string().trim().min(1).max(32) }).safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request', 'Enter the code from your invitation');
    const target = await findStaffInFacility(sql, identity.facilityId, request.params.staffId);
    if (!target?.active || !(await matchInvitationCode(sql, identity.facilityId, target.id, body.data.code))) {
      return refuse(reply, 403, 'invalid_setup_code', 'That code is not right, has expired or was withdrawn. Ask your administrator to send a new one');
    }
    return reply.code(204).send();
  });
};
