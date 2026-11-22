import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, Staff } from '#shared';
import { issuePinSetupCode } from '../src/staff/pinSetupCodes.ts';
import {
  addStaff,
  asDevice,
  lastCodeSentTo,
  registerScratchFacility,
  scratchDatabase,
  staffSessionFor,
  testApp,
  type ScratchDatabase,
} from './postgres.ts';

/**
 * Who may bind a contact or hand out PIN authority. The enrolled device proves
 * which facility; only a PIN-proven (or emailed-code) session proves which
 * person. A staff id the device merely asserts in `x-actor-staff-id` must
 * never be enough to point someone's email at a new inbox, read it unmasked,
 * or issue a PIN code in an administrator's name — otherwise anyone holding a
 * facility phone could take over a colleague's account.
 *
 * First activation is the exception that must keep working: a new member of
 * staff has no PIN and no session, and registers one with a single-use setup
 * code alone.
 */
describe('contact binding and PIN authority need a server-verified person', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let f: FacilityRegistrationResult;
  let nurse: Staff;
  let clerk: Staff;
  const device = () => asDevice(f.device.credential);
  const asserting = (staffId: string) => ({ ...device(), 'x-actor-staff-id': staffId });
  const post = (url: string, payload: unknown, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers });
  const withSession = async (staffId: string) => ({
    ...device(),
    'x-staff-session': (await staffSessionFor(app, f.device.credential, staffId))!,
  });
  const emailOf = async (staffId: string) =>
    (
      await db.sql<
        { email: string }[]
      >`SELECT email FROM staff_contacts WHERE staff_id = ${staffId}`
    )[0]?.email;

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

  describe("a person's own email", () => {
    it('cannot be bound by a device asserting who is signed in', async () => {
      assert.equal(
        (
          await post(
            '/staff/me/email/code',
            { staffId: nurse.id, email: 'intruder@example.org' },
            device(),
          )
        ).statusCode,
        202,
      );
      const spoofed = await post(
        '/staff/me/email',
        {
          staffId: nurse.id,
          email: 'intruder@example.org',
          code: lastCodeSentTo('intruder@example.org'),
        },
        asserting(nurse.id),
      );
      assert.equal(spoofed.statusCode, 403, spoofed.body);
      assert.equal(spoofed.json().error, 'staff_session_required');
      assert.equal(await emailOf(nurse.id), undefined, 'nothing was bound');
    });

    it("is bound with the person's own PIN-proven session", async () => {
      await post(
        '/staff/me/email/code',
        { staffId: nurse.id, email: 'nurse@example.org' },
        device(),
      );
      const own = await post(
        '/staff/me/email',
        {
          staffId: nurse.id,
          email: 'nurse@example.org',
          code: lastCodeSentTo('nurse@example.org'),
        },
        await withSession(nurse.id),
      );
      assert.equal(own.statusCode, 200, own.body);
      assert.deepEqual(own.json(), { status: 'verified' });
      assert.equal(await emailOf(nurse.id), 'nurse@example.org');
    });

    it('is shown unmasked only to its verified owner', async () => {
      assert.notEqual(
        (await post('/staff/me/email/status', { staffId: nurse.id }, asserting(nurse.id))).json()
          .email,
        'nurse@example.org',
      );
      assert.equal(
        (
          await post('/staff/me/email/status', { staffId: nurse.id }, await withSession(nurse.id))
        ).json().email,
        'nurse@example.org',
      );
    });
  });

  describe("a facility admin's recovery email", () => {
    it('cannot be added or replaced from the device alone', async () => {
      await db.sql`DELETE FROM staff_contacts WHERE staff_id = ${f.admin.id}`;
      const request = await post(
        `/staff/${f.admin.id}/email/code`,
        { email: 'intruder@example.org', requestedBy: f.admin.id },
        asserting(f.admin.id),
      );
      assert.equal(request.statusCode, 403, request.body);
      assert.equal(request.json().error, 'staff_session_required');
      const confirm = await post(
        `/staff/${f.admin.id}/email`,
        { email: 'intruder@example.org', code: '123456', requestedBy: f.admin.id },
        asserting(f.admin.id),
      );
      assert.equal(confirm.statusCode, 403);
      assert.equal(await emailOf(f.admin.id), undefined);
    });

    it('is added by the admin in their own verified session', async () => {
      const session = await withSession(f.admin.id);
      assert.equal(
        (
          await post(
            `/staff/${f.admin.id}/email/code`,
            { email: 'admin.again@example.org', requestedBy: f.admin.id },
            session,
          )
        ).statusCode,
        202,
      );
      const saved = await post(
        `/staff/${f.admin.id}/email`,
        {
          email: 'admin.again@example.org',
          code: lastCodeSentTo('admin.again@example.org'),
          requestedBy: f.admin.id,
        },
        session,
      );
      assert.equal(saved.statusCode, 204, saved.body);
      assert.equal(await emailOf(f.admin.id), 'admin.again@example.org');
    });

    it("cannot be set by someone else's verified session", async () => {
      const response = await post(
        `/staff/${f.admin.id}/email/code`,
        { email: 'x@example.org', requestedBy: f.admin.id },
        await withSession(nurse.id),
      );
      assert.equal(response.statusCode, 403);
    });
  });

  describe('issuing a PIN setup code', () => {
    it('is refused when the administrator is only asserted by the device', async () => {
      const response = await post(
        `/staff/${clerk.id}/pin-codes`,
        { issuedBy: f.admin.id },
        asserting(f.admin.id),
      );
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().error, 'staff_session_required');
      assert.equal(
        (await db.sql`SELECT 1 FROM pin_setup_codes WHERE staff_id = ${clerk.id}`).length,
        0,
      );
    });

    it('is refused when the body names someone other than the verified person', async () => {
      const response = await post(
        `/staff/${clerk.id}/pin-codes`,
        { issuedBy: f.admin.id },
        await withSession(nurse.id),
      );
      assert.equal(response.statusCode, 403);
    });

    it('works for an administrator in their own verified session', async () => {
      const response = await post(
        `/staff/${clerk.id}/pin-codes`,
        { issuedBy: f.admin.id },
        await withSession(f.admin.id),
      );
      assert.equal(response.statusCode, 201, response.body);
      assert.match(response.json().code, /^[A-Z2-9]{8}$/);
    });
  });

  describe('first activation', () => {
    it('needs no existing PIN or session: a single-use setup code is the proof', async () => {
      const newcomer = await addStaff(db.sql, f, { role: 'nurse', name: 'New Nurse' });
      const issued = await issuePinSetupCode(db.sql, {
        facilityId: f.facility.id,
        staffId: newcomer.id,
        issuedBy: f.admin.id,
        issuedFrom: f.device.deviceId,
      });
      assert.ok(issued.ok);
      const enrolled = await post(
        '/staff/session/enrol',
        { staffId: newcomer.id, pin: '482916', setupCode: issued.code },
        device(),
      );
      assert.equal(enrolled.statusCode, 200, enrolled.body);
      assert.ok(enrolled.json().token, 'activation opens a verified session');
      assert.equal(
        (await post('/staff/session', { staffId: newcomer.id, pin: '482916' }, device()))
          .statusCode,
        200,
        'the PIN now signs in with the server',
      );
    });

    it("refuses a wrong or someone else's setup code", async () => {
      const other = await addStaff(db.sql, f, { role: 'nurse' });
      const issued = await issuePinSetupCode(db.sql, {
        facilityId: f.facility.id,
        staffId: other.id,
        issuedBy: f.admin.id,
        issuedFrom: f.device.deviceId,
      });
      assert.ok(issued.ok);
      assert.equal(
        (
          await post(
            '/staff/session/enrol',
            { staffId: clerk.id, pin: '482916', setupCode: issued.code },
            device(),
          )
        ).json().error,
        'invalid_setup_code',
      );
      assert.equal(
        (
          await post(
            '/staff/session/enrol',
            { staffId: other.id, pin: '482916', setupCode: 'ABCDEFGH' },
            device(),
          )
        ).json().error,
        'invalid_setup_code',
      );
    });
  });

  describe('pending email confirmations', () => {
    it('are listed and decided only by a verified administrator', async () => {
      assert.equal(
        (await post('/staff/email-requests/list', {}, asserting(f.admin.id))).statusCode,
        403,
      );
      assert.equal(
        (await post('/staff/email-requests/list', {}, await withSession(f.admin.id))).statusCode,
        200,
      );
    });
  });
});
