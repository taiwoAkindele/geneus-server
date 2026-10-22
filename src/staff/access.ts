import { hasRole, type Staff } from '#shared';
import type { Tx } from '../db/client.ts';

/** The facility must retain an administrator who can maintain staff and rosters. */
export const isWorkingAdmin = (staff: Pick<Staff, 'role' | 'additionalRoles' | 'permission' | 'active'>): boolean =>
  staff.active && staff.permission === 'read_write' && hasRole(staff, 'facility_admin');

/** Caller locks the facility row before reading the staff being edited. */
export const keepsAdministrator = async (tx: Tx, before: Staff, after: Staff): Promise<boolean> => {
  if (!isWorkingAdmin(before) || isWorkingAdmin(after)) return true;
  const [other] = await tx`
    SELECT id FROM staff
    WHERE facility_id = ${before.facilityId} AND id <> ${before.id}
      AND active AND permission = 'read_write'
      AND (role = 'facility_admin' OR additional_roles @> '["facility_admin"]'::jsonb)
    LIMIT 1`;
  return Boolean(other);
};
