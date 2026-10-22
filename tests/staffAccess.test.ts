import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { staffPermissions, type FacilityRegistrationResult, type Staff, type UploadMutation } from '#shared';
import { findRecord } from '../src/db/records.ts';
import { findStaffInFacility, staffDenial } from '../src/auth/staffAuthorization.ts';
import { addStaff, clientId, envelopeFor, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

describe('staff editing and combined authorization', () => {
  let db: ScratchDatabase, app: FastifyInstance, facility: FacilityRegistrationResult;
  before(async () => { db = await scratchDatabase(); app = testApp(db.sql); facility = await registerScratchFacility(db.sql); });
  after(async () => { await app?.close(); await db?.drop(); });
  const send = (f: FacilityRegistrationResult, ...mutations: UploadMutation[]) => upload(app, f.device.credential, { transactionId: 1, mutations });
  const patch = (id: string, by: Staff, data: Record<string, unknown>): UploadMutation => ({
    clientId: clientId(), op: 'patch', table: 'staff', id,
    data: { ...data, updatedBy: by.id, updatedOn: new Date().toISOString() },
  });
  const put = (table: UploadMutation['table'], id: string, data: Record<string, unknown>): UploadMutation => ({
    clientId: clientId(), op: 'put', table, id, data: { ...data, id, type: table },
  });
  const patient = (by: Staff, seq: string) => {
    const id = `${facility.facility.id}-${seq}-K2`;
    return put('patient', id, { ...envelopeFor(facility), createdBy: by.id, patientId: id, fullName: 'Synthetic Patient', address: 'Test Road', sex: 'female', ageYears: 30 });
  };

  it('preserves legacy staff and reads optional grants from real PostgreSQL', async () => {
    const staff = await findRecord<Staff>(db.sql, 'staff', facility.admin.id);
    assert.deepEqual(staff?.additionalRoles, []);
    assert.deepEqual(staff?.additionalPermissions, []);
    assert.ok(staff && staffPermissions(staff).includes('staff:permission'));
  });

  it('creates and edits combined staff access, with an attributed audit event', async () => {
    const id = 'staff:combined';
    const created = await send(facility, put('staff', id, {
      ...envelopeFor(facility), staffId: id, fullName: 'Original Name', role: 'nurse',
      additionalRoles: ['cashier'], additionalPermissions: ['fee_item:manage'], permission: 'read_write', active: true,
    }));
    assert.equal(created.applied, 1);
    const changed = await send(facility, patch(id, facility.admin, { fullName: 'Updated Name', additionalRoles: ['cashier', 'supervisor'] }));
    assert.equal(changed.applied, 1);
    const saved = await findRecord<Staff>(db.sql, 'staff', id);
    assert.equal(saved?.fullName, 'Updated Name');
    assert.equal(saved?.role, 'nurse');
    assert.deepEqual(saved?.additionalRoles, ['cashier', 'supervisor']);
    const server = await findStaffInFacility(db.sql, facility.facility.id, id);
    assert.equal(staffDenial(server, id, 'payment:receive'), undefined);
    assert.equal(staffDenial(server, id, 'roster:extend'), undefined);
    assert.equal(staffDenial(server, id, 'fee_item:manage'), undefined);
    assert.equal(staffDenial(server, id, 'staff:permission')?.kind, 'not_granted');
    const [audit] = await db.sql`SELECT actor_staff_id FROM audit_events WHERE entity_id = ${id} AND action = 'update'`;
    assert.equal(audit.actor_staff_id, facility.admin.id);
  });

  it('uses and then revokes an individual grant from server state on the next upload', async () => {
    const staff = await addStaff(db.sql, facility, { role: 'cashier', additionalPermissions: ['patient:create'] });
    assert.equal((await send(facility, patient(staff, '000801'))).applied, 1);
    assert.equal((await send(facility, patch(staff.id, facility.admin, { additionalPermissions: [] }))).applied, 1);
    const refused = await send(facility, patient(staff, '000802'));
    assert.equal(refused.rejected[0]?.category, 'authorization');
    assert.equal(await findRecord(db.sql, 'patient', `${facility.facility.id}-000802-K2`), undefined);
  });

  it('keeps read-only stronger than any selected roles or extra grants', async () => {
    const staff = await addStaff(db.sql, facility, { role: 'nurse', additionalRoles: ['facility_admin'], additionalPermissions: ['payment:receive'], permission: 'read_only' });
    const result = await send(facility, patient(staff, '000803'));
    assert.equal(result.rejected[0]?.category, 'authorization');
  });

  it('lets a delegate rename staff but refuses access changes and privileged account creation', async () => {
    const delegate = await addStaff(db.sql, facility, { role: 'nurse', additionalPermissions: ['staff:manage'] });
    const target = await addStaff(db.sql, facility, { role: 'cashier' });
    assert.equal((await send(facility, patch(target.id, delegate, { fullName: 'Allowed Rename' }))).applied, 1);
    const denied = await send(facility, patch(target.id, delegate, { additionalRoles: ['facility_admin'] }));
    assert.equal(denied.rejected[0]?.category, 'authorization');
    assert.deepEqual((await findRecord<Staff>(db.sql, 'staff', target.id))?.additionalRoles, []);
    const id = 'staff:unauthorized-admin';
    const create = await send(facility, put('staff', id, { ...envelopeFor(facility), createdBy: delegate.id, staffId: id, fullName: 'Must Not Exist', role: 'facility_admin' }));
    assert.equal(create.rejected[0]?.category, 'authorization');
    assert.equal(await findRecord(db.sql, 'staff', id), undefined);
    const pin = await app.inject({ method: 'POST', url: `/staff/${facility.admin.id}/pin-codes`, headers: { authorization: `Bearer ${facility.device.credential}` }, payload: { issuedBy: delegate.id } });
    assert.equal(pin.statusCode, 403);
  });

  it('recognizes a secondary admin and prevents supervisors resetting that account', async () => {
    const secondary = await addStaff(db.sql, facility, { role: 'nurse', additionalRoles: ['facility_admin'] });
    const target = await addStaff(db.sql, facility, { role: 'cashier' });
    const response = await app.inject({ method: 'POST', url: `/staff/${target.id}/pin-codes`, headers: { authorization: `Bearer ${facility.device.credential}` }, payload: { issuedBy: secondary.id } });
    assert.equal(response.statusCode, 201);
    const server = await findStaffInFacility(db.sql, facility.facility.id, secondary.id);
    assert.equal(staffDenial(server, secondary.id, 'staff:permission'), undefined);
  });

  it('rejects an unassignable PIN claim and unknown roles before persisting', async () => {
    const staff = await addStaff(db.sql, facility, { role: 'nurse' });
    for (const changes of [{ additionalPermissions: ['pin_setup_code:claim'] }, { additionalRoles: ['janitor'] }]) {
      const result = await send(facility, patch(staff.id, facility.admin, changes));
      assert.equal(result.rejected[0]?.category, 'validation');
    }
    assert.deepEqual((await findRecord<Staff>(db.sql, 'staff', staff.id))?.additionalPermissions, []);
  });

  it('refuses cross-facility staff edits', async () => {
    const other = await registerScratchFacility(db.sql);
    const result = await send(facility, patch(other.admin.id, facility.admin, { fullName: 'Must Not Change' }));
    assert.equal(result.rejected[0]?.category, 'identity');
    assert.notEqual((await findRecord<Staff>(db.sql, 'staff', other.admin.id))?.fullName, 'Must Not Change');
  });

  it('protects the last admin even when two admins demote themselves concurrently', async () => {
    const isolated = await registerScratchFacility(db.sql);
    const second = await addStaff(db.sql, isolated, { role: 'nurse', additionalRoles: ['facility_admin'] });
    const results = await Promise.all([
      send(isolated, patch(isolated.admin.id, isolated.admin, { role: 'records_officer' })),
      send(isolated, patch(second.id, second, { additionalRoles: [] })),
    ]);
    assert.equal(results.reduce((total, result) => total + result.applied, 0), 1);
    assert.equal(results.reduce((total, result) => total + result.rejected.length, 0), 1);
    assert.ok(results.some((result) => result.rejected[0]?.reason.includes('at least one active facility administrator')));
  });

  it('records care attributed to an assigned additional role', async () => {
    const staff = await addStaff(db.sql, facility, { role: 'cashier', additionalRoles: ['nurse'] });
    const patientMutation = patient(staff, '000804');
    const encounterId = 'encounter:combined-role';
    const response = await send(facility, patientMutation,
      put('encounter', encounterId, { ...envelopeFor(facility), createdBy: staff.id, patientId: patientMutation.id, openedOn: new Date().toISOString() }),
      put('encounter_entry', 'entry:combined-role', { ...envelopeFor(facility), createdBy: staff.id, patientId: patientMutation.id, encounterId, actorRole: 'nurse', step: 'vitals', values: { temperatureC: 37 } }));
    assert.equal(response.applied, 3);
  });
});
