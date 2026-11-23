import {
  DevicePasswordSignIn,
  DevicePasswordSignInConfirm,
  StaffPasswordChange,
  StaffPasswordReset,
  StaffPasswordResetRequest,
  StaffPasswordSignIn,
  type ApiErrorBody,
} from '#shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodError } from 'zod';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { beginDeviceSignIn, confirmDeviceSignIn } from '../auth/deviceSignIn.ts';
import {
  checkPassword,
  endAccessForEmail,
  hashNewPassword,
  savePassword,
  staffWithEmail,
} from '../auth/staffPasswords.ts';
import { StaffSessionRefusal, sessionStaff, signInWithPassword } from '../auth/staffSessions.ts';
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
};
