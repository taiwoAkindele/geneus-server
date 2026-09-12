import type { FastifyInstance } from 'fastify';
import { FacilityRegistration, type ApiErrorBody } from '#shared';
import type { Sql } from '../db/client.ts';
import type { Config } from '../lib/config.ts';
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

export const registerFacilityRoutes = (app: FastifyInstance, sql: Sql, config: Config) => {
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
