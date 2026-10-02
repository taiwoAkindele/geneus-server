import type { FastifyInstance } from 'fastify';
import { FacilityRegistration, RegistrationEmailRequest, type ApiErrorBody, type EmailSent } from '#shared';
import type { Sql } from '../db/client.ts';
import type { Config } from '../lib/config.ts';
import { maskEmail, type Mailer } from '../lib/email.ts';
import { createVerificationCode, registrationSubject, verificationEmail } from '../email/verifications.ts';
import { findInvite, rejectionFor, type InviteRejection } from '../facilities/invites.ts';
import { registerFacility } from '../facilities/registration.ts';

const INVITE_REJECTIONS: Record<InviteRejection, string> = {
  unknown: 'That invite code is not recognised',
  expired: 'That invite code has expired',
  already_used: 'That invite code has already been used',
};

const inviteError = (rejection: InviteRejection): ApiErrorBody => ({
  error: 'invalid_invite',
  message: INVITE_REJECTIONS[rejection],
});

export const registerFacilityRoutes = (app: FastifyInstance, sql: Sql, config: Config, mailer: Mailer) => {
  /**
   * Proves the would-be admin's email before registration (SCHEMA.md §10). It
   * needs a valid invite, so it cannot be used to send mail to anyone; it is
   * rate-limited with the other routes reachable without a credential.
   */
  app.post('/email-verifications', async (request, reply) => {
    const parsed = RegistrationEmailRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'A valid email address and invite code are needed', issues: parsed.error.issues } satisfies ApiErrorBody);
    }
    const rejection = rejectionFor(await findInvite(sql, parsed.data.inviteToken));
    if (rejection) return reply.code(404).send(inviteError(rejection));

    const { code, expiresOn } = await createVerificationCode(sql, {
      purpose: 'registration',
      subject: registrationSubject(parsed.data.inviteToken),
      email: parsed.data.email,
    });
    await mailer.send({ to: parsed.data.email, ...verificationEmail(code, 'registration') });
    const response: EmailSent = { sentTo: maskEmail(parsed.data.email), expiresOn };
    return reply.code(202).send(response);
  });

  /** Lets the onboarding screen reject a bad code before asking for any details. */
  app.get<{ Params: { token: string } }>('/invites/:token', async (request, reply) => {
    const invite = await findInvite(sql, request.params.token);
    const rejection = rejectionFor(invite);
    if (rejection || !invite) return reply.code(404).send(inviteError(rejection ?? 'unknown'));
    return { label: invite.label, expiresOn: invite.expiresOn };
  });

  /**
   * The one bootstrap endpoint (PLAN.md §4.1a). The response carries the
   * registering device's credential — shown once, never a database credential.
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
          return reply.code(403).send(inviteError(outcome.rejection));
        case 'invalid_email_code':
          return reply.code(403).send({
            error: 'invalid_email_code',
            message: 'That email code is not right, or has expired — ask for a new one',
          } satisfies ApiErrorBody);
        case 'facility_code_taken':
          return reply.code(409).send({
            error: 'facility_code_taken',
            message: `Facility code ${parsed.data.code} is already registered`,
          } satisfies ApiErrorBody);
        case 'device_already_enrolled':
          return reply.code(409).send({
            error: 'device_already_enrolled',
            message: 'This device is already enrolled with a facility',
          } satisfies ApiErrorBody);
      }
    }

    request.log.info(
      { facility: outcome.result.facility.id, device: outcome.result.device.deviceId },
      'facility registered',
    );
    return reply.code(201).send(outcome.result);
  });
};
