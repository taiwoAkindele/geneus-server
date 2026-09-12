import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FacilityRegistrationResult } from '#shared';
import { verifyCredential } from '../src/devices/credentials.ts';
import { registerScratchFacility, scratchDatabase, type ScratchDatabase } from './postgres.ts';

/**
 * The credential is what CouchDB's per-device user document used to be: the
 * one thing a device holds that lets it sync. These tests exercise it the way
 * the server will on every request — resolve it, or say exactly why not.
 */
describe('device credentials', () => {
  let db: ScratchDatabase;
  let facility: FacilityRegistrationResult;

  before(async () => {
    db = await scratchDatabase();
    facility = await registerScratchFacility(db.sql);
  });

  after(async () => {
    await db.drop();
  });

  it('resolves a valid credential to the device and its facility, and nothing else', async () => {
    const outcome = await verifyCredential(db.sql, facility.device.credential);

    assert.deepEqual(outcome, {
      identity: { deviceId: facility.device.deviceId, facilityId: facility.facility.id },
    });
  });

  it('refuses the right device id with the wrong secret', async () => {
    const outcome = await verifyCredential(db.sql, `${facility.device.deviceId}.not-the-secret`);

    assert.deepEqual(outcome, { failure: 'wrong_secret' });
  });

  it('refuses a device it has never heard of', async () => {
    assert.deepEqual(await verifyCredential(db.sql, 'device-unknown.whatever'), { failure: 'unknown_device' });
  });

  it('refuses anything that is not <deviceId>.<secret>', async () => {
    for (const malformed of ['', 'no-dot', '.secret', 'device.']) {
      assert.deepEqual(await verifyCredential(db.sql, malformed), { failure: 'malformed' }, JSON.stringify(malformed));
    }
  });

  it('refuses a device once it is revoked, even with the right secret', async () => {
    const revoked = await registerScratchFacility(db.sql);
    await db.sql`UPDATE devices SET status = 'revoked', revoked_on = now() WHERE id = ${revoked.device.deviceId}`;

    assert.deepEqual(await verifyCredential(db.sql, revoked.device.credential), { failure: 'revoked' });
  });

  it('refuses a device that has been told to wipe', async () => {
    const wiped = await registerScratchFacility(db.sql);
    await db.sql`UPDATE devices SET wipe_requested = true WHERE id = ${wiped.device.deviceId}`;

    assert.deepEqual(await verifyCredential(db.sql, wiped.device.credential), { failure: 'wipe_requested' });
  });

  it('cannot be revoked without saying when', async () => {
    await assert.rejects(
      db.sql`UPDATE devices SET status = 'revoked' WHERE id = ${facility.device.deviceId}`,
      /devices_revoked_have_a_time/,
    );
  });
});
