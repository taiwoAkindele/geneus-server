import { permissionsFor, type Permission, type Role, type StaffPermission } from '#shared';
import type { Sql, Tx } from '../db/client.ts';

/**
 * The server's own answer to "may this member of staff do this?" — built from
 * the `staff` table, never from anything the client sent. The matrix it
 * applies is the shared one, so the answer matches what the device decided
 * offline; the difference is that this copy of the facts is the one that counts.
 */
export type StaffRecord = { id: string; role: Role; permission: StaffPermission; active: boolean };

export type StaffDenial =
  | { kind: 'not_member'; staffId: string }
  | { kind: 'deactivated'; staffId: string }
  | { kind: 'not_granted'; staffId: string; permission: Permission };

/** Only staff of *this* facility exist as far as a request from it is concerned. */
export const findStaffInFacility = async (
  sql: Sql | Tx,
  facilityId: string,
  staffId: string,
): Promise<StaffRecord | undefined> => {
  const [row] = await sql<StaffRecord[]>`
    SELECT id, role, permission, active FROM staff WHERE facility_id = ${facilityId} AND id = ${staffId}`;
  return row;
};

export const staffDenial = (
  staff: StaffRecord | undefined,
  staffId: string,
  permission: Permission,
): StaffDenial | undefined => {
  if (!staff) return { kind: 'not_member', staffId };
  if (!staff.active) return { kind: 'deactivated', staffId };
  if (!permissionsFor(staff.role, staff.permission).includes(permission)) return { kind: 'not_granted', staffId, permission };
  return undefined;
};

export const describeDenial = (denial: StaffDenial): string => {
  switch (denial.kind) {
    case 'not_member':
      return `${denial.staffId} is not a member of staff at this facility`;
    case 'deactivated':
      return `${denial.staffId} has been deactivated`;
    case 'not_granted':
      return `${denial.permission} is not granted to ${denial.staffId}`;
  }
};

/**
 * One call for the online admin routes: resolve the acting staff member within
 * the authenticated device's facility and check the permission. The upload
 * path composes the pieces itself because it also has to categorise the denial.
 */
export const authorizeStaff = async (
  sql: Sql | Tx,
  facilityId: string,
  staffId: string,
  permission: Permission,
): Promise<{ staff: StaffRecord } | { denial: StaffDenial }> => {
  const staff = await findStaffInFacility(sql, facilityId, staffId);
  const denial = staffDenial(staff, staffId, permission);
  return denial ? { denial } : { staff: staff as StaffRecord };
};
