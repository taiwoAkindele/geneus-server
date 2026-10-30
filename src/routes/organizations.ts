import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { OrganizationActor, OrganizationCreate, OrganizationJoin, StaffProvisionAccept, StaffProvisionRequest, Staff, rolesFor } from '#shared';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { authorizeStaff } from '../auth/staffAuthorization.ts';
import type { Sql } from '../db/client.ts';
import { insertRecord } from '../db/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';

const digest = (code: string) => createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
const actor = async (sql: Sql, request: FastifyRequest, reply: FastifyReply) => {
  const identity = await authenticateDevice(sql, request, reply); if (!identity) return;
  const parsed = OrganizationActor.safeParse({ actorStaffId: (request.body as { actorStaffId?: unknown })?.actorStaffId });
  if (!parsed.success) { await reply.code(400).send({ error: 'invalid_request', message: 'An acting facility administrator is required' }); return; }
  const permission = await authorizeStaff(sql, identity.facilityId, parsed.data.actorStaffId, 'staff:manage');
  if ('denial' in permission || !rolesFor(permission.staff).includes('facility_admin')) { await reply.code(403).send({ error: 'forbidden', message: 'A local facility administrator must authorize this action' }); return; }
  return { ...identity, staffId: parsed.data.actorStaffId };
};
export const registerOrganizationRoutes = (app: FastifyInstance, sql: Sql) => {
  app.post('/facility/investigation-settings', async (request, reply) => {
    const identity = await actor(sql, request, reply); if (!identity) return;
    const parsed = z.object({ allowCustomInvestigations: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Choose whether unlisted requests are permitted' });
    await sql.begin(async (tx) => {
      await tx`UPDATE facilities SET allow_custom_investigations=${parsed.data.allowCustomInvestigations} WHERE id=${identity.facilityId}`;
      await recordAuditEvent(tx, { ...identity, actorStaffId: identity.staffId, action: 'update', entityType: 'facility', entityId: identity.facilityId, metadata: { workflow: 'investigation_settings' } });
    });
    return { updated: true };
  });
  app.post('/organization/current', async (request, reply) => {
    const identity = await actor(sql, request, reply); if (!identity) return;
    const [organization] = await sql`SELECT o.id,o.name FROM organizations o JOIN organization_facilities f ON f.organization_id=o.id WHERE f.facility_id=${identity.facilityId}`;
    reply.header('cache-control', 'no-store');
    if (!organization) return { organization: null, requests: [] };
    const facilities = await sql`SELECT f.id,f.name FROM facilities f JOIN organization_facilities l ON l.facility_id=f.id WHERE l.organization_id=${organization.id}`;
    const requests = await sql`SELECT id,from_facility_id AS "fromFacilityId",full_name AS "fullName",status FROM staff_provision_requests WHERE to_facility_id=${identity.facilityId} AND status='pending' ORDER BY created_on`;
    return { organization: { ...organization, facilities }, requests };
  });
  app.post('/organizations', async (request, reply) => {
    const identity = await actor(sql, request, reply); if (!identity) return;
    const parsed = OrganizationCreate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Provide the organization name' });
    return sql.begin(async (tx) => {
      await tx`SELECT id FROM facilities WHERE id=${identity.facilityId} FOR UPDATE`;
      const [existing] = await tx`SELECT 1 FROM organization_facilities WHERE facility_id=${identity.facilityId}`;
      if (existing) return reply.code(409).send({ error: 'already_linked', message: 'This facility already belongs to an organization' });
      const id = `organization:${randomUUID()}`;
      await tx`INSERT INTO organizations(id,name) VALUES(${id},${parsed.data.name})`;
      await tx`INSERT INTO organization_facilities(facility_id,organization_id,joined_by) VALUES(${identity.facilityId},${id},${identity.staffId})`;
      await recordAuditEvent(tx, { ...identity, actorStaffId: identity.staffId, action: 'create', entityId: id, metadata: { workflow: 'organization_link' } });
      return reply.code(201).send({ id, name: parsed.data.name });
    });
  });
  app.post('/organization/invitations', async (request, reply) => {
    const identity = await actor(sql, request, reply); if (!identity) return;
    const [membership] = await sql`SELECT organization_id FROM organization_facilities WHERE facility_id=${identity.facilityId}`;
    if (!membership) return reply.code(409).send({ error: 'not_linked', message: 'Create or join an organization first' });
    const code = randomBytes(12).toString('hex').toUpperCase(), expiresOn = new Date(Date.now() + 86400000).toISOString();
    await sql`INSERT INTO organization_invitations(code_hash,organization_id,issued_from,issued_by,expires_on) VALUES(${digest(code)},${membership.organization_id},${identity.facilityId},${identity.staffId},${expiresOn})`;
    return { code, expiresOn };
  });
  app.post('/organization/join', async (request, reply) => {
    const identity = await actor(sql, request, reply); if (!identity) return;
    const parsed = OrganizationJoin.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Provide an organization invitation code' });
    return sql.begin(async (tx) => {
      await tx`SELECT id FROM facilities WHERE id=${identity.facilityId} FOR UPDATE`;
      const [existing] = await tx`SELECT 1 FROM organization_facilities WHERE facility_id=${identity.facilityId}`;
      if (existing) return reply.code(409).send({ error: 'already_linked', message: 'This facility already belongs to an organization' });
      const [invite] = await tx`UPDATE organization_invitations SET claimed_by=${identity.facilityId},claimed_on=now() WHERE code_hash=${digest(parsed.data.code)} AND claimed_on IS NULL AND expires_on>now() AND issued_from<>${identity.facilityId} RETURNING organization_id`;
      if (!invite) return reply.code(403).send({ error: 'invalid_invitation', message: 'The invitation is invalid or expired' });
      await tx`INSERT INTO organization_facilities(facility_id,organization_id,joined_by) VALUES(${identity.facilityId},${invite.organization_id},${identity.staffId})`;
      await recordAuditEvent(tx, { ...identity, actorStaffId: identity.staffId, action: 'create', entityId: String(invite.organization_id), metadata: { workflow: 'organization_join' } });
      return { joined: true };
    });
  });
  app.post('/organization/staff-requests', async (request, reply) => {
    const identity = await actor(sql, request, reply); if (!identity) return;
    const parsed = StaffProvisionRequest.safeParse(request.body);
    if (!parsed.success || parsed.data.toFacilityId === identity.facilityId) return reply.code(400).send({ error: 'invalid_request', message: 'Choose a local staff member and another facility' });
    const input = parsed.data;
    return sql.begin(async (tx) => {
      const [sameOrganization] = await tx`SELECT a.organization_id FROM organization_facilities a JOIN organization_facilities b ON b.organization_id=a.organization_id WHERE a.facility_id=${identity.facilityId} AND b.facility_id=${input.toFacilityId}`;
      if (!sameOrganization) return reply.code(403).send({ error: 'forbidden', message: 'The receiving facility must belong to the same organization' });
      const [source] = await tx`SELECT id,full_name,person_id FROM staff WHERE facility_id=${identity.facilityId} AND id=${input.staffId} AND active FOR UPDATE`;
      if (!source) return reply.code(404).send({ error: 'not_found', message: 'The local staff member is unavailable' });
      const personId = source.person_id ?? `person:${randomUUID()}`;
      if (!source.person_id) await tx`UPDATE staff SET person_id=${personId} WHERE id=${source.id} AND facility_id=${identity.facilityId}`;
      const id = `provision:${randomUUID()}`;
      const rows = await tx`INSERT INTO staff_provision_requests(id,from_facility_id,to_facility_id,source_staff_id,person_id,full_name,requested_by) VALUES(${id},${identity.facilityId},${input.toFacilityId},${input.staffId},${personId},${source.full_name},${identity.staffId}) ON CONFLICT DO NOTHING RETURNING id`;
      if (!rows.length) return reply.code(409).send({ error: 'already_requested', message: 'A provisioning request is already pending' });
      await recordAuditEvent(tx, { ...identity, actorStaffId: identity.staffId, action: 'create', entityId: id, metadata: { workflow: 'staff_provision_request', destination: input.toFacilityId } });
      return reply.code(201).send({ id, status: 'pending' });
    });
  });
  app.post<{ Params: { id: string } }>('/organization/staff-requests/:id/accept', async (request, reply) => {
    const identity = await actor(sql, request, reply); if (!identity) return;
    const parsed = StaffProvisionAccept.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Choose the local role and access level' });
    return sql.begin(async (tx) => {
      await tx`SELECT id FROM facilities WHERE id=${identity.facilityId} FOR UPDATE`;
      const [provision] = await tx`SELECT * FROM staff_provision_requests WHERE id=${request.params.id} AND to_facility_id=${identity.facilityId} FOR UPDATE`;
      if (!provision) return reply.code(404).send({ error: 'not_found', message: 'No provisioning request for this facility' });
      if (provision.status === 'accepted') return { staffId: provision.local_staff_id };
      if (provision.status !== 'pending') return reply.code(409).send({ error: 'decided', message: 'This request is already decided' });
      const [sameOrganization] = await tx`SELECT 1 FROM organization_facilities a JOIN organization_facilities b ON a.organization_id=b.organization_id WHERE a.facility_id=${identity.facilityId} AND b.facility_id=${provision.from_facility_id}`;
      const [source] = await tx`SELECT 1 FROM staff WHERE facility_id=${provision.from_facility_id} AND id=${provision.source_staff_id} AND active`;
      if (!sameOrganization || !source) return reply.code(409).send({ error: 'unavailable', message: 'The source membership or organization relationship is no longer active' });
      const [existing] = await tx`SELECT id FROM staff WHERE facility_id=${identity.facilityId} AND person_id=${provision.person_id}`;
      if (existing) return reply.code(409).send({ error: 'already_member', message: 'This person already has a local staff membership' });
      const id = `staff:${randomUUID()}`, at = new Date().toISOString();
      const staff = Staff.parse({ id, staffId: id, type: 'staff', facilityId: identity.facilityId, deviceId: identity.deviceId, createdBy: identity.staffId, createdOn: at, schemaVersion: 4, fullName: provision.full_name, personId: provision.person_id, role: parsed.data.role, permission: parsed.data.permission, active: true, loginAccess: 'shift' });
      await insertRecord(tx, 'staff', staff);
      await tx`UPDATE staff_provision_requests SET status='accepted',local_staff_id=${id},decided_by=${identity.staffId},decided_on=now() WHERE id=${provision.id}`;
      await recordAuditEvent(tx, { ...identity, actorStaffId: identity.staffId, action: 'create', entityType: 'staff', entityId: id, metadata: { workflow: 'staff_provision_accept', requestId: String(provision.id) } });
      return reply.code(201).send({ staffId: id });
    });
  });
  app.post<{ Params: { id: string } }>('/organization/staff-requests/:id/reject', async (request, reply) => {
    const identity = await actor(sql, request, reply); if (!identity) return;
    const changed = await sql`UPDATE staff_provision_requests SET status='rejected',decided_by=${identity.staffId},decided_on=now() WHERE id=${request.params.id} AND to_facility_id=${identity.facilityId} AND status='pending' RETURNING id`;
    if (!changed.length) return reply.code(404).send({ error: 'not_found', message: 'No pending request for this facility' });
    return { rejected: true };
  });
};
