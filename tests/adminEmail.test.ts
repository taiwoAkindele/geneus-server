import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, PinSetupCode, Staff } from '#shared';
import { fromRow } from '../src/db/records.ts';
import { hashPinSetupCode } from '../src/staff/pinSetupCodes.ts';
import { addStaff, asDevice, lastCodeSentTo, mailbox, registerScratchFacility, scratchDatabase, testApp, type ScratchDatabase } from './postgres.ts';

/**
 * A facility admin's recovery email, and the PIN code sent to it (SCHEMA.md
 * §10). The server knows the phone, not who holds it, so what is under test is
 * that every code lands only in the admin's own inbox — and that a phone in the
 * wrong hands cannot point recovery at a new inbox.
 */
describe('admin recovery email', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let a: FacilityRegistrationResult;
  let b: FacilityRegistrationResult;
  let nurse: Staff;

  const asA = () => asDevice(a.device.credential);
  const requestCode = (staffId: string, email: string, requestedBy = staffId) =>
    app.inject({ method: 'POST', url: `/staff/${staffId}/email/code`, headers: asA(), payload: { email, requestedBy } });
  const confirm = (staffId: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/staff/${staffId}/email`, headers: asA(), payload: { requestedBy: staffId, ...payload } });
  const emailPinCode = (staffId: string, credential = a.device.credential) =>
    app.inject({ method: 'POST', url: `/staff/${staffId}/pin-codes/email`, headers: asDevice(credential) });
  const contactOf = async (staffId: string) =>
    (await db.sql<{ email: string }[]>`SELECT email FROM staff_contacts WHERE staff_id = ${staffId}`)[0]?.email;

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

  describe('a PIN code by email', () => {
    it('sends the admin a working PIN setup code at their recovery email', async () => {
      const response = await emailPinCode(a.admin.id);

      assert.equal(response.statusCode, 202, response.body);
      assert.equal(response.json().sentTo, 'a•••@example.org');
      const code = lastCodeSentTo('admin@example.org');
      const [row] = await db.sql<Record<string, unknown>[]>`
        SELECT * FROM pin_setup_codes WHERE staff_id = ${a.admin.id} AND revoked_on IS NULL AND used_on IS NULL`;
      const stored = fromRow<PinSetupCode>('pin_setup_code', row as Record<string, unknown>);
      assert.equal(hashPinSetupCode(code, stored.codeSalt, stored.codeIterations), stored.codeHash);
    });

    it('is only for facility admins', async () => {
      assert.equal((await emailPinCode(nurse.id)).statusCode, 404);
    });

    it('cannot reach an admin of another facility', async () => {
      assert.equal((await emailPinCode(b.admin.id)).statusCode, 404);
    });

    it('needs an enrolled device', async () => {
      assert.equal((await app.inject({ method: 'POST', url: `/staff/${a.admin.id}/pin-codes/email` })).statusCode, 401);
    });
  });

  describe('setting the recovery email', () => {
    it('refuses anyone setting an email for someone else, or a non-admin', async () => {
      assert.equal((await requestCode(a.admin.id, 'x@example.org', nurse.id)).statusCode, 403);
      assert.equal((await requestCode(nurse.id, 'x@example.org')).statusCode, 403);
    });

    it('replacing an email on file needs a code from that address too', async () => {
      const sent = await requestCode(a.admin.id, 'new@example.org');
      assert.equal(sent.statusCode, 202, sent.body);
      assert.equal(sent.json().currentSentTo, 'a•••@example.org');

      // A phone in the wrong hands has only the new inbox's code.
      const withoutCurrent = await confirm(a.admin.id, { email: 'new@example.org', code: lastCodeSentTo('new@example.org') });
      assert.equal(withoutCurrent.statusCode, 403);
      assert.equal(withoutCurrent.json().error, 'invalid_current_code');
      assert.equal(await contactOf(a.admin.id), 'admin@example.org');
    });

    it('replaces it once both codes check out', async () => {
      await requestCode(a.admin.id, 'new@example.org');

      const response = await confirm(a.admin.id, {
        email: 'new@example.org',
        code: lastCodeSentTo('new@example.org'),
        currentCode: lastCodeSentTo('admin@example.org'),
      });

      assert.equal(response.statusCode, 204, response.body);
      assert.equal(await contactOf(a.admin.id), 'new@example.org');
      const [audit] = await db.sql`SELECT metadata FROM audit_events WHERE entity_id = ${a.admin.id} AND action = 'update'`;
      assert.equal((audit?.metadata as Record<string, string>).recoveryEmail, 'replaced');
    });

    it('adds a first email with the new address\'s code alone', async () => {
      await db.sql`DELETE FROM staff_contacts WHERE staff_id = ${b.admin.id}`;
      const asB = asDevice(b.device.credential);
      await app.inject({ method: 'POST', url: `/staff/${b.admin.id}/email/code`, headers: asB, payload: { email: 'first@example.org', requestedBy: b.admin.id } });
      const before = mailbox.length;

      const response = await app.inject({
        method: 'POST',
        url: `/staff/${b.admin.id}/email`,
        headers: asB,
        payload: { email: 'first@example.org', code: lastCodeSentTo('first@example.org'), requestedBy: b.admin.id },
      });

      assert.equal(response.statusCode, 204, response.body);
      assert.equal(await contactOf(b.admin.id), 'first@example.org');
      assert.equal(mailbox.length, before);
    });

    it('says so when an admin has no recovery email', async () => {
      await db.sql`DELETE FROM staff_contacts WHERE staff_id = ${b.admin.id}`;
      const response = await emailPinCode(b.admin.id, b.device.credential);

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error, 'no_recovery_email');
    });
  });
});
