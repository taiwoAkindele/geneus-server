import { createHash, randomBytes } from 'node:crypto';
import { staffPermissions, type Staff } from '#shared';
import type { Sql } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import type { DeviceIdentity } from '../devices/credentials.ts';
import { checkVerificationCode, consumeVerification, createVerificationCode, findStaffEmail } from '../email/verifications.ts';
const subject = (identity: DeviceIdentity, staffId: string) => JSON.stringify([identity.facilityId, identity.deviceId, staffId]);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export const beginPrivateAccess = async (sql: Sql, identity: DeviceIdentity, staffId: string) => {
  const staff = await findRecord<Staff>(sql, 'staff', staffId);
  const email = await findStaffEmail(sql, identity.facilityId, staffId);
  if (!staff?.active || staff.facilityId !== identity.facilityId || !email)
    return undefined;
  const code = await createVerificationCode(sql, { purpose: 'workforce_access', subject: subject(identity, staffId), email });
  return { email, ...code };
};
export const completePrivateAccess = async (sql: Sql, identity: DeviceIdentity, staffId: string, code: string) => {
  const email = await findStaffEmail(sql, identity.facilityId, staffId);
  if (!email)
    return undefined;
  const id = await checkVerificationCode(sql, { purpose: 'workforce_access', subject: subject(identity, staffId), email, code });
  if (!id)
    return undefined;
  return sql.begin(async (tx) => {
    const [member] = await tx`SELECT id FROM staff WHERE facility_id=${identity.facilityId} AND id=${staffId} AND active FOR UPDATE`;
    if (!member || !(await consumeVerification(tx, id)))
      return undefined;
    const token = randomBytes(32).toString('base64url'), expiresOn = new Date(Date.now() + 15 * 60000).toISOString();
    await tx`DELETE FROM workforce_private_sessions WHERE facility_id=${identity.facilityId} AND staff_id=${staffId} AND device_id=${identity.deviceId}`;
    await tx`INSERT INTO workforce_private_sessions(token_hash,facility_id,staff_id,device_id,expires_on,email)
      VALUES(${hash(token)},${identity.facilityId},${staffId},${identity.deviceId},${expiresOn},${email})`;
    return { token, expiresOn };
  });
};
/** Contact replacement, deactivation, device change, expiry and permission removal take effect on the next read. */
export const privateStaff = async (sql: Sql, identity: DeviceIdentity, token: string | undefined): Promise<Staff | undefined> => {
  if (!token || token.length > 200)
    return undefined;
  const [session] = await sql`SELECT s.staff_id FROM workforce_private_sessions s JOIN staff_contacts c ON c.facility_id=s.facility_id AND c.staff_id=s.staff_id
    WHERE s.token_hash=${hash(token)} AND s.facility_id=${identity.facilityId} AND s.device_id=${identity.deviceId} AND s.expires_on>now() AND c.email=s.email`;
  if (!session)
    return undefined;
  const staff = await findRecord<Staff>(sql, 'staff', session.staff_id as string);
  return staff?.active && staff.facilityId === identity.facilityId ? staff : undefined;
};
export const canReadWorkforceEvidence = (staff: Staff): boolean => staffPermissions({ ...staff, permission: 'read_write' }).includes('credential:read');
export const endPrivateAccess = async (sql: Sql, identity: DeviceIdentity, token: string): Promise<void> => {
  await sql`DELETE FROM workforce_private_sessions WHERE token_hash=${hash(token)} AND facility_id=${identity.facilityId} AND device_id=${identity.deviceId}`;
};
