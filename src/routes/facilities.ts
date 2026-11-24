import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  FacilityRegistration,
  FacilitySignupRequest,
  RegistrationEmailRequest,
  facilityRegistrationToken,
  type ApiErrorBody,
  type EmailSent,
} from '#shared';
import type { Sql } from '../db/client.ts';
import type { Config } from '../lib/config.ts';
import { maskEmail, type Mailer } from '../lib/email.ts';
import {
  createVerificationCode,
  registrationSubject,
  verificationEmail,
} from '../email/verifications.ts';
import type { InviteRejection } from '../facilities/invites.ts';
import { registerFacility } from '../facilities/registration.ts';
import {
  notifyOperators,
  openRegistrationLink,
  submitSignupRequest,
} from '../facilities/signupRequests.ts';

const LINK_REJECTIONS: Record<InviteRejection, string> = {
  unknown: 'This registration link is not valid. Open it again from the approval email',
  expired: 'This registration link has expired. Ask Geneus to send a new one',
  already_used: 'This registration link has already been used. Sign in with your email instead',
};

const refuse = (reply: FastifyReply, status: number, error: string, message: string) =>
  reply.code(status).send({ error, message } satisfies ApiErrorBody);

const linkError = (reply: FastifyReply, status: number, rejection: InviteRejection) =>
  refuse(reply, status, 'invalid_invite', LINK_REJECTIONS[rejection]);

/**
 * Facility sign-up (SCHEMA.md §10): prove an email, ask Geneus for a facility,
 * and — once a Geneus operator approves it (facilitySignupReview.ts) — register
 * it from the emailed link. Every route here is reachable with no credential,
 * so each is rate-limited (app.ts).
 */
export const registerFacilityRoutes = (
  app: FastifyInstance,
  sql: Sql,
  config: Config,
  mailer: Mailer,
  appUrl: string,
) => {
  /** Proves the would-be admin's email before a request is sent to Geneus. */
  app.post('/email-verifications', async (request, reply) => {
    const parsed = RegistrationEmailRequest.safeParse(request.body);

    if (!parsed.success) {
      return refuse(reply, 400, 'invalid_request', 'Enter a valid email address');
    }

    const { code, expiresOn } = await createVerificationCode(sql, {
      purpose: 'registration',
      subject: registrationSubject(parsed.data.email),
      email: parsed.data.email,
    });

    await mailer.send({ to: parsed.data.email, ...verificationEmail(code, 'registration') });
    const response: EmailSent = { sentTo: maskEmail(parsed.data.email), expiresOn };

    return reply.code(202).send(response);
  });

  /** "Create an account": records the request and emails every Geneus operator. */
  app.post('/facility-requests', async (request, reply) => {
    const parsed = FacilitySignupRequest.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Fill in every detail of the facility and your email code',
        issues: parsed.error.issues,
      } satisfies ApiErrorBody);
    }

    const submission = await submitSignupRequest(sql, parsed.data);

    if (!submission.ok) {
      switch (submission.error) {
        case 'invalid_email_code':
          return refuse(
            reply,
            403,
            submission.error,
            'That email code is not right, or has expired — ask for a new one',
          );
        case 'facility_code_taken':
          return refuse(
            reply,
            409,
            submission.error,
            `Facility code ${parsed.data.code} is already registered. Choose another code`,
          );
        case 'already_requested':
          return refuse(
            reply,
            409,
            submission.error,
            'A request from this email is already waiting for Geneus. You will get an email when it is decided',
          );
      }
    }

    const notified = await notifyOperators(mailer, appUrl, submission);

    if (notified === 0) {
      request.log.warn(
        { operators: submission.reviewLinks.length },
        'facility request recorded, but no Geneus operator was emailed',
      );
    }

    return reply.code(201).send({ sentTo: maskEmail(parsed.data.adminEmail) });
  });

  /** What the registration link shows before anything is created. Spends nothing. */
  app.post('/facility-registration/open', async (request, reply) => {
    const parsed = z.strictObject({ token: facilityRegistrationToken }).safeParse(request.body);

    if (!parsed.success) {
      return linkError(reply, 400, 'unknown');
    }

    const outcome = await openRegistrationLink(sql, parsed.data.token);

    if (!outcome.ok) {
      return linkError(reply, 404, outcome.rejection);
    }

    return outcome.view;
  });

  /**
   * Registers the approved facility (PLAN.md §4.1a). The response carries the
   * registering device's credential — shown once, never a database credential —
   * and the first admin's session on it.
   */
  app.post('/facilities', async (request, reply) => {
    const parsed = FacilityRegistration.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_registration',
        message: 'The registration is incomplete or malformed',
        issues: parsed.error.issues,
      } satisfies ApiErrorBody);
    }

    const outcome = await registerFacility(sql, parsed.data, config.powerSyncPublicUrl);

    if (!outcome.ok) {
      switch (outcome.error) {
        case 'invalid_invite':
          return linkError(reply, 403, outcome.rejection);
        case 'invalid_password':
          return refuse(reply, 400, outcome.error, outcome.message);
        case 'wrong_password':
          return refuse(
            reply,
            403,
            outcome.error,
            'That is not the password of this email. Enter your Geneus password, or reset it from the sign-in screen',
          );
        case 'locked':
          return reply.code(429).send({
            error: outcome.error,
            message: 'Too many wrong passwords. Try again later',
            retryAt: outcome.retryAt,
          });
        case 'facility_code_taken':
          return refuse(
            reply,
            409,
            outcome.error,
            'This facility code was registered by someone else meanwhile. Contact Geneus',
          );
        case 'device_already_enrolled':
          return refuse(
            reply,
            409,
            outcome.error,
            'This device is already enrolled with a facility',
          );
      }
    }

    request.log.info(
      { facility: outcome.result.facility.id, device: outcome.result.device.deviceId },
      'facility registered',
    );

    return reply.code(201).send(outcome.result);
  });
};
