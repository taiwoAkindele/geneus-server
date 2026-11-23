import {
  DevicePasswordSignIn,
  emailCode,
  staffPassword,
  DevicePasswordSignInConfirm,
  StaffPasswordChange,
  StaffPasswordReset,
  StaffPasswordResetRequest,
  StaffPasswordSignIn,
  type ApiErrorBody,
} from '#shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodError } from 'zod';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { beginDeviceSignIn, confirmDeviceSignIn } from '../auth/deviceSignIn.ts';
import {
  checkPassword,
  endAccessForEmail,
  hashNewPassword,
  hasPassword,
  savePassword,
  staffWithEmail,
} from '../auth/staffPasswords.ts';
import {
  StaffSessionRefusal,
  sessionStaff,
  signInWithPassword,
  verifiedRequestStaff,
} from '../auth/staffSessions.ts';
import type { Sql } from '../db/client.ts';
import {
  checkVerificationCode,
  consumeVerification,
  createVerificationCode,
  findStaffEmail,
  verificationEmail,
} from '../email/verifications.ts';
import { maskEmail, type Mailer } from '../lib/email.ts';

const refuse = (
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
  details?: unknown,
) =>
  reply.code(status).send({
    error,
    message,
    ...(details ? { details } : {}),
  } satisfies ApiErrorBody & { details?: unknown });

const NO_EMAIL = 'Your account has no email yet. Ask your administrator to add one';

/** A first password, with the code emailed to the signed-in person. */
const FirstPassword = z.strictObject({ code: emailCode, password: staffPassword });

/** The first problem with a request body, worded for the person who typed it. */
const badRequest = (reply: FastifyReply, error: ZodError) =>
  refuse(reply, 400, 'invalid_request', error.issues[0]?.message ?? 'Check the form');

/**
 * Staff passwords (SCHEMA.md §10). Signing in, resetting and changing need an
 * enrolled device. The two new-device routes are the exception: they are how a
 * device enrolled nowhere gets enrolled, with the password and an emailed code.
 */
