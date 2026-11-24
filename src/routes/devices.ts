import type { FastifyInstance } from 'fastify';
import { DeviceRevocationRequest, type ApiErrorBody } from '#shared';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { authorizeStaff, describeDenial } from '../auth/staffAuthorization.ts';
import type { Sql } from '../db/client.ts';
import { revokeDevice } from '../devices/enrollment.ts';

/**
 * De-enrollment (root §4.3c), from an enrolled device by a staff member the
 * server can see holds the permission. Devices are enrolled by a person
 * signing in with their password and an emailed code (routes/staffPasswords.ts),
 * by an invitation link, or by registering a facility.
 */
const forbidden = (message: string): ApiErrorBody => ({ error: 'forbidden', message });

export const registerDeviceRoutes = (app: FastifyInstance, sql: Sql) => {
  app.post<{ Params: { id: string } }>('/devices/:id/revoke', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);

    if (!identity) {
      return;
    }

    const parsed = DeviceRevocationRequest.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'revokedBy is required',
        issues: parsed.error.issues,
      } satisfies ApiErrorBody);
    }

    const authorized = await authorizeStaff(
      sql,
      identity.facilityId,
      parsed.data.revokedBy,
      'device:revoke',
    );

    if ('denial' in authorized) {
      request.log.warn(
        { deviceId: identity.deviceId, denial: authorized.denial },
        'revocation refused',
      );

      return reply.code(403).send(forbidden(describeDenial(authorized.denial)));
    }

    // Work a device has not sent is lost when it is revoked. Its last report says how much;
    // the administrator must accept that loss explicitly, and it is audited either way.
    const [reported] = await sql<{ pending_mutation_count: number; recorded_on: string }[]>`
      SELECT v.pending_mutation_count, v.recorded_on FROM workforce_client_versions v JOIN devices d ON d.id = v.device_id
      WHERE d.facility_id = ${identity.facilityId} AND d.id = ${request.params.id}`;

    const unsent = reported?.pending_mutation_count ?? 0;

    if (unsent > 0 && parsed.data.acceptUnsentWork !== true) {
      return reply.code(409).send({
        error: 'unsent_work',
        message: `This device last reported ${unsent} change${unsent === 1 ? '' : 's'} it had not sent. Ask its user to connect and sync first; revoking now means that work never arrives.`,
        details: {
          unsentChanges: unsent,
          lastReportedOn: new Date(reported.recorded_on).toISOString(),
        },
      });
    }

    // The facility comes from the credential, so a device of another facility
    // is simply not found — never revealed.
    const outcome = await revokeDevice(
      sql,
      identity.facilityId,
      request.params.id,
      parsed.data.revokedBy,
      identity.deviceId,
      parsed.data.wipe,
      unsent,
    );

    if (!outcome.ok) {
      return reply.code(404).send({
        error: 'unknown_device',
        message: 'No such device at this facility',
      } satisfies ApiErrorBody);
    }

    request.log.info(
      { facilityId: identity.facilityId, revoked: request.params.id, wipe: parsed.data.wipe },
      'device revoked',
    );

    return outcome.device;
  });
};
