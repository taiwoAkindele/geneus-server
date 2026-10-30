import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Staff } from '#shared';
import { isFacilityAdministrator } from '../src/organizations/access.ts';
// Also loads the online route under Node's native, strip-only TypeScript runtime.
import '../src/routes/organizationFacilities.ts';

test('facility creation requires active administrator membership and write access, including additional roles', () => {
  const staff = Staff.parse({ id: 'staff:synthetic', staffId: 'staff:synthetic', facilityId: 'TEST', deviceId: 'device:synthetic', type: 'staff', schemaVersion: 4, createdBy: 'system', createdOn: '2026-10-30T09:00:00Z', fullName: 'Synthetic admin', role: 'facility_admin', permission: 'read_write', active: true });
  assert.equal(isFacilityAdministrator(staff), true);
  assert.equal(isFacilityAdministrator({ ...staff, active: false }), false);
  assert.equal(isFacilityAdministrator({ ...staff, permission: 'read_only' }), false);
  assert.equal(isFacilityAdministrator({ ...staff, role: 'nurse' }), false);
  assert.equal(isFacilityAdministrator({ ...staff, role: 'doctor', additionalRoles: ['facility_admin'] }), true);
});
