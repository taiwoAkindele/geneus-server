import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, Staff } from '#shared';
import { verifyCredential } from '../src/devices/credentials.ts';
import { enrollDevice, issueEnrollmentCode } from '../src/devices/enrollment.ts';
import {
  addStaff,
  asDevice,
  registerScratchFacility,
  scratchDatabase,
  testApp,
  type ScratchDatabase,
  SYNC_ENDPOINT as SYNC,
} from './postgres.ts';

/**
 * Revocation is how a phone stops being a facility's replica, driven from an
 * enrolled device by staff the server can see hold the permission. (Devices
 * are enrolled by a password sign-in, an invitation link or registration.)
 */
describe('device revocation', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let a: FacilityRegistrationResult;
  let b: FacilityRegistrationResult;
  let nurse: Staff;

  /** A second device of facility A, enrolled the way an invitation link enrols one. */
  const enrolledDevice = async (deviceId: string) => {
    const { code } = await issueEnrollmentCode(
      db.sql,
      a.facility.id,
      a.admin.id,
      a.device.deviceId,
    );
    const enrolled = await enrollDevice(
      db.sql,
      { code, deviceId, deviceLabel: 'Test phone' },
      SYNC,
    );

    assert.ok(enrolled.ok);

    return enrolled.credential;
  };

  const revoke = (credential: string, targetId: string, revokedBy: string, wipe = true) =>
    app.inject({
      method: 'POST',
      url: `/devices/${targetId}/revoke`,
      headers: asDevice(credential),
      payload: { revokedBy, wipe },
    });

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

  describe('revocation', () => {
    it('stops a revoked device from authenticating, and asks it to wipe', async () => {
      const credential = await enrolledDevice('device-to-revoke');

      const response = await revoke(a.device.credential, 'device-to-revoke', a.admin.id, true);

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().status, 'revoked');
      assert.equal(response.json().wipeRequested, true);
      assert.deepEqual(await verifyCredential(db.sql, credential.credential), {
        failure: 'revoked',
      });

      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/sync/token',
            headers: asDevice(credential.credential),
          })
        ).statusCode,
        401,
      );

      const audits =
        await db.sql`SELECT 1 FROM audit_events WHERE entity_id = 'device-to-revoke' AND action = 'revoke'`;

      assert.equal(audits.length, 1);
    });

    it('refuses a nurse, leaving the device enrolled', async () => {
      const credential = await enrolledDevice('device-nurse-cannot');

      assert.equal(
        (await revoke(a.device.credential, 'device-nurse-cannot', nurse.id)).statusCode,
        403,
      );

      assert.ok('identity' in (await verifyCredential(db.sql, credential.credential)));
    });

    it('cannot reach a device of another facility — it is simply not found', async () => {
      const response = await revoke(a.device.credential, b.device.deviceId, a.admin.id);

      assert.equal(response.statusCode, 404);

      const [device] = await db.sql<
        { status: string }[]
      >`SELECT status FROM devices WHERE id = ${b.device.deviceId}`;

      assert.equal(device.status, 'active');
    });
  });
});
