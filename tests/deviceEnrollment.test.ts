import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { DeviceCredential, EnrollmentCode, type FacilityRegistrationResult, type Staff } from '#shared';
import { verifyCredential } from '../src/devices/credentials.ts';
import { addStaff, asDevice, registerScratchFacility, scratchDatabase, testApp, type ScratchDatabase } from './postgres.ts';

/**
 * Enrollment is how a phone becomes a facility's replica, and revocation is
 * how it stops being one. Both are driven from an enrolled device by staff the
 * server can see hold the permission; the code itself decides the facility.
 */
describe('device enrollment', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let a: FacilityRegistrationResult;
  let b: FacilityRegistrationResult;
  let nurse: Staff;

  const issueCode = (credential: string, issuedBy: string) =>
    app.inject({ method: 'POST', url: '/devices/codes', headers: asDevice(credential), payload: { issuedBy } });

  const enroll = (code: string, deviceId: string) =>
    app.inject({ method: 'POST', url: '/devices', payload: { code, deviceId, deviceLabel: 'Test phone' } });

  const enrolledDevice = async (deviceId: string) => {
    const code = EnrollmentCode.parse((await issueCode(a.device.credential, a.admin.id)).json());
    return DeviceCredential.parse((await enroll(code.code, deviceId)).json());
  };

  const revoke = (credential: string, targetId: string, revokedBy: string, wipe = true) =>
    app.inject({ method: 'POST', url: `/devices/${targetId}/revoke`, headers: asDevice(credential), payload: { revokedBy, wipe } });

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    [a, b] = await Promise.all([registerScratchFacility(db.sql), registerScratchFacility(db.sql)]);
    nurse = await addStaff(db.sql, a, { role: 'nurse' });
  });

  after(async () => {
    await app.close();
    await db.drop();
  });

  describe('issuing a code', () => {
    it('lets the facility admin, from an enrolled device, issue a short-lived code', async () => {
      const response = await issueCode(a.device.credential, a.admin.id);

      assert.equal(response.statusCode, 201, response.body);
      const code = EnrollmentCode.parse(response.json());
      assert.match(code.code, /^[A-HJ-NP-Z2-9]{8}$/);
      assert.ok(Date.parse(code.expiresOn) - Date.now() <= 15 * 60 * 1000);
    });

    it('refuses a nurse — device:enroll is an admin permission', async () => {
      const response = await issueCode(a.device.credential, nurse.id);

      assert.equal(response.statusCode, 403);
      assert.match(response.json().message, /device:enroll is not granted/);
    });

    it('refuses an admin of another facility named from this device', async () => {
      const response = await issueCode(a.device.credential, b.admin.id);

      assert.equal(response.statusCode, 403);
      assert.match(response.json().message, /not a member of staff/);
    });

    it('refuses an unenrolled caller', async () => {
      assert.equal((await app.inject({ method: 'POST', url: '/devices/codes', payload: { issuedBy: a.admin.id } })).statusCode, 401);
    });
  });

  describe('spending a code', () => {
    it('enrols the joining device into the code\'s facility and hands it a working credential', async () => {
      const credential = await enrolledDevice('device-joiner-1');

      assert.equal(credential.facilityId, a.facility.id);
      assert.equal(credential.deviceId, 'device-joiner-1');
      assert.deepEqual(await verifyCredential(db.sql, credential.credential), {
        identity: { deviceId: 'device-joiner-1', facilityId: a.facility.id },
      });
      const [device] = await db.sql<{ enrolled_by: string; label: string; status: string }[]>`
        SELECT enrolled_by, label, status FROM devices WHERE id = 'device-joiner-1'`;
      assert.deepEqual(device, { enrolled_by: a.admin.id, label: 'Test phone', status: 'active' });
      const audits = await db.sql`SELECT 1 FROM audit_events WHERE entity_id = 'device-joiner-1' AND action = 'enroll'`;
      assert.equal(audits.length, 1);
    });

    it('spends the code exactly once', async () => {
      const code = EnrollmentCode.parse((await issueCode(a.device.credential, a.admin.id)).json());

      const first = await enroll(code.code, 'device-joiner-2');
      const second = await enroll(code.code, 'device-joiner-3');

      assert.equal(first.statusCode, 201);
      assert.equal(second.statusCode, 403);
      assert.equal(second.json().error, 'invalid_code');
    });

    it('refuses an expired or invented code', async () => {
      const code = EnrollmentCode.parse((await issueCode(a.device.credential, a.admin.id)).json());
      await db.sql`UPDATE enrollment_codes SET expires_on = now() - interval '1 minute' WHERE code = ${code.code}`;

      assert.equal((await enroll(code.code, 'device-late')).statusCode, 403);
      assert.equal((await enroll('NOTACODE', 'device-guess')).statusCode, 403);
    });

    it('refuses to enrol a device id that is already enrolled', async () => {
      const code = EnrollmentCode.parse((await issueCode(a.device.credential, a.admin.id)).json());

      const response = await enroll(code.code, a.device.deviceId);

      assert.equal(response.statusCode, 409);
    });
  });

  describe('revocation', () => {
    it('stops a revoked device from authenticating, and asks it to wipe', async () => {
      const credential = await enrolledDevice('device-to-revoke');

      const response = await revoke(a.device.credential, 'device-to-revoke', a.admin.id, true);

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().status, 'revoked');
      assert.equal(response.json().wipeRequested, true);
      assert.deepEqual(await verifyCredential(db.sql, credential.credential), { failure: 'revoked' });
      assert.equal((await app.inject({ method: 'POST', url: '/sync/token', headers: asDevice(credential.credential) })).statusCode, 401);
      const audits = await db.sql`SELECT 1 FROM audit_events WHERE entity_id = 'device-to-revoke' AND action = 'revoke'`;
      assert.equal(audits.length, 1);
    });

    it('refuses a nurse, leaving the device enrolled', async () => {
      const credential = await enrolledDevice('device-nurse-cannot');

      assert.equal((await revoke(a.device.credential, 'device-nurse-cannot', nurse.id)).statusCode, 403);
      assert.ok('identity' in (await verifyCredential(db.sql, credential.credential)));
    });

    it('cannot reach a device of another facility — it is simply not found', async () => {
      const response = await revoke(a.device.credential, b.device.deviceId, a.admin.id);

      assert.equal(response.statusCode, 404);
      const [device] = await db.sql<{ status: string }[]>`SELECT status FROM devices WHERE id = ${b.device.deviceId}`;
      assert.equal(device.status, 'active');
    });
  });
});
