import { randomInt } from 'node:crypto';
import { Device, SCHEMA_VERSION, type DeviceCredential } from '#shared';
import { isPostgresError, UNIQUE_VIOLATION, type Sql } from '../db/client.ts';
import { findRecord, insertRecord } from '../db/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { issueCredential } from './credentials.ts';

/**
 * Enrollment is what turns a phone into a durable, syncing replica of one
 * facility's data (root §4.3c). Both halves happen online: an enrolled device
 * asks for a code, the joining device spends it. De-enrollment is the reverse
 * and is what makes a lost or retired phone stop syncing.
 */

/** No I/O/0/1: the code is read out loud across a room. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 15 * 60 * 1000;

export type EnrollmentCodeRecord = { code: string; facilityId: string; expiresOn: string };

export const issueEnrollmentCode = async (
  sql: Sql,
  facilityId: string,
  issuedBy: string,
  issuedFrom: string,
): Promise<EnrollmentCodeRecord> => {
  const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const expiresOn = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await sql`
    INSERT INTO enrollment_codes (code, facility_id, issued_by, issued_from, expires_on)
    VALUES (${code}, ${facilityId}, ${issuedBy}, ${issuedFrom}, ${expiresOn})`;
  return { code, facilityId, expiresOn };
};

export type EnrollmentOutcome =
  | { ok: true; credential: DeviceCredential; device: Device }
  | { ok: false; error: 'invalid_code' | 'device_already_enrolled' };

type ClaimedCode = { facility_id: string; issued_by: string; issued_from: string };

/**
 * Spends the code and enrols the device in one transaction. The code is
 * claimed by a single UPDATE — two phones typing the same code cannot both
 * win — and decides the facility; the joining device does not get a say.
 */
export const enrollDevice = async (
  sql: Sql,
  request: { code: string; deviceId: string; deviceLabel?: string },
  syncEndpoint: string,
): Promise<EnrollmentOutcome> => {
  try {
    return await sql.begin(async (tx): Promise<EnrollmentOutcome> => {
      const [claimed] = await tx<ClaimedCode[]>`
        UPDATE enrollment_codes
        SET claimed_on = now(), claimed_by = ${request.deviceId}
        WHERE code = ${request.code.trim().toUpperCase()}
          AND claimed_on IS NULL
          AND expires_on >= now()
        RETURNING facility_id, issued_by, issued_from`;
      if (!claimed) return { ok: false, error: 'invalid_code' };

      const now = new Date().toISOString();
      const device = Device.parse({
        id: request.deviceId,
        type: 'device',
        facilityId: claimed.facility_id,
        schemaVersion: SCHEMA_VERSION,
        createdBy: claimed.issued_by,
        createdOn: now,
        deviceId: claimed.issued_from,
        label: request.deviceLabel,
        enrolledBy: claimed.issued_by,
        status: 'active',
        wipeRequested: false,
        enrolledOn: now,
      });
      await insertRecord(tx, 'device', device);
      const credential = await issueCredential(tx, device.id);
      await recordAuditEvent(tx, {
        facilityId: device.facilityId,
        deviceId: device.id,
        actorStaffId: claimed.issued_by,
        action: 'enroll',
        entityType: 'device',
        entityId: device.id,
      });

      return {
        ok: true,
        device,
        credential: { deviceId: device.id, facilityId: device.facilityId, credential, syncEndpoint },
      };
    });
  } catch (cause) {
    if (isPostgresError(cause, UNIQUE_VIOLATION)) return { ok: false, error: 'device_already_enrolled' };
    throw cause;
  }
};

export type RevocationOutcome = { ok: true; device: Device } | { ok: false; error: 'unknown_device' };

/**
 * De-enrolls a device of the caller's facility. Sync stops at the device's next
 * contact (its credential no longer verifies); `wipe` additionally asks the
 * device to drop its local replica when it next sees its own record.
 */
export const revokeDevice = async (
  sql: Sql,
  facilityId: string,
  targetDeviceId: string,
  revokedBy: string,
  revokedFrom: string,
  wipe: boolean,
): Promise<RevocationOutcome> =>
  sql.begin(async (tx): Promise<RevocationOutcome> => {
    const updated = await tx`
      UPDATE devices
      SET status = 'revoked', revoked_on = now(), wipe_requested = ${wipe}, updated_by = ${revokedBy}, updated_on = now()
      WHERE id = ${targetDeviceId} AND facility_id = ${facilityId}`;
    if (updated.count !== 1) return { ok: false, error: 'unknown_device' };

    await recordAuditEvent(tx, {
      facilityId,
      deviceId: revokedFrom,
      actorStaffId: revokedBy,
      action: 'revoke',
      entityType: 'device',
      entityId: targetDeviceId,
      metadata: { wipe },
    });
    const device = await findRecord<Device>(tx, 'device', targetDeviceId);
    return { ok: true, device: device as Device };
  });
