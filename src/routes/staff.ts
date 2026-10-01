import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  PinSetupCodeRequest,
  StaffEmailConfirmation,
  StaffEmailRequest,
  type ApiErrorBody,
  type EmailSent,
  type PinSetupCodeIssued,
} from '#shared';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { authenticateDevice } from '../auth/deviceAuth.ts';
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

/**
 * Staff access that has to be decided online. Every route is called from an
 * enrolled device, and the facility comes from its credential, so a member of
 * staff of another facility is simply not found.
 *
 * - Issuing a PIN setup code for someone: an admin the server can see holds
 *   `staff:manage`.
 * - A facility admin's recovery email, and a PIN setup code sent to it: the
 *   server knows the device, not who is holding it, so what protects these is
 *   the inbox — a code is only ever emailed to the admin's own address.
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
    return staff?.active && staff.role === 'facility_admin' ? staff : undefined;
  };

  app.post<{ Params: { staffId: string } }>('/staff/:staffId/pin-codes', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;

    const parsed = PinSetupCodeRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'issuedBy is required', issues: parsed.error.issues } satisfies ApiErrorBody);
    }

    const authorized = await authorizeStaff(sql, identity.facilityId, parsed.data.issuedBy, 'staff:manage');
    if ('denial' in authorized) {
      request.log.warn({ deviceId: identity.deviceId, denial: authorized.denial }, 'PIN setup code refused');
      return reply.code(403).send({ error: 'forbidden', message: describeDenial(authorized.denial) } satisfies ApiErrorBody);
    }

    const outcome = await issuePinSetupCode(sql, {
      facilityId: identity.facilityId,
      staffId: request.params.staffId,
      issuedBy: parsed.data.issuedBy,
      issuedFrom: identity.deviceId,
    });
    if (!outcome.ok) {
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
    if (requestedBy !== request.params.staffId || !(await findAdmin(identity.facilityId, requestedBy))) {
      return refuse(reply, 403, 'forbidden', 'A facility admin can set only their own recovery email');
    }

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
    if (requestedBy !== request.params.staffId || !(await findAdmin(identity.facilityId, requestedBy))) {
      return refuse(reply, 403, 'forbidden', 'A facility admin can set only their own recovery email');
    }

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
};