export const registerStaffPasswordRoutes = (
  app: FastifyInstance,
  sql: Sql,
  mailer: Mailer,
  syncEndpoint: string,
) => {
  const refused = (reply: FastifyReply, cause: unknown) => {
    if (cause instanceof StaffSessionRefusal) {
      const status = cause.code === 'device_already_enrolled' ? 409 : 403;

      return refuse(reply, status, cause.code, cause.message, cause.details);
    }

    throw cause;
  };

  app.post('/devices/password-sign-in', async (request, reply) => {
    const parsed = DevicePasswordSignIn.safeParse(request.body);

    if (!parsed.success) {
      return badRequest(reply, parsed.error);
    }

    if (!mailer.configured) {
      return refuse(
        reply,
        503,
        'email_not_configured',
        'Email delivery is not configured for this deployment',
      );
    }

    try {
      return reply.code(202).send(await beginDeviceSignIn(sql, mailer, parsed.data));
    } catch (cause) {
      return refused(reply, cause);
    }
  });

  app.post('/devices/password-sign-in/confirm', async (request, reply) => {
    const parsed = DevicePasswordSignInConfirm.safeParse(request.body);

    if (!parsed.success) {
      return badRequest(reply, parsed.error);
    }

    try {
      return reply.code(201).send(await confirmDeviceSignIn(sql, syncEndpoint, parsed.data));
    } catch (cause) {
      return refused(reply, cause);
    }
  });

  app.post('/staff/password/sign-in', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);

    if (!identity) {
      return;
    }

    const parsed = StaffPasswordSignIn.safeParse(request.body);

    if (!parsed.success) {
      return badRequest(reply, parsed.error);
    }

    const body = parsed.data;

    try {
      const session = await signInWithPassword(sql, identity, body);

      await recordAuditEvent(sql, {
        facilityId: identity.facilityId,
        deviceId: identity.deviceId,
        actorStaffId: session.staffId,
        action: 'login',
        metadata: { context: 'staff_password_sign_in' },
      });

      return session;
    } catch (cause) {
      return refused(reply, cause);
    }
  });

  /**
   * Emails a reset code when the address belongs to someone active at this
   * facility. The answer is the same either way, so it cannot be used to find
   * out who works here.
   */
  app.post('/staff/password/reset/request', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);

    if (!identity) {
      return;
    }

    const parsed = StaffPasswordResetRequest.safeParse(request.body);

    if (!parsed.success) {
      return badRequest(reply, parsed.error);
    }

    if (!mailer.configured) {
      return refuse(
        reply,
        503,
        'email_not_configured',
        'Email delivery is not configured for this deployment',
      );
    }

    const { email } = parsed.data;

    if (await staffWithEmail(sql, identity.facilityId, email)) {
      const fresh = await createVerificationCode(sql, {
        purpose: 'staff_password',
        subject: email,
        email,
      });

      await mailer.send({ to: email, ...verificationEmail(fresh.code, 'staff_password') });
    }

    return reply.code(202).send({ sentTo: maskEmail(email) });
  });

  /** Sets a new password with the emailed code, then signs that email out everywhere. */
  app.post('/staff/password/reset', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);

    if (!identity) {
      return;
    }

    const parsed = StaffPasswordReset.safeParse(request.body);

    if (!parsed.success) {
      return badRequest(reply, parsed.error);
    }

    const body = parsed.data;

    const verificationId = await checkVerificationCode(sql, {
      purpose: 'staff_password',
      subject: body.email,
      email: body.email,
      code: body.code,
    });

    if (!verificationId) {
      return refuse(reply, 403, 'invalid_code', 'The code is not right, or has expired');
    }

    const password = await hashNewPassword(body.password);

    const reset = await sql.begin(async (tx) => {
      if (!(await consumeVerification(tx, verificationId))) {
        return false;
      }

      await savePassword(tx, body.email, password, 'reset');
      await endAccessForEmail(tx, body.email);

      const staffId = await staffWithEmail(tx, identity.facilityId, body.email);

      await recordAuditEvent(tx, {
        facilityId: identity.facilityId,
        deviceId: identity.deviceId,
        actorStaffId: staffId,
        action: 'update',
        metadata: { context: 'staff_password_reset', email: maskEmail(body.email) },
      });

      return true;
    });

    if (!reset) {
      return refuse(reply, 403, 'invalid_code', 'The code is not right, or has expired');
    }

    return reply.code(204).send();
  });

  /** Changes the password of the person signed in on this device; the current password proves it is them. */
  app.post('/staff/password/change', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);

    if (!identity) {
      return;
    }

    const parsed = StaffPasswordChange.safeParse(request.body);

    if (!parsed.success) {
      return badRequest(reply, parsed.error);
    }

    const body = parsed.data;
    const token = request.headers['x-staff-session'];
    const staff = await sessionStaff(sql, identity, typeof token === 'string' ? token : undefined);

    if (!staff) {
      return refuse(reply, 403, 'staff_session_required', 'Sign in again to change your password');
    }

    const email = (await findStaffEmail(sql, identity.facilityId, staff.id))?.toLowerCase();

    if (!email) {
      return refuse(
        reply,
        409,
        'no_email',
        'Your account has no email yet. Ask your administrator to add one',
      );
    }

    const check = await checkPassword(sql, email, body.currentPassword);

    if (!check.ok && check.reason === 'locked') {
      return refuse(reply, 403, 'locked', 'Too many wrong passwords. Try again later', {
        retryAt: check.retryAt,
      });
    }

    if (!check.ok) {
      return refuse(reply, 403, 'wrong_password', 'Your current password is not right');
    }

    await savePassword(sql, email, await hashNewPassword(body.password), 'change');

    await recordAuditEvent(sql, {
      facilityId: identity.facilityId,
      deviceId: identity.deviceId,
      actorStaffId: staff.id,
      action: 'update',
      metadata: { context: 'staff_password_changed' },
    });

    return reply.code(204).send();
  });

  /**
   * A first password for someone who signed in before passwords existed (or
   * the facility's first administrator). Their proven session says who they
   * are, and a code to their verified email proves the inbox. It never
   * replaces a password: a forgotten one is reset, which signs them out.
   */
  const signedInPerson = async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await authenticateDevice(sql, request, reply);

    if (!identity) {
      return undefined;
    }

    const staff = await verifiedRequestStaff(sql, identity, request.headers);

    if (!staff) {
      await refuse(reply, 403, 'staff_session_required', 'Confirm your PIN to continue');

      return undefined;
    }

    const email = (await findStaffEmail(sql, identity.facilityId, staff.id))?.toLowerCase();

    return { identity, staff, email };
  };

  const firstPasswordSubject = (facilityId: string, staffId: string) =>
    JSON.stringify(['first-password', facilityId, staffId]);

  app.post('/staff/me/password/status', async (request, reply) => {
    const person = await signedInPerson(request, reply);

    if (!person) {
      return;
    }

    return {
      email: person.email ? maskEmail(person.email) : null,
      hasPassword: person.email ? await hasPassword(sql, person.email) : false,
    };
  });

  app.post('/staff/me/password/code', async (request, reply) => {
    const person = await signedInPerson(request, reply);

    if (!person) {
      return;
    }

    if (!mailer.configured) {
      return refuse(
        reply,
        503,
        'email_not_configured',
        'Email delivery is not configured for this deployment',
      );
    }

    if (!person.email) {
      return refuse(reply, 409, 'no_email', NO_EMAIL);
    }

    if (await hasPassword(sql, person.email)) {
      return refuse(reply, 409, 'existing_account', 'You already have a password');
    }

    const fresh = await createVerificationCode(sql, {
      purpose: 'staff_password',
      subject: firstPasswordSubject(person.identity.facilityId, person.staff.id),
      email: person.email,
    });

    await mailer.send({ to: person.email, ...verificationEmail(fresh.code, 'staff_password') });

    return reply.code(202).send({ sentTo: maskEmail(person.email), expiresOn: fresh.expiresOn });
  });

  app.post('/staff/me/password', async (request, reply) => {
    const person = await signedInPerson(request, reply);

    if (!person) {
      return;
    }

    const parsed = FirstPassword.safeParse(request.body);

    if (!parsed.success) {
      return badRequest(reply, parsed.error);
    }

    const { email, identity, staff } = person;

    if (!email) {
      return refuse(reply, 409, 'no_email', NO_EMAIL);
    }

    const verificationId = await checkVerificationCode(sql, {
      purpose: 'staff_password',
      subject: firstPasswordSubject(identity.facilityId, staff.id),
      email,
      code: parsed.data.code,
    });

    if (!verificationId) {
      return refuse(reply, 403, 'invalid_code', 'The code is not right, or has expired');
    }

    const password = await hashNewPassword(parsed.data.password);

    const outcome = await sql.begin(async (tx) => {
      // Checked inside the write as well: a password set meanwhile is never replaced here.
      if (await hasPassword(tx, email)) {
        return 'existing_account' as const;
      }

      if (!(await consumeVerification(tx, verificationId))) {
        return 'invalid_code' as const;
      }

      await savePassword(tx, email, password, 'reset');

      await recordAuditEvent(tx, {
        facilityId: identity.facilityId,
        deviceId: identity.deviceId,
        actorStaffId: staff.id,
        action: 'update',
        metadata: { context: 'staff_password_first', email: maskEmail(email) },
      });

      return 'set' as const;
    });

    if (outcome === 'existing_account') {
      return refuse(reply, 409, 'existing_account', 'You already have a password');
    }

    if (outcome === 'invalid_code') {
      return refuse(reply, 403, 'invalid_code', 'The code is not right, or has expired');
    }

    return reply.code(204).send();
  });
};
