import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { patientId } from '#shared';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { authorizeStaff } from '../auth/staffAuthorization.ts';
import type { Sql } from '../db/client.ts';
import { confirmIdentity, previewIdentity } from '../patients/identity.ts';

const Action = z.object({ actorStaffId: z.string().min(1), patientId, otherPatientId: patientId, outcome: z.enum(['linked', 'distinct', 'unlinked']) });
const Confirm = Action.extend({ reason: z.string().trim().min(3).max(1000), revision: z.string().regex(/^[a-f0-9]{64}$/), requestId: z.string().uuid() });

export const registerPatientRoutes = (app: FastifyInstance, sql: Sql) => {
  const authorise = async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;
    const result = Action.safeParse(request.body);
    if (!result.success) { reply.code(400).send({ error: 'invalid_request', message: 'Select two patient records and an identity decision' }); return; }
    if ('denial' in await authorizeStaff(sql, identity.facilityId, result.data.actorStaffId, 'patient_identity:resolve')) { reply.code(403).send({ error: 'forbidden', message: 'Your account cannot resolve patient identities' }); return; }
    return { ...identity, actorStaffId: result.data.actorStaffId, action: result.data };
  };
  app.post('/patients/identity/preview', async (request, reply) => {
    const who = await authorise(request, reply); if (!who) return;
    const { patientId: id, otherPatientId, outcome } = who.action;
    return previewIdentity(sql, who.facilityId, { patientId: id, otherPatientId, outcome });
  });
  app.post('/patients/identity/confirm', async (request, reply) => {
    const who = await authorise(request, reply); if (!who) return;
    const body = Confirm.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Provide a reason and review a current preview before confirming' });
    return confirmIdentity(sql, who, body.data);
  });
};
