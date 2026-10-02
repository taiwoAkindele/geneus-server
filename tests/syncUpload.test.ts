import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, Patient, Staff, SyncRejection, UploadMutation } from '#shared';
import { findRecord } from '../src/db/records.ts';
import { enrollDevice, issueEnrollmentCode } from '../src/devices/enrollment.ts';
import {
  addStaff,
  clientId,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
  testApp,
  upload,
  type ScratchDatabase,
} from './postgres.ts';

const HOUR = 60 * 60 * 1000;

/**
 * The security matrix (migration plan §35): two facilities, two devices in one
 * of them, staff of every relevant kind, one patient — and every way a device
 * could try to write something it should not. Refusals are read back from the
 * response, the reconcile queue and the audit trail, because all three are the
 * contract.
 */
describe('POST /sync/upload', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let a: FacilityRegistrationResult;
  let b: FacilityRegistrationResult;
  /** A second enrolled device in facility A. */
  let aSecond: { deviceId: string; credential: string };
  let nurse: Staff;
  let readOnlyNurse: Staff;
  let deactivatedChew: Staff;
  let supervisor: Staff;
  let records: Staff;

  const patientId = (facility: FacilityRegistrationResult, sequence: string) => `${facility.facility.id}-${sequence}-K2`;

  const patientPut = (
    facility: FacilityRegistrationResult,
    by: Staff,
    sequence: string,
    overrides: Record<string, unknown> = {},
  ): UploadMutation => ({
    clientId: clientId(),
    op: 'put',
    table: 'patient',
    id: patientId(facility, sequence),
    data: {
      ...envelopeFor(facility),
      createdBy: by.id,
      id: patientId(facility, sequence),
      type: 'patient',
      patientId: patientId(facility, sequence),
      fullName: 'Amaka Okoro',
      address: 'Odo-Ona',
      sex: 'female',
      ageYears: 32,
      phone: '0801',
      ...overrides,
    },
  });

  const patch = (table: UploadMutation['table'], id: string, by: Staff, data: Record<string, unknown>, previous?: Record<string, unknown>): UploadMutation => ({
    clientId: clientId(),
    op: 'patch',
    table,
    id,
    data: { ...data, updatedBy: by.id, updatedOn: new Date().toISOString() },
    ...(previous ? { previous } : {}),
  });

  const send = (credential: string, ...mutations: UploadMutation[]) =>
    upload(app, credential, { transactionId: 1, mutations });

  const rejectionsFor = (entityId: string) =>
    db.sql<{ category: string; reason: string; attributed_to: string | null; conflicts: SyncRejection['conflicts'] }[]>`
      SELECT category, reason, attributed_to, conflicts FROM sync_rejections WHERE entity_id = ${entityId} ORDER BY created_on`;

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    [a, b] = await Promise.all([registerScratchFacility(db.sql), registerScratchFacility(db.sql)]);
    [nurse, readOnlyNurse, deactivatedChew, supervisor, records] = await Promise.all([
      addStaff(db.sql, a, { role: 'nurse' }),
      addStaff(db.sql, a, { role: 'nurse', permission: 'read_only' }),
      addStaff(db.sql, a, { role: 'chew', active: false }),
      addStaff(db.sql, a, { role: 'supervisor' }),
      addStaff(db.sql, a, { role: 'records_officer' }),
    ]);
    const code = await issueEnrollmentCode(db.sql, a.facility.id, a.admin.id, a.device.deviceId);
    const enrolled = await enrollDevice(db.sql, { code: code.code, deviceId: 'device-a-second' }, 'http://sync');
    if (!enrolled.ok) throw new Error(enrolled.error);
    aSecond = { deviceId: enrolled.device.id, credential: enrolled.credential.credential };
  });

  after(async () => {
    await app.close();
    await db.drop();
  });

  describe('authentication', () => {
    const mutation = () => ({ transactionId: 1, mutations: [patientPut(a, nurse, '000900')] });

    it('refuses an upload with no credential', async () => {
      const response = await app.inject({ method: 'POST', url: '/sync/upload', payload: mutation() });
      assert.equal(response.statusCode, 401);
    });

    it('refuses a wrong secret for a real device', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sync/upload',
        headers: { authorization: `Bearer ${a.device.deviceId}.wrong` },
        payload: mutation(),
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, 'unauthorized');
    });

    it('refuses a revoked device, even with its real secret', async () => {
      const revoked = await registerScratchFacility(db.sql);
      await db.sql`UPDATE devices SET status = 'revoked', revoked_on = now() WHERE id = ${revoked.device.deviceId}`;

      const response = await app.inject({
        method: 'POST',
        url: '/sync/upload',
        headers: { authorization: `Bearer ${revoked.device.credential}` },
        payload: mutation(),
      });
      assert.equal(response.statusCode, 401);
    });
  });

  describe('facility and device identity', () => {
    it('applies a nurse\'s patient registration from her own facility and device', async () => {
      const response = await send(a.device.credential, patientPut(a, nurse, '000001'));

      assert.deepEqual(response.rejected, []);
      assert.equal(response.applied, 1);
      assert.ok(await findRecord(db.sql, 'patient', patientId(a, '000001')));
    });

    it('refuses a record that claims to belong to facility B, arriving from facility A\'s device', async () => {
      const forged = patientPut(a, nurse, '000002', { facilityId: b.facility.id });

      const response = await send(a.device.credential, forged);

      assert.equal(response.rejected[0]?.category, 'identity');
      assert.equal(await findRecord(db.sql, 'patient', forged.id), undefined);
    });

    it('refuses a record stamped with a device other than the one uploading it', async () => {
      const forged = patientPut(a, nurse, '000003', { deviceId: b.device.deviceId });

      const response = await send(a.device.credential, forged);

      assert.equal(response.rejected[0]?.category, 'identity');
      assert.match(response.rejected[0]?.reason ?? '', /not this device/);
    });

    it('refuses a record attributed to staff of another facility, or to nobody', async () => {
      const otherFacilitysAdmin = patientPut(a, b.admin, '000004');
      const nobody = patientPut(a, { ...nurse, id: 'staff:ghost' }, '000005');

      const response = await send(a.device.credential, otherFacilitysAdmin, nobody);

      assert.deepEqual(response.rejected.map((rejection) => rejection.category), ['identity', 'identity']);
    });

    it('cannot patch a record of another facility, even knowing its id', async () => {
      await send(b.device.credential, patientPut(b, b.admin, '000001'));

      const response = await send(a.device.credential, patch('patient', patientId(b, '000001'), nurse, { phone: '0999' }));

      assert.equal(response.rejected[0]?.category, 'identity');
      const untouched = await findRecord<Patient>(db.sql, 'patient', patientId(b, '000001'));
      assert.equal(untouched?.phone, '0801');
    });
  });

  describe('staff authorization', () => {
    it('refuses a write attributed to read-only staff', async () => {
      const response = await send(a.device.credential, patientPut(a, readOnlyNurse, '000010'));

      assert.equal(response.rejected[0]?.category, 'authorization');
      assert.match(response.rejected[0]?.reason ?? '', /patient:create is not granted/);
    });

    it('refuses a nurse creating staff — an admin-only action', async () => {
      const response = await send(a.device.credential, {
        clientId: clientId(),
        op: 'put',
        table: 'staff',
        id: 'staff:by-nurse',
        data: { ...envelopeFor(a), createdBy: nurse.id, id: 'staff:by-nurse', type: 'staff', staffId: 'staff:by-nurse', fullName: 'X', role: 'doctor', permission: 'read_write', active: true },
      });

      assert.equal(response.rejected[0]?.category, 'authorization');
      assert.equal(await findRecord(db.sql, 'staff', 'staff:by-nurse'), undefined);
    });

    it('refuses deactivated staff, whatever the device believed when it wrote', async () => {
      const response = await send(a.device.credential, patientPut(a, deactivatedChew, '000011'));

      assert.equal(response.rejected[0]?.category, 'authorization');
      assert.match(response.rejected[0]?.reason ?? '', /deactivated/);
    });

    it('lets a supervisor extend a shift but not a nurse', async () => {
      const shiftId = `roster_shift:${nurse.id}:2026-09-12`;
      await send(a.device.credential, {
        clientId: clientId(),
        op: 'put',
        table: 'roster_shift',
        id: shiftId,
        data: { ...envelopeFor(a), id: shiftId, type: 'roster_shift', staffId: nurse.id, startsAt: '2026-09-12T08:00:00Z', endsAt: '2026-09-12T16:00:00Z' },
      });

      const bySupervisor = await send(a.device.credential, patch('roster_shift', shiftId, supervisor, { extendedUntil: '2026-09-12T20:00:00Z' }));
      const byNurse = await send(a.device.credential, patch('roster_shift', shiftId, nurse, { extendedUntil: '2026-09-12T22:00:00Z' }));

      assert.deepEqual(bySupervisor.rejected, []);
      assert.equal(byNurse.rejected[0]?.category, 'authorization');
    });

    it('refuses a shift that arrives already signed — the signature is the server\'s to add', async () => {
      const shiftId = `roster_shift:${nurse.id}:2026-09-13`;
      const response = await send(a.device.credential, {
        clientId: clientId(),
        op: 'put',
        table: 'roster_shift',
        id: shiftId,
        data: { ...envelopeFor(a), id: shiftId, type: 'roster_shift', staffId: nurse.id, startsAt: '2026-09-13T08:00:00Z', endsAt: '2026-09-13T16:00:00Z', signature: 'forged' },
      });

      assert.equal(response.rejected[0]?.category, 'validation');
    });

    it('refuses a high-risk admin action performed more than 24 hours before it reached the server', async () => {
      const stale = new Date(Date.now() - 25 * HOUR).toISOString();
      const response = await send(a.device.credential, {
        clientId: clientId(),
        op: 'put',
        table: 'staff',
        id: 'staff:stale',
        data: { ...envelopeFor(a, stale), id: 'staff:stale', type: 'staff', staffId: 'staff:stale', fullName: 'Late', role: 'nurse', permission: 'read_write', active: true },
      });

      assert.equal(response.rejected[0]?.category, 'authorization');
      assert.match(response.rejected[0]?.reason ?? '', /24 hours/);
    });

    it('accepts the same admin action performed an hour ago', async () => {
      const fresh = new Date(Date.now() - HOUR).toISOString();
      const response = await send(a.device.credential, {
        clientId: clientId(),
        op: 'put',
        table: 'staff',
        id: 'staff:fresh',
        data: { ...envelopeFor(a, fresh), id: 'staff:fresh', type: 'staff', staffId: 'staff:fresh', fullName: 'Prompt', role: 'nurse', permission: 'read_write', active: true },
      });

      assert.deepEqual(response.rejected, []);
    });
  });

  describe('deletes and server-written tables', () => {
    it('refuses a delete outright', async () => {
      const response = await send(a.device.credential, { clientId: clientId(), op: 'delete', table: 'patient', id: patientId(a, '000001'), data: {} });

      assert.equal(response.rejected[0]?.category, 'authorization');
      assert.ok(await findRecord(db.sql, 'patient', patientId(a, '000001')));
    });

    it('refuses a device inserting a device or a facility', async () => {
      const response = await send(a.device.credential, {
        clientId: clientId(),
        op: 'put',
        table: 'device',
        id: 'device-self-enrolled',
        data: { ...envelopeFor(a), id: 'device-self-enrolled', type: 'device', enrolledBy: a.admin.id, enrolledOn: new Date().toISOString() },
      });

      assert.equal(response.rejected[0]?.category, 'authorization');
    });
  });

  describe('validation and immutability', () => {
    it('refuses a record that fails the contract', async () => {
      const response = await send(a.device.credential, patientPut(a, nurse, '000020', { sex: 'unknown' }));

      assert.equal(response.rejected[0]?.category, 'validation');
    });

    it('refuses a patch that moves an identity field', async () => {
      for (const change of [{ createdBy: supervisor.id }, { deviceId: aSecond.deviceId }, { createdOn: '2020-01-01T00:00:00Z' }, { facilityId: b.facility.id }]) {
        const response = await send(a.device.credential, patch('patient', patientId(a, '000001'), nurse, change));
        assert.equal(response.rejected[0]?.category, 'validation', JSON.stringify(change));
      }
    });

    it('refuses a patch with no attribution', async () => {
      const response = await send(a.device.credential, { clientId: clientId(), op: 'patch', table: 'patient', id: patientId(a, '000001'), data: { phone: '0000' } });

      assert.equal(response.rejected[0]?.category, 'validation');
    });
  });

  describe('idempotency', () => {
    it('applies a retried transaction once and acknowledges the retries', async () => {
      const mutation = patientPut(a, nurse, '000030');
      const request = { transactionId: 42, mutations: [mutation] };

      const first = await upload(app, a.device.credential, request);
      const second = await upload(app, a.device.credential, request);
      const third = await upload(app, a.device.credential, request);

      assert.deepEqual([first.applied, first.duplicates], [1, 0]);
      assert.deepEqual([second.applied, second.duplicates], [0, 1]);
      assert.deepEqual([third.applied, third.duplicates], [0, 1]);
      assert.equal((await db.sql`SELECT 1 FROM patients WHERE id = ${mutation.id}`).length, 1);
    });

    it('does not re-record a rejection when the rejected mutation is retried', async () => {
      const mutation = patientPut(a, readOnlyNurse, '000031');
      await send(a.device.credential, mutation);
      await send(a.device.credential, mutation);

      assert.equal((await rejectionsFor(mutation.id)).length, 1);
    });
  });

  describe('conflicts', () => {
    it('rejects the second device creating the same patient id — never overwrites the first', async () => {
      const first = patientPut(a, nurse, '000040', { fullName: 'First Device' });
      const second = { ...patientPut(a, nurse, '000040', { fullName: 'Second Device' }), data: { ...patientPut(a, nurse, '000040', { fullName: 'Second Device' }).data, deviceId: aSecond.deviceId } };
      await send(a.device.credential, first);

      const response = await send(aSecond.credential, second);

      assert.equal(response.rejected[0]?.category, 'conflict');
      assert.equal((await findRecord<Patient>(db.sql, 'patient', first.id))?.fullName, 'First Device');
    });

    it('merges changes to different columns from two devices', async () => {
      const id = patientId(a, '000041');
      await send(a.device.credential, patientPut(a, nurse, '000041'));

      await send(a.device.credential, patch('patient', id, nurse, { phone: '0802' }, { phone: '0801' }));
      const response = await send(aSecond.credential, patch('patient', id, nurse, { address: 'Ring Road' }, { address: 'Odo-Ona' }));

      assert.deepEqual(response.rejected, []);
      const merged = await findRecord<Patient>(db.sql, 'patient', id);
      assert.equal(merged?.phone, '0802');
      assert.equal(merged?.address, 'Ring Road');
    });

    it('queues a same-column race on a patient for a human, applying the rest', async () => {
      const id = patientId(a, '000042');
      await send(a.device.credential, patientPut(a, nurse, '000042'));
      await send(a.device.credential, patch('patient', id, nurse, { phone: '0802' }, { phone: '0801' }));

      // The second device still thinks the phone is 0801, and also fixes the address.
      const response = await send(aSecond.credential, patch('patient', id, nurse, { phone: '0803', address: 'Ring Road' }, { phone: '0801', address: 'Odo-Ona' }));

      assert.equal(response.applied, 1);
      assert.equal(response.rejected[0]?.category, 'conflict');
      const after = await findRecord<Patient>(db.sql, 'patient', id);
      assert.equal(after?.phone, '0802', 'the server value stands');
      assert.equal(after?.address, 'Ring Road', 'the non-conflicting column applied');
      const [queued] = await rejectionsFor(id);
      assert.deepEqual(queued.conflicts, [{ column: 'phone', deviceValue: '0803', serverValue: '0802' }]);
      assert.equal(queued.attributed_to, nurse.id);
    });

    it('treats a patch with no base values conservatively when the server row moved after it', async () => {
      const id = patientId(a, '000043');
      await send(a.device.credential, patientPut(a, nurse, '000043'));
      await send(a.device.credential, patch('patient', id, nurse, { phone: '0802' }));

      const olderThanServer = new Date(Date.now() - HOUR).toISOString();
      const response = await send(aSecond.credential, {
        clientId: clientId(),
        op: 'patch',
        table: 'patient',
        id,
        data: { phone: '0803', updatedBy: nurse.id, updatedOn: olderThanServer },
      });

      assert.equal(response.rejected[0]?.category, 'conflict');
      assert.equal((await findRecord<Patient>(db.sql, 'patient', id))?.phone, '0802');
    });

    it('rejects a patch to an append-only register entry', async () => {
      const response = await send(a.device.credential, patch('register_entry', 'register_entry:any', nurse, { values: {} }));

      assert.equal(response.rejected[0]?.category, 'validation');
      assert.match(response.rejected[0]?.reason ?? '', /append-only/);
    });

    it('rejects a second publish of the same register version, and accepts the next', async () => {
      const definition = (device: FacilityRegistrationResult['device'] | typeof aSecond, version: number, name: string): UploadMutation => ({
        clientId: clientId(),
        op: 'put',
        table: 'register_definition',
        id: `register:opd:v${version}`,
        data: { ...envelopeFor(a), deviceId: device.deviceId, createdBy: records.id, id: `register:opd:v${version}`, type: 'register_definition', registerId: 'register:opd', version, name, category: 'General', status: 'published', fields: [] },
      });
      await send(a.device.credential, definition(a.device, 1, 'OPD'));

      const collision = await send(aSecond.credential, definition(aSecond, 1, 'OPD (other device)'));
      const next = await send(aSecond.credential, definition(aSecond, 2, 'OPD v2'));

      assert.equal(collision.rejected[0]?.category, 'conflict');
      assert.deepEqual(next.rejected, []);
    });

    it('lets the later administrative change win on staff, and audits it', async () => {
      const target = await addStaff(db.sql, a, { role: 'chew' });
      await send(a.device.credential, patch('staff', target.id, a.admin, { permission: 'read_only' }, { permission: 'read_write' }));

      const response = await send(aSecond.credential, patch('staff', target.id, a.admin, { permission: 'read_write' }, { permission: 'read_write' }));

      assert.deepEqual(response.rejected, []);
      assert.equal((await findRecord<Staff>(db.sql, 'staff', target.id))?.permission, 'read_write');
      const audits = await db.sql<{ metadata: Record<string, unknown> }[]>`
        SELECT metadata FROM audit_events WHERE entity_id = ${target.id} AND action = 'update'`;
      assert.equal(audits[0]?.metadata.lastWriteWins, true);
    });
  });

  describe('the record of a refusal', () => {
    it('files a sync rejection and a rejected audit event, attributed to the staff member', async () => {
      const mutation = patientPut(a, readOnlyNurse, '000050');
      await send(a.device.credential, mutation);

      const [rejection] = await rejectionsFor(mutation.id);
      const [audit] = await db.sql<{ result: string; actor_staff_id: string; action: string }[]>`
        SELECT result, actor_staff_id, action FROM audit_events WHERE entity_id = ${mutation.id}`;

      assert.equal(rejection.category, 'authorization');
      assert.equal(rejection.attributed_to, readOnlyNurse.id);
      assert.deepEqual(audit, { result: 'rejected', actor_staff_id: readOnlyNurse.id, action: 'reject' });
    });

    it('records the rejection in the ledger as rejected, and the upload as contact', async () => {
      const mutation = patientPut(a, readOnlyNurse, '000051');
      const before = await db.sql<{ last_seen_on: string | null }[]>`SELECT last_seen_on FROM devices WHERE id = ${a.device.deviceId}`;
      await send(a.device.credential, mutation);

      const [ledger] = await db.sql<{ outcome: string }[]>`
        SELECT outcome FROM applied_mutations WHERE device_id = ${a.device.deviceId} AND client_id = ${mutation.clientId}`;
      const after = await db.sql<{ last_seen_on: string | null }[]>`SELECT last_seen_on FROM devices WHERE id = ${a.device.deviceId}`;

      assert.equal(ledger.outcome, 'rejected');
      assert.notEqual(after[0].last_seen_on, null);
      assert.ok(!before[0].last_seen_on || after[0].last_seen_on! >= before[0].last_seen_on);
    });

    it('stamps the server clock on audit events the device recorded offline', async () => {
      const id = 'audit_event:offline-login';
      const response = await send(a.device.credential, {
        clientId: clientId(),
        op: 'put',
        table: 'audit_event',
        id,
        data: { ...envelopeFor(a, '2026-09-10T07:00:00Z'), createdBy: nurse.id, id, type: 'audit_event', actorStaffId: nurse.id, action: 'login', occurredOn: '2026-09-10T07:00:00Z' },
      });

      assert.deepEqual(response.rejected, []);
      const [row] = await db.sql<{ received_on: string; occurred_on: string }[]>`SELECT received_on, occurred_on FROM audit_events WHERE id = ${id}`;
      assert.ok(row.received_on > row.occurred_on);
    });
  });
});
