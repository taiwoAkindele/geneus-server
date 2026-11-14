import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_VERSION, type FacilityRegistrationResult } from '#shared';
import type { FastifyInstance } from 'fastify';
import { enrollDevice, issueEnrollmentCode } from '../src/devices/enrollment.ts';
import { asDevice, registerScratchFacility, scratchDatabase, testApp, type ScratchDatabase } from './postgres.ts';

/** Revoking a device never discards its unsent work silently. */
describe('device revocation and unsent work', () => {
  let db: ScratchDatabase; let app: FastifyInstance; let f: FacilityRegistrationResult; let other: string;
  before(async () => {
    db = await scratchDatabase(); f = await registerScratchFacility(db.sql); app = testApp(db.sql);
    const code = await issueEnrollmentCode(db.sql, f.facility.id, f.admin.id, f.device.deviceId);
    const enrolled = await enrollDevice(db.sql, { code: code.code, deviceId: 'device-second-revoke', deviceLabel: 'Second tablet' }, 'http://127.0.0.1:8090');
    assert.ok(enrolled.ok, JSON.stringify(enrolled));
    other = 'device-second-revoke';
  });
  after(async () => { if (app) await app.close(); if (db) await db.drop(); });
  const revoke = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: `/devices/${other}/revoke`, headers: asDevice(f.device.credential), payload: { revokedBy: f.admin.id, wipe: false, ...body } });

  it('refuses while the device last reported unsent changes, naming how many', async () => {
    await db.sql`INSERT INTO workforce_client_versions (device_id, facility_id, contract_version, schema_version, policy_version, pending_mutation_count, recorded_on)
      VALUES (${other}, ${f.facility.id}, 1, 5, ${POLICY_VERSION}, 4, now())`;
    const refused = await revoke({});
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, 'unsent_work');
    assert.equal(refused.json().details.unsentChanges, 4);
    const [device] = await db.sql`SELECT status FROM devices WHERE id = ${other}`;
    assert.equal(device.status, 'active', 'nothing changed');
  });
  it('revokes only when the loss is accepted, and audits the count', async () => {
    const done = await revoke({ acceptUnsentWork: true });
    assert.equal(done.statusCode, 200, done.body);
    const [audit] = await db.sql`SELECT metadata FROM audit_events WHERE entity_id = ${other} AND action = 'revoke'`;
    assert.equal(audit.metadata.unsentChangesAccepted, 4);
  });
});
