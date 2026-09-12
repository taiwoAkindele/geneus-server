import { randomUUID } from 'node:crypto';
import {
  Device,
  Facility,
  SCHEMA_VERSION,
  Staff,
  type FacilityRegistration,
  type FacilityRegistrationResult,
} from '#shared';
import { isPostgresError, UNIQUE_VIOLATION, type Sql } from '../db/client.ts';
import { insertRecord } from '../db/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { issueCredential } from '../devices/credentials.ts';
import { claimInvite, findInvite, rejectionFor, type InviteRejection } from './invites.ts';

/**
 * Facility registration is the one thing a device cannot do for itself: no
 * facility exists yet and it holds no credential. Everything afterwards —
 * staff, rosters, patients — is an ordinary record written on the device and
 * carried up by sync.
 *
 * One transaction: claim the invite, create the facility, its first admin and
 * the registering device, mint that device's credential. Any failure rolls the
 * whole thing back, invite included.
 */
export type RegistrationOutcome =
  | { ok: true; result: FacilityRegistrationResult }
  | { ok: false; error: 'invalid_invite'; rejection: InviteRejection }
  | { ok: false; error: 'facility_code_taken' }
  | { ok: false; error: 'device_already_enrolled' };

type UniqueViolation = { constraint_name?: string };

const takenBy = (cause: unknown): 'facility_code_taken' | 'device_already_enrolled' | undefined => {
  if (!isPostgresError(cause, UNIQUE_VIOLATION)) return undefined;
  const constraint = (cause as UniqueViolation).constraint_name;
  if (constraint === 'facilities_pkey') return 'facility_code_taken';
  if (constraint === 'devices_pkey') return 'device_already_enrolled';
  return undefined;
};

export const registerFacility = async (
  sql: Sql,
  registration: FacilityRegistration,
  syncEndpoint: string,
): Promise<RegistrationOutcome> => {
  try {
    return await sql.begin(async (tx): Promise<RegistrationOutcome> => {
      const invite = await findInvite(tx, registration.inviteToken);
      const rejection = rejectionFor(invite);
      if (rejection) return { ok: false, error: 'invalid_invite', rejection };
      if (!(await claimInvite(tx, registration.inviteToken, registration.code))) {
        return { ok: false, error: 'invalid_invite', rejection: 'already_used' };
      }

      const now = new Date().toISOString();
      const envelope = {
        facilityId: registration.code,
        schemaVersion: SCHEMA_VERSION,
        createdBy: 'system',
        createdOn: now,
        deviceId: registration.deviceId,
      };

      const facility = Facility.parse({
        ...envelope,
        id: registration.code,
        type: 'facility',
        code: registration.code,
        name: registration.name,
        state: registration.state,
        lga: registration.lga,
        level: registration.level,
      });

      const staffId = `staff:${randomUUID()}`;
      const admin = Staff.parse({
        ...envelope,
        id: staffId,
        type: 'staff',
        staffId,
        fullName: registration.adminFullName,
        role: 'facility_admin',
        permission: 'read_write',
        active: true,
      });

      // The first device enrols itself, vouched for by the invite rather than
      // by an already-enrolled device (there is none yet).
      const device = Device.parse({
        ...envelope,
        id: registration.deviceId,
        type: 'device',
        label: registration.deviceLabel,
        enrolledBy: staffId,
        status: 'active',
        wipeRequested: false,
        enrolledOn: now,
      });

      await insertRecord(tx, 'facility', facility);
      await insertRecord(tx, 'staff', admin);
      await insertRecord(tx, 'device', device);
      const credential = await issueCredential(tx, device.id);

      await recordAuditEvent(tx, {
        facilityId: facility.id,
        deviceId: device.id,
        actorStaffId: staffId,
        action: 'create',
        entityType: 'facility',
        entityId: facility.id,
      });
      await recordAuditEvent(tx, {
        facilityId: facility.id,
        deviceId: device.id,
        actorStaffId: staffId,
        action: 'enroll',
        entityType: 'device',
        entityId: device.id,
      });

      return {
        ok: true,
        result: {
          facility,
          admin,
          device: { deviceId: device.id, facilityId: facility.id, credential, syncEndpoint },
        },
      };
    });
  } catch (cause) {
    const taken = takenBy(cause);
    if (taken) return { ok: false, error: taken };
    throw cause;
  }
};

export const facilityExists = async (sql: Sql, code: string): Promise<boolean> =>
  (await sql`SELECT 1 FROM facilities WHERE id = ${code}`).length === 1;
