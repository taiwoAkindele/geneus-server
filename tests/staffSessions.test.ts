import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  POLICY_VERSION,
  type FacilityRegistrationResult,
  type FeeItem,
  type Staff,
  type UploadMutation,
} from '#shared';
import { findRecord } from '../src/db/records.ts';
import {
  addStaff,
  asDevice,
  clientId,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
  testApp,
  type ScratchDatabase,
  invitationCodeFor,
  staffSessionFor,
} from './postgres.ts';

/**
 * Server-verified staff identity and online configuration. Every request here
 * goes through the real routes against PostgreSQL — no test shortcuts.
 */
describe('server-verified staff sessions and online configuration', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let f: FacilityRegistrationResult;
  let nurse: Staff;
  let clerk: Staff;

  const VERSIONS = {
    facilityContractVersion: 1,
    schemaVersion: 5,
    policyVersion: POLICY_VERSION,
  } as const;

  const device = () => asDevice(f.device.credential);

  const post = (url: string, payload: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: { ...device(), ...(token ? { 'x-staff-session': token } : {}) },
    });

  let invited = 0;

  /** Invites the person by email, as an administrator does, and returns the code that accepts it. */
  const codeFor = async (staffId: string) => {
    const email = `invited-${(invited += 1)}@example.org`;
    const admin = await staffSessionFor(app, f.device.credential, f.admin.id);

    const sent = await post(`/staff/${staffId}/invitations`, { channel: 'email', email }, admin);
    assert.equal(sent.statusCode, 201, sent.body);

    return invitationCodeFor(db.sql, email);
  };

  const enrol = async (staffId: string, pin: string) => {
    const r = await post('/staff/session/enrol', {
      staffId,
      pin,
      setupCode: await codeFor(staffId),
    });

    assert.equal(r.statusCode, 200, r.body);

    return r.json().token as string;
  };

  const signIn = (staffId: string, pin: string) => post('/staff/session', { staffId, pin });

  const fee = (
    id: string,
    by: Staff | FacilityRegistrationResult['admin'],
    amountMinor = 150_000,
  ): UploadMutation => ({
    clientId: Date.now() * 1000 + clientId(),
    op: 'put',
    table: 'fee_item',
    id,
    data: {
      ...envelopeFor(f),
      createdBy: by.id,
      schemaVersion: 5,
      type: 'fee_item',
      name: 'Consultation',
      category: 'consultation',
      amountMinor,
      currency: 'NGN',
      chargeWhen: 'when_ordered',
    },
  });

  const save = (mutations: UploadMutation[], token?: string) =>
    post('/config/save', { transactionId: null, ...VERSIONS, mutations }, token);

  before(async () => {
    db = await scratchDatabase();
    f = await registerScratchFacility(db.sql);
    app = testApp(db.sql);
    nurse = await addStaff(db.sql, f, { role: 'nurse', name: 'Nkem Nurse' });
    clerk = await addStaff(db.sql, f, { role: 'records_officer', name: 'Remi Records' });
  });

  after(async () => {
    if (app) {
      await app.close();
    }

    if (db) {
      await db.drop();
    }
  });

  describe('who is acting: the server checks the PIN, not the device', () => {
    it('registers a PIN only with proof from a password sign-in or an emailed invitation', async () => {
      const person = await addStaff(db.sql, f, { role: 'nurse', name: 'Pelu Nurse' });

      assert.equal(
        (await signIn(person.id, '246810')).json().error,
        'pin_not_enrolled',
        'a PIN the server has never seen proves nothing',
      );

      assert.equal(
        (
          await post('/staff/session/enrol', {
            staffId: person.id,
            pin: '246810',
            setupCode: 'WRONG-CODE',
          })
        ).json().error,
        'invalid_setup_code',
      );

      const byEmailCode = await post('/staff/session/enrol', {
        staffId: person.id,
        pin: '246810',
        emailCode: '123456',
      });

      assert.equal(byEmailCode.statusCode, 400, 'an emailed code alone is no longer a proof');

      const enrolled = await post('/staff/session/enrol', {
        staffId: person.id,
        pin: '246810',
        setupCode: await codeFor(person.id),
      });

      assert.equal(enrolled.statusCode, 200, enrolled.body);
      assert.ok(enrolled.json().token);
      assert.ok(
        (await db.sql`SELECT 1 FROM audit_events WHERE metadata->>'context' = 'staff_pin_enrolled'`)
          .length,
      );
    });

    it('opens a session from the right PIN, and locks out after repeated wrong ones', async () => {
      await enrol(nurse.id, '111222');
      assert.equal((await signIn(nurse.id, '111222')).statusCode, 200);

      for (let i = 0; i < 4; i++) {
        assert.equal((await signIn(nurse.id, '000000')).json().error, 'wrong_pin');
      }

      assert.equal((await signIn(nurse.id, '000000')).json().error, 'locked');
      assert.equal(
        (await signIn(nurse.id, '111222')).json().error,
        'locked',
        'even the right PIN waits out the lockout',
      );

      await db.sql`UPDATE staff_device_pins SET locked_until = NULL, failures = 0 WHERE staff_id = ${nurse.id}`;
    });

    it("on a shared device, the next person's sign-in ends the previous person's session at once", async () => {
      const admin = (await staffSessionFor(app, f.device.credential, f.admin.id))!;
      assert.equal((await post('/insurance/setup/status', {}, admin)).statusCode, 200);
      await signIn(nurse.id, '111222');
      const after = await post('/insurance/setup/status', {}, admin);
      assert.equal(
        after.json().error,
        'staff_session_required',
        "the administrator's privileges are gone once the nurse signs in",
      );
    });

    it('ends when idle, when signed out, and applies deactivation and permission changes immediately', async () => {
      let admin = (await staffSessionFor(app, f.device.credential, f.admin.id))!;
      await db.sql`UPDATE staff_sessions SET last_used_on = now() - interval '31 minutes' WHERE ended_on IS NULL`;
      assert.equal(
        (await post('/insurance/setup/status', {}, admin)).json().error,
        'staff_session_required',
        'idle sessions end',
      );

      admin = (await staffSessionFor(app, f.device.credential, f.admin.id))!;
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/staff/session/end',
            headers: { ...device(), 'x-staff-session': admin },
          })
        ).statusCode,
        204,
      );

      assert.equal(
        (await post('/insurance/setup/status', {}, admin)).json().error,
        'staff_session_required',
        'signing out ends it',
      );

      const nurseToken = (await signIn(nurse.id, '111222')).json().token;
      assert.equal(
        (await post('/insurance/setup/status', {}, nurseToken)).statusCode,
        403,
        'a nurse holds no insurance setup permission',
      );

      await db.sql`UPDATE staff SET active = false WHERE id = ${nurse.id}`;
      assert.equal(
        (await post('/staff/me/email/status', { staffId: nurse.id }, nurseToken)).statusCode,
        404,
      );

      assert.equal(
        (await signIn(nurse.id, '111222')).json().error,
        'unknown_staff',
        'a deactivated person cannot sign in',
      );

      await db.sql`UPDATE staff SET active = true WHERE id = ${nurse.id}`;
    });
  });

  describe('configuration is saved online, by a verified person, or not at all', () => {
    it('refuses configuration from the offline queue, while daily records still sync offline', async () => {
      const queued = await app.inject({
        method: 'POST',
        url: '/sync/upload',
        headers: device(),
        payload: { transactionId: 1, ...VERSIONS, mutations: [fee('fee_item:queued', f.admin)] },
      });

      assert.equal(queued.statusCode, 200);
      assert.equal(queued.json().rejected[0].category, 'authorization');
      assert.match(queued.json().rejected[0].reason, /saved online/);
      assert.equal(await findRecord(db.sql, 'fee_item', 'fee_item:queued'), undefined);
    });

    it('needs the person signed in on the device, in their own name, for configuration only', async () => {
      assert.equal(
        (await save([fee('fee_item:a', f.admin)])).json().error,
        'staff_session_required',
        'someone must be signed in',
      );

      const unknown = await app.inject({
        method: 'POST',
        url: '/config/save',
        headers: { ...device(), 'x-actor-staff-id': 'staff:nobody' },
        payload: { transactionId: null, ...VERSIONS, mutations: [fee('fee_item:a', f.admin)] },
      });

      assert.equal(unknown.json().error, 'staff_session_required', 'an unknown person is refused');
      const admin = (await staffSessionFor(app, f.device.credential, f.admin.id))!;
      assert.equal(
        (await save([fee('fee_item:a', clerk)], admin)).json().error,
        'attribution_mismatch',
        "nobody saves in another person's name",
      );

      const patient = {
        clientId: clientId(),
        op: 'put',
        table: 'patient',
        id: 'p',
        data: {},
      } as unknown as UploadMutation;

      assert.equal((await save([patient], admin)).json().error, 'not_configuration');
      const saved = await save([fee('fee_item:a', f.admin)], admin);
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(
        (await findRecord<FeeItem>(db.sql, 'fee_item', 'fee_item:a'))?.amountMinor,
        150_000,
        'saved and confirmed by the server',
      );
    });

    it("checks the person's permission on the server, whatever the screen allowed", async () => {
      await enrol(clerk.id, '333444');
      const clerkToken = (await signIn(clerk.id, '333444')).json().token;
      const refused = await save([fee('fee_item:clerk', clerk)], clerkToken);
      assert.equal(refused.statusCode, 409);
      assert.equal(refused.json().details.rejected[0].category, 'authorization');
    });

    it('refuses a change made from an outdated view instead of overwriting the newer one', async () => {
      const admin = (await staffSessionFor(app, f.device.credential, f.admin.id))!;

      const patch = (amountMinor: number, previous: number): UploadMutation => ({
        clientId: Date.now() * 1000 + clientId(),
        op: 'patch',
        table: 'fee_item',
        id: 'fee_item:a',
        data: { amountMinor, updatedBy: f.admin.id, updatedOn: new Date().toISOString() },
        previous: { amountMinor: previous },
      });

      assert.equal((await save([patch(200_000, 150_000)], admin)).statusCode, 200);
      const stale = await save([patch(175_000, 150_000)], admin);
      assert.equal(stale.json().details.rejected[0].category, 'conflict');
      assert.equal(
        (await findRecord<FeeItem>(db.sql, 'fee_item', 'fee_item:a'))?.amountMinor,
        200_000,
        'the newer saved value stands',
      );
    });
  });
});
