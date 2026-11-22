import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApiErrorBody } from '#shared';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import type { Sql } from '../db/client.ts';
import type { Config } from '../lib/config.ts';
import {
  enrolDeviceFromInvitation,
  invitationLinkCode,
  openInvitationLink,
} from '../staff/invitations.ts';

const refuse = (reply: FastifyReply, status: number, error: string, message: string) =>
  reply.code(status).send({ error, message } satisfies ApiErrorBody);
const Token = z.string().trim().min(20).max(200);
const INVALID =
  'This invitation link is not valid. It may have expired, been used or been replaced by a newer one. Ask your administrator to send a new invitation';

/**
 * Invitation links (SCHEMA.md §10). Three steps, each only as trusted as what it proves:
 * - open: the token alone. Shows who the invitation is for and what it can still do; spends nothing.
 * - device: the token alone, and only while the invitation allows one new device. Enrols this device.
 * - code: the token and a device enrolled at the same facility. Returns a fresh one-time PIN setup code.
 * The PIN itself is then registered through POST /staff/session/enrol, as for any setup code.
 * Logs carry the invitation and facility, never the token or a code.
 */
export const registerInvitationLinkRoutes = (app: FastifyInstance, sql: Sql, config: Config) => {
  app.post('/invitations/link/open', async (request, reply) => {
    const body = z.strictObject({ token: Token }).safeParse(request.body);
    if (!body.success) {
      return refuse(
        reply,
        400,
        'invalid_request',
        'The invitation link is incomplete. Open it again from the email',
      );
    }
    const view = await openInvitationLink(sql, body.data.token);
    if (!view) {
      return refuse(reply, 404, 'invalid_invitation', INVALID);
    }
    return view;
  });

  app.post('/invitations/link/device', async (request, reply) => {
    const body = z
      .strictObject({
        token: Token,
        deviceId: z.string().min(1).max(200),
        deviceLabel: z.string().trim().min(1).max(80),
      })
      .safeParse(request.body);
    if (!body.success) {
      return refuse(
        reply,
        400,
        'invalid_request',
        'Give this device a name, such as "Ward 2 phone"',
      );
    }
    const outcome = await enrolDeviceFromInvitation(sql, body.data, config.powerSyncPublicUrl);
    if (!outcome.ok) {
      if (outcome.error === 'invalid_invitation') {
        return refuse(reply, 404, outcome.error, INVALID);
      }
      if (outcome.error === 'device_not_allowed') {
        return refuse(
          reply,
          403,
          outcome.error,
          "This invitation cannot set up a new device. Open it on one of the facility's devices, or ask your administrator to add this device",
        );
      }
      return refuse(
        reply,
        409,
        outcome.error,
        'This device is already enrolled. Open the link again to continue',
      );
    }
    request.log.info(
      { facilityId: outcome.credential.facilityId, deviceId: outcome.credential.deviceId },
      'device enrolled from invitation',
    );
    return reply.code(201).send(outcome.credential);
  });

  app.post('/invitations/link/code', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) {
      return;
    }
    const body = z.strictObject({ token: Token }).safeParse(request.body);
    if (!body.success) {
      return refuse(
        reply,
        400,
        'invalid_request',
        'The invitation link is incomplete. Open it again from the email',
      );
    }
    const outcome = await invitationLinkCode(sql, identity, body.data.token);
    if (!outcome.ok) {
      if (outcome.error === 'other_facility') {
        return refuse(
          reply,
          403,
          outcome.error,
          "This invitation is for another facility. Open it on one of that facility's devices",
        );
      }
      return refuse(reply, 404, outcome.error, INVALID);
    }
    request.log.info(
      { facilityId: identity.facilityId, staffId: outcome.staffId },
      'invitation link opened on a facility device',
    );
    return { staffId: outcome.staffId, code: outcome.code };
  });
};
