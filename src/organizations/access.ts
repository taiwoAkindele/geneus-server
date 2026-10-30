import type { FastifyReply, FastifyRequest } from 'fastify';
import { OrganizationActor, rolesFor, staffPermissions, type Staff } from '#shared';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import type { Sql } from '../db/client.ts';
import { findRecord } from '../db/records.ts';

export const authorizeFacilityMember = async (sql: Sql, request: FastifyRequest, reply: FastifyReply) => {
  const identity = await authenticateDevice(sql, request, reply);
  if (!identity) return;
  const parsed = OrganizationActor.safeParse({ actorStaffId: (request.body as { actorStaffId?: unknown })?.actorStaffId });
  if (!parsed.success) { await reply.code(400).send({ error: 'invalid_request', message: 'An acting staff member is required' }); return; }
  const staff = await findRecord<Staff>(sql, 'staff', parsed.data.actorStaffId);
  if (!staff || staff.facilityId !== identity.facilityId || !staff.active) {
    await reply.code(403).send({ error: 'forbidden', message: 'An active local staff membership is required' }); return;
  }
  return { ...identity, staffId: staff.id, staff };
};

export const isFacilityAdministrator = (staff: Staff) =>
  staff.active && rolesFor(staff).includes('facility_admin') && staffPermissions(staff).includes('staff:manage');

export const authorizeOrganizationAdmin = async (sql: Sql, request: FastifyRequest, reply: FastifyReply) => {
  const identity = await authorizeFacilityMember(sql, request, reply);
  if (!identity) return;
  if (!isFacilityAdministrator(identity.staff)) {
    await reply.code(403).send({ error: 'forbidden', message: 'A local facility administrator must authorize this action' }); return;
  }
  return identity;
};
