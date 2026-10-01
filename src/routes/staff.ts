import type { FastifyInstance } from 'fastify';
import { PinSetupCodeRequest, type ApiErrorBody, type PinSetupCodeIssued } from '#shared';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { authorizeStaff, describeDenial } from '../auth/staffAuthorization.ts';
import type { Sql } from '../db/client.ts';
import { issuePinSetupCode } from '../staff/pinSetupCodes.ts';

/**
 * Staff access that has to be decided online. Issuing a PIN setup code is
 * done from an enrolled device by an admin the server can see holds
 * `staff:manage`; the facility comes from the device's credential, so a staff
 * member of another facility is simply not found.
 */
export const registerStaffRoutes = (app: FastifyInstance, sql: Sql) => {
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
};
