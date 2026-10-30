import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  Device, OrganizationFacilityRegistration, OrganizationFacilityOpen, OrganizationFacilityResult,
  SCHEMA_VERSION, staffPermissions, type OrganizationFacilityDirectory, type Staff,
} from '#shared';
import type { Sql } from '../db/client.ts';
import { findRecord, insertRecord } from '../db/records.ts';
import { createFacilityRecords, facilityRegistrationConflict } from '../facilities/registration.ts';
import { findStaffEmail } from '../email/verifications.ts';
import { maskEmail } from '../lib/email.ts';
import { issueCredential, verifyCredential } from '../devices/credentials.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { authorizeFacilityMember, authorizeOrganizationAdmin, isFacilityAdministrator } from '../organizations/access.ts';

class FacilitySetupError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) { super(message); this.statusCode = statusCode; this.code = code; }
}
const refuse = (code: string, message: string, status = 409): never => { throw new FacilitySetupError(status, code, message); };

export const registerOrganizationFacilityRoutes = (app: FastifyInstance, sql: Sql, syncEndpoint: string) => {
  app.post('/organization/facilities/list', async (request, reply) => {
    const identity = await authorizeFacilityMember(sql, request, reply); if (!identity) return;
    const [organization] = await sql<{ id: string; name: string }[]>`SELECT o.id,o.name FROM organizations o JOIN organization_facilities l ON l.organization_id=o.id WHERE l.facility_id=${identity.facilityId}`;
    const facilities = organization
      ? await sql<{ id: string; name: string }[]>`SELECT f.id,f.name FROM facilities f JOIN organization_facilities l ON l.facility_id=f.id WHERE l.organization_id=${organization.id} ORDER BY lower(f.name),f.id`
      : await sql<{ id: string; name: string }[]>`SELECT id,name FROM facilities WHERE id=${identity.facilityId}`;
    const members = await sql<{ id: string }[]>`SELECT id FROM staff WHERE active AND (person_id=${identity.staff.personId ?? ''} OR (facility_id=${identity.facilityId} AND id=${identity.staffId}))`;
    const memberships = await Promise.all(members.map((member) => findRecord<Staff>(sql, 'staff', member.id)));
    return {
      organization: organization ?? null,
      canCreateFacility: isFacilityAdministrator(identity.staff),
      facilities: facilities.map((facility) => {
        const member = memberships.find((candidate) => candidate?.facilityId === facility.id);
        return { ...facility, accessible: Boolean(member), canEnrollDevice: Boolean(member && staffPermissions(member).includes('device:enroll')) };
      }),
    } satisfies OrganizationFacilityDirectory;
  });

  app.post('/organization/facilities/defaults', async (request, reply) => {
    const identity = await authorizeOrganizationAdmin(sql, request, reply); if (!identity) return;
    const [organization] = await sql`SELECT o.id,o.name FROM organizations o JOIN organization_facilities l ON l.organization_id=o.id WHERE l.facility_id=${identity.facilityId}`;
    const email = await findStaffEmail(sql, identity.facilityId, identity.staffId);
    return { organization: organization ?? null, administrator: { staffId: identity.staffId, fullName: identity.staff.fullName, verifiedEmail: email ? maskEmail(email) : null } };
  });

  app.post('/organization/facilities', async (request, reply) => {
    const identity = await authorizeOrganizationAdmin(sql, request, reply); if (!identity) return;
    const parsed = OrganizationFacilityRegistration.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_registration', message: 'Check the new facility details', issues: parsed.error.issues });
    const input = parsed.data;
    const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    try {
      const result = await sql.begin(async (tx) => {
        // Serializes retries and first-time organization creation for this source facility.
        await tx`SELECT id FROM facilities WHERE id=${identity.facilityId} FOR UPDATE`;
        await tx`SELECT id FROM staff WHERE facility_id=${identity.facilityId} AND id=${identity.staffId} FOR UPDATE`;
        const source = await findRecord<Staff>(tx, 'staff', identity.staffId);
        if (!source?.active || !isFacilityAdministrator(source)) refuse('forbidden', 'An active facility administrator is required', 403);
        const [receipt] = await tx`SELECT * FROM organization_facility_creations WHERE source_facility_id=${identity.facilityId} AND actor_staff_id=${identity.staffId} AND request_id=${input.requestId}`;
        if (receipt) {
          if (receipt.payload_hash !== payloadHash) refuse('request_changed', 'This creation request was already used with different details');
          const credential = `${input.deviceId}.${input.deviceSecret}`;
          if ('failure' in await verifyCredential(tx, credential)) refuse('enrollment_unavailable', 'This facility was created, but its device enrollment is no longer active. Enroll it again from that facility.');
          const facility = await findRecord(tx, 'facility', receipt.target_facility_id);
          const admin = await findRecord<Staff>(tx, 'staff', receipt.target_staff_id);
          const [organization] = await tx`SELECT o.id,o.name FROM organizations o JOIN organization_facilities l ON l.organization_id=o.id WHERE l.facility_id=${receipt.target_facility_id}`;
          return OrganizationFacilityResult.parse({ facility, admin, organization, device: { deviceId: input.deviceId, facilityId: receipt.target_facility_id, credential, syncEndpoint } });
        }
        const email = await findStaffEmail(tx, identity.facilityId, identity.staffId);
        if (!email) refuse('verified_email_required', 'Verify your administrator recovery email in Administration before adding a facility', 403);
        let [organization] = await tx`SELECT o.id,o.name FROM organizations o JOIN organization_facilities l ON l.organization_id=o.id WHERE l.facility_id=${identity.facilityId}`;
        if ((organization?.id ?? undefined) !== input.organizationId) refuse('organization_changed', 'The organization changed. Reload this form before creating the facility.');
        if (!organization) {
          const id = `organization:${randomUUID()}`;
          [organization] = await tx`INSERT INTO organizations(id,name) VALUES(${id},${input.organizationName!}) RETURNING id,name`;
          await tx`INSERT INTO organization_facilities(facility_id,organization_id,joined_by) VALUES(${identity.facilityId},${id},${identity.staffId})`;
          await recordAuditEvent(tx, { ...identity, actorStaffId: identity.staffId, action: 'create', entityId: id, metadata: { workflow: 'organization_create_with_facility' } });
        }
        const personId = source!.personId ?? `person:${randomUUID()}`;
        if (!source!.personId) await tx`UPDATE staff SET person_id=${personId} WHERE facility_id=${identity.facilityId} AND id=${identity.staffId}`;
        const created = await createFacilityRecords(tx, { ...input, adminFullName: source!.fullName, adminEmail: email! }, syncEndpoint, personId, input.deviceSecret);
        await tx`INSERT INTO organization_facilities(facility_id,organization_id,joined_by) VALUES(${created.facility.id},${organization.id},${created.admin.id})`;
        await tx`INSERT INTO organization_facility_creations(source_facility_id,actor_staff_id,request_id,payload_hash,target_facility_id,target_staff_id,device_id) VALUES(${identity.facilityId},${identity.staffId},${input.requestId},${payloadHash},${created.facility.id},${created.admin.id},${input.deviceId})`;
        await recordAuditEvent(tx, { ...identity, actorStaffId: identity.staffId, action: 'create', entityId: created.facility.id, metadata: { workflow: 'organization_facility_create', organizationId: organization.id } });
        return OrganizationFacilityResult.parse({ ...created, facility: await findRecord(tx, 'facility', created.facility.id), admin: await findRecord<Staff>(tx, 'staff', created.admin.id), organization });
      });
      return reply.code(201).send(result);
    } catch (cause) {
      const conflict = facilityRegistrationConflict(cause);
      if (conflict) return reply.code(409).send({ error: conflict, message: conflict === 'facility_code_taken' ? `Facility code ${input.code} is already registered` : 'This enrollment already belongs to another facility' });
      throw cause;
    }
  });

  app.post('/organization/facilities/open', async (request, reply) => {
    const identity = await authorizeFacilityMember(sql, request, reply); if (!identity) return;
    const parsed = OrganizationFacilityOpen.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Choose a facility to open' });
    const input = parsed.data;
    return sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`organization-device:${input.deviceId}`}))`;
      await tx`SELECT id FROM staff WHERE facility_id=${identity.facilityId} AND id=${identity.staffId} FOR SHARE`;
      const source = await findRecord<Staff>(tx, 'staff', identity.staffId);
      if (!source?.active || !source.personId) refuse('not_provisioned', 'Your account has not been provisioned at that facility', 403);
      const [linked] = await tx`SELECT a.organization_id FROM organization_facilities a JOIN organization_facilities b ON b.organization_id=a.organization_id WHERE a.facility_id=${identity.facilityId} AND b.facility_id=${input.facilityId}`;
      if (!linked) refuse('forbidden', 'This facility does not belong to the same organization', 403);
      const [membership] = await tx`SELECT id FROM staff WHERE facility_id=${input.facilityId} AND person_id=${source!.personId!} AND active FOR SHARE`;
      if (!membership) refuse('not_provisioned', 'Your account has not been provisioned at that facility', 403);
      const staff = (await findRecord<Staff>(tx, 'staff', membership!.id))!;
      const [existing] = await tx`SELECT facility_id,status,wipe_requested FROM devices WHERE id=${input.deviceId} FOR UPDATE`;
      let credential: string | undefined;
      if (existing) {
        if (existing.facility_id !== input.facilityId || existing.status !== 'active' || existing.wipe_requested) refuse('enrollment_unavailable', 'The selected facility enrollment is unavailable', 403);
        if (input.deviceSecret) {
          credential = `${input.deviceId}.${input.deviceSecret}`;
          if ('failure' in await verifyCredential(tx, credential)) refuse('enrollment_unavailable', 'The selected enrollment cannot be recovered', 403);
        }
      } else {
        if (!staffPermissions(staff).includes('device:enroll')) refuse('device_approval_required', 'An administrator at that facility must enroll this device before you can open it', 403);
        if (!input.deviceSecret) refuse('invalid_request', 'A new enrollment needs an enrollment proof', 400);
        const now = new Date().toISOString();
        const device = Device.parse({ id: input.deviceId, type: 'device', facilityId: input.facilityId, deviceId: input.deviceId, schemaVersion: SCHEMA_VERSION, createdBy: staff.id, createdOn: now, enrolledBy: staff.id, status: 'active', wipeRequested: false, enrolledOn: now, label: 'Organization facility workspace' });
        await insertRecord(tx, 'device', device);
        credential = await issueCredential(tx, device.id, input.deviceSecret);
        await recordAuditEvent(tx, { facilityId: input.facilityId, deviceId: device.id, actorStaffId: staff.id, action: 'enroll', entityType: 'device', entityId: device.id });
      }
      return { facilityId: input.facilityId, staffId: staff.id, personId: staff.personId!, ...(credential ? { device: { deviceId: input.deviceId, facilityId: input.facilityId, credential, syncEndpoint } } : {}) };
    });
  });
};
