import type { FastifyInstance } from 'fastify';
import {
  DeviceEnrollmentRequest,
  DeviceRevocationRequest,
  EnrollmentCodeRequest,
  type ApiErrorBody,
  type EnrollmentCode,
} from '#shared';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { authorizeStaff, describeDenial } from '../auth/staffAuthorization.ts';
import type { Sql } from '../db/client.ts';
import { enrollDevice, issueEnrollmentCode, revokeDevice } from '../devices/enrollment.ts';
import type { Config } from '../lib/config.ts';

/**
 * Device enrollment and de-enrollment (root §4.3c). Issuing a code and
 * revoking a device are done from an enrolled device by a staff member the
 * server can see holds the permission; spending a code needs no credential —
 * the code is the credential, briefly.
 */
const forbidden = (message: string): ApiErrorBody => ({ error: 'forbidden', message });

export const registerDeviceRoutes = (app: FastifyInstance, sql: Sql, config: Config) => {
  app.post('/devices/codes', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;

    const parsed = EnrollmentCodeRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'issuedBy is required', issues: parsed.error.issues } satisfies ApiErrorBody);
    }

    const authorized = await authorizeStaff(sql, identity.facilityId, parsed.data.issuedBy, 'device:enroll');
    if ('denial' in authorized) {
      request.log.warn({ deviceId: identity.deviceId, denial: authorized.denial }, 'enrollment code refused');
      return reply.code(403).send(forbidden(describeDenial(authorized.denial)));
    }

    const code = await issueEnrollmentCode(sql, identity.facilityId, parsed.data.issuedBy, identity.deviceId);
    request.log.info({ facilityId: identity.facilityId, issuedBy: parsed.data.issuedBy }, 'enrollment code issued');
    const response: EnrollmentCode = { code: code.code, expiresOn: code.expiresOn };
    return reply.code(201).send(response);
  });

  app.post('/devices', async (request, reply) => {
    const parsed = DeviceEnrollmentRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'code and deviceId are required', issues: parsed.error.issues } satisfies ApiErrorBody);
    }

    const outcome = await enrollDevice(sql, parsed.data, config.powerSyncPublicUrl);
    if (!outcome.ok) {
      if (outcome.error === 'invalid_code') {
        return reply.code(403).send({ error: 'invalid_code', message: 'That enrollment code is not valid — ask for a new one' } satisfies ApiErrorBody);
      }
      return reply.code(409).send({ error: 'device_already_enrolled', message: 'This device is already enrolled with a facility' } satisfies ApiErrorBody);
    }

    request.log.info({ facilityId: outcome.device.facilityId, deviceId: outcome.device.id }, 'device enrolled');
    return reply.code(201).send(outcome.credential);
  });

  app.post<{ Params: { id: string } }>('/devices/:id/revoke', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;

    const parsed = DeviceRevocationRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'revokedBy is required', issues: parsed.error.issues } satisfies ApiErrorBody);
    }

    const authorized = await authorizeStaff(sql, identity.facilityId, parsed.data.revokedBy, 'device:revoke');
    if ('denial' in authorized) {
      request.log.warn({ deviceId: identity.deviceId, denial: authorized.denial }, 'revocation refused');
      return reply.code(403).send(forbidden(describeDenial(authorized.denial)));
    }

    // The facility comes from the credential, so a device of another facility
    // is simply not found — never revealed.
    const outcome = await revokeDevice(sql, identity.facilityId, request.params.id, parsed.data.revokedBy, identity.deviceId, parsed.data.wipe);
    if (!outcome.ok) {
      return reply.code(404).send({ error: 'unknown_device', message: 'No such device at this facility' } satisfies ApiErrorBody);
    }

    request.log.info({ facilityId: identity.facilityId, revoked: request.params.id, wipe: parsed.data.wipe }, 'device revoked');
    return outcome.device;
  });
};
