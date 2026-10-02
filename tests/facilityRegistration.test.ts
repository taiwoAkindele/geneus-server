import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { FacilityRegistrationResult } from '#shared';
import { createInvite } from '../src/facilities/invites.ts';
import { lastCodeSentTo, scratchDatabase, scratchFacilityCode, testApp, verifiedEmailFor, type ScratchDatabase } from './postgres.ts';

/**
 * Registration through the HTTP contract, the way the PWA does it. What comes
 * back is a device credential — never a database credential — and what lands
 * in PostgreSQL is one facility, one admin, one device, in one transaction.
 */
describe('POST /facilities', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;

  const registration = async (overrides: Record<string, unknown> = {}) => {
    const invite = await createInvite(db.sql, 'Test PHC', 1);
    return {
      code: scratchFacilityCode(),
      name: 'Test PHC',
      state: 'Oyo',
      lga: 'Ibadan SW',
      level: 'phc',
      adminFullName: 'Amaka Okoro',
      ...(await verifiedEmailFor(db.sql, invite.token, 'amaka@example.org')),
      deviceId: `device-${Math.random().toString(36).slice(2)}`,
      inviteToken: invite.token,
      ...overrides,
    };
  };

  const post = (payload: InjectOptions['payload']) => app.inject({ method: 'POST', url: '/facilities', payload });

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
  });

  after(async () => {
    await app.close();
    await db.drop();
  });

  it('registers the facility and returns a device credential, never a database one', async () => {
    const body = await registration();

    const response = await post(body);

    assert.equal(response.statusCode, 201, response.body);
    const result = FacilityRegistrationResult.parse(response.json());
    assert.equal(result.facility.id, body.code);
    assert.equal(result.admin.role, 'facility_admin');
    assert.equal(result.device.deviceId, body.deviceId);
    assert.equal(result.device.facilityId, body.code);
    assert.ok(result.device.credential.startsWith(`${body.deviceId}.`));
    assert.doesNotMatch(response.body, /password|postgres|credential_hash/);
  });

  it('stores only a hash of the credential', async () => {
    const body = await registration();
    const { device } = FacilityRegistrationResult.parse((await post(body)).json());

    const [row] = await db.sql<{ credential_hash: string }[]>`
      SELECT credential_hash FROM device_credentials WHERE device_id = ${body.deviceId}`;

    assert.ok(row);
    assert.notEqual(row.credential_hash, device.credential);
    assert.equal(device.credential.includes(row.credential_hash), false);
  });

  it('writes the facility, its admin and its device, and audits both events', async () => {
    const body = await registration();
    await post(body);

    const [facilities, staff, devices, audits] = await Promise.all([
      db.sql`SELECT id FROM facilities WHERE id = ${body.code}`,
      db.sql`SELECT role, active FROM staff WHERE facility_id = ${body.code}`,
      db.sql`SELECT status, enrolled_by FROM devices WHERE id = ${body.deviceId}`,
      db.sql<{ action: string; entity_type: string }[]>`
        SELECT action, entity_type FROM audit_events WHERE facility_id = ${body.code} ORDER BY action`,
    ]);

    assert.equal(facilities.length, 1);
    assert.deepEqual([...staff], [{ role: 'facility_admin', active: true }]);
    assert.equal(devices[0]?.status, 'active');
    assert.deepEqual(
      audits.map((row) => `${row.action}:${row.entity_type}`),
      ['create:facility', 'enroll:device'],
    );
  });

  it('refuses a second registration of the same code without spending its invite', async () => {
    const first = await registration();
    await post(first);
    const second = await registration({ code: first.code });

    const response = await post(second);

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'facility_code_taken');
    // The whole registration is one transaction: the failed one rolled its claim back.
    const [invite] = await db.sql<{ claimed_on: string | null }[]>`
      SELECT claimed_on FROM facility_invites WHERE token = ${second.inviteToken}`;
    assert.equal(invite.claimed_on, null);
  });

  it('refuses a device that is already enrolled elsewhere', async () => {
    const first = await registration();
    await post(first);

    const response = await post(await registration({ deviceId: first.deviceId }));

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'device_already_enrolled');
  });

  it('refuses a spent invite', async () => {
    const first = await registration();
    await post(first);

    const response = await post({ ...(await registration()), inviteToken: first.inviteToken });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'invalid_invite');
  });

  it('refuses a malformed registration with the validation issues', async () => {
    const response = await post(await registration({ code: 'not a code' }));

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_registration');
    assert.ok(Array.isArray(response.json().issues));
  });

  it('lets the onboarding screen check an invite, and reports it spent afterwards', async () => {
    const body = await registration();

    const before = await app.inject({ method: 'GET', url: `/invites/${body.inviteToken}` });
    await post(body);
    const after = await app.inject({ method: 'GET', url: `/invites/${body.inviteToken}` });

    assert.equal(before.statusCode, 200);
    assert.equal(before.json().label, 'Test PHC');
    assert.equal(after.statusCode, 404);
  });

  it('reports PostgreSQL on /health', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.json().postgres, 'reachable');
    assert.equal(response.json().schemaVersion, 3);
  });

  describe('admin email', () => {
    it('emails a code to prove the address, only for a valid invite', async () => {
      const invite = await createInvite(db.sql, 'Test PHC', 1);

      const sent = await app.inject({ method: 'POST', url: '/email-verifications', payload: { email: ' Ngozi@Example.ORG ', inviteToken: invite.token } });
      const refused = await app.inject({ method: 'POST', url: '/email-verifications', payload: { email: 'ngozi@example.org', inviteToken: 'NOTANINVITE' } });

      assert.equal(sent.statusCode, 202, sent.body);
      assert.equal(sent.json().sentTo, 'n•••@example.org');
      assert.match(lastCodeSentTo('ngozi@example.org'), /^\d{6}$/);
      assert.equal(refused.statusCode, 404);
    });

    it('registers with the code that was emailed', async () => {
      const body = { ...(await registration()), adminEmail: 'ngozi@example.org' };
      await app.inject({ method: 'POST', url: '/email-verifications', payload: { email: 'ngozi@example.org', inviteToken: body.inviteToken } });

      const response = await post({ ...body, emailCode: lastCodeSentTo('ngozi@example.org') });

      assert.equal(response.statusCode, 201, response.body);
    });

    it('refuses a wrong email code without spending the invite', async () => {
      const body = await registration();
      const wrong = body.emailCode === '000000' ? '000001' : '000000';

      const response = await post({ ...body, emailCode: wrong });
      const invite = await app.inject({ method: 'GET', url: `/invites/${body.inviteToken}` });

      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'invalid_email_code');
      assert.equal(invite.statusCode, 200);
    });

    it('stops accepting a code after five wrong guesses, even the right one', async () => {
      const body = await registration();
      const wrong = body.emailCode === '000000' ? '000001' : '000000';
      for (let attempt = 0; attempt < 5; attempt += 1) await post({ ...body, emailCode: wrong });

      assert.equal((await post(body)).statusCode, 403);
    });

    it('keeps the admin email on the server only — not in the synced staff record', async () => {
      const body = await registration();
      const result = FacilityRegistrationResult.parse((await post(body)).json());

      const [contact] = await db.sql<{ email: string }[]>`SELECT email FROM staff_contacts WHERE staff_id = ${result.admin.id}`;
      assert.equal(contact?.email, 'amaka@example.org');
      assert.equal(JSON.stringify(result.admin).includes('@'), false);
      const published = await db.sql`SELECT 1 FROM pg_publication_tables WHERE tablename = 'staff_contacts'`;
      assert.equal(published.length, 0);
    });
  });
});
