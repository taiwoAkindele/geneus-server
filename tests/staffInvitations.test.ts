import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, Staff } from '#shared';
import { buildApp } from '../src/app.ts';
import { EmailNotSent, type Mailer } from '../src/lib/email.ts';
import {
  addStaff,
  asDevice,
  config,
  invitationCodeFor,
  mailbox,
  registerScratchFacility,
  scratchDatabase,
  signer,
  staffSessionFor,
  testApp,
  type ScratchDatabase,
} from './postgres.ts';

/**
 * Staff invitations by email (SCHEMA.md §10): a PIN setup code sent to an
 * address the administrator entered. What is under test is the lifecycle the
 * server records — created, delivered (as the provider said), accepted online,
 * expired, revoked, resent — and that none of it leaks the code, redirects a
 * proven contact, crosses a facility or grants anything beyond the staff
 * record's own access.
 */
describe('staff invitations by email', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let a: FacilityRegistrationResult;
  let b: FacilityRegistrationResult;
  let supervisor: Staff;
  let nurse: Staff;

  const device = (f = a) => asDevice(f.device.credential);

  const as = async (staffId: string, f = a) => ({
    ...device(f),
    'x-staff-session': (await staffSessionFor(app, f.device.credential, staffId))!,
  });

  const post = (url: string, payload: unknown, headers: Record<string, string>, on = app) =>
    on.inject({ method: 'POST', url, payload: payload as object, headers });

  const invite = async (staffId: string, email: string, by = a.admin.id, f = a, on = app) =>
    post(`/staff/${staffId}/invitations`, { channel: 'email', email }, await as(by, f), on);

  const enrol = (staffId: string, setupCode: string, f = a, pin = '583920') =>
    post('/staff/session/enrol', { staffId, pin, setupCode }, device(f));

  const check = (staffId: string, code: string, f = a) =>
    post(`/staff/${staffId}/invitations/check`, { code }, device(f));

  const status = async (staffId: string) =>
    (await post(`/staff/${staffId}/contact-activation`, {}, await as(a.admin.id))).json();

  const emailOf = async (staffId: string) =>
    (
      await db.sql<
        { email: string }[]
      >`SELECT email FROM staff_contacts WHERE staff_id = ${staffId}`
    )[0]?.email;

  /** Lets the next invitation to this person through the resend cooldown, as a minute passing would. */
  const aMinutePasses = (staffId: string) =>
    db.sql`UPDATE staff_invitations SET created_on = created_on - interval '2 minutes' WHERE staff_id = ${staffId}`;

  /** The token from the newest invitation link emailed to `to` — what tapping "Accept invitation" opens. */
  const lastLinkSentTo = (to: string) => {
    const text = [...mailbox].reverse().find((m) => m.to === to)?.text ?? '';
    const token = text.match(/\/onboarding\/invitation#token=([\w-]+)/)?.[1];

    if (!token) {
      throw new Error(`no invitation link was emailed to ${to}`);
    }

    return token;
  };

  const newcomer = (name: string, f = a) => addStaff(db.sql, f, { role: 'nurse', name });

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    [a, b] = await Promise.all([registerScratchFacility(db.sql), registerScratchFacility(db.sql)]);
    supervisor = await addStaff(db.sql, a, { role: 'supervisor', name: 'Sade Supervisor' });
    nurse = await addStaff(db.sql, a, { role: 'nurse', name: 'Nkem Nurse' });
  });

  after(async () => {
    if (app) {
      await app.close();
    }

    if (db) {
      await db.drop();
    }
  });

  describe('sending', () => {
    it('emails the link to the address, and never shows a code to the administrator', async () => {
      const person = await newcomer('Ada Newcomer');
      const sent = await invite(person.id, ' Ada@Example.org ');
      assert.equal(sent.statusCode, 201, sent.body);
      assert.ok(lastLinkSentTo('ada@example.org'), 'the email carries the link');
      const code = await invitationCodeFor(db.sql, 'ada@example.org');
      assert.ok(!sent.body.includes(code), 'the answer does not contain the code');
      const { invitation } = sent.json();
      assert.equal(invitation.destination, 'ada@example.org', 'normalised to lower case');
      assert.equal(invitation.status, 'pending');
      assert.equal(
        invitation.delivery,
        'provider_accepted',
        'the provider took it — not "delivered"',
      );

      assert.ok(!JSON.stringify(await status(person.id)).includes(code), 'nor does the profile');

      const [row] =
        await db.sql`SELECT code_hash FROM staff_invitations WHERE id = ${invitation.id}`;

      assert.notEqual(row.code_hash, code, 'only a hash is stored');
      assert.ok(
        (
          await db.sql`SELECT 1 FROM audit_events WHERE metadata->>'context' = 'staff_invitation_created' AND entity_id = ${person.id}`
        ).length,
      );
    });

    it('needs an administrator proven by their own session, with authority over the person', async () => {
      const person = await newcomer('Chidi Newcomer');

      const asserted = await post(
        `/staff/${person.id}/invitations`,
        { channel: 'email', email: 'chidi@example.org' },
        { ...device(), 'x-actor-staff-id': a.admin.id },
      );

      assert.equal(asserted.json().error, 'staff_session_required');
      assert.equal(
        (await invite(person.id, 'chidi@example.org', nurse.id)).json().error,
        'forbidden',
        'a nurse cannot manage staff',
      );

      const admin2 = await addStaff(db.sql, a, { role: 'facility_admin', name: 'Second Admin' });
      assert.equal(
        (await invite(admin2.id, 'admin2@example.org', supervisor.id)).statusCode,
        403,
        'a supervisor cannot invite an administrator',
      );

      assert.equal((await invite(a.admin.id, 'me@example.org')).json().error, 'own_account');
      assert.equal(
        (
          await db.sql`SELECT 1 FROM staff_invitations WHERE staff_id IN (${person.id}, ${admin2.id}, ${a.admin.id})`
        ).length,
        0,
      );
    });

    it('records when the provider refuses the message, and a development server that only logged it', async () => {
      const failing: Mailer = {
        configured: true,
        send: async () => {
          throw new EmailNotSent('Resend answered 422: domain not verified');
        },
      };

      const logOnly: Mailer = { configured: false, send: async () => undefined };

      const failingApp = buildApp(
        { config, sql: db.sql, signer, mailer: failing },
        { logger: false, rateLimit: false },
      );

      const logApp = buildApp(
        { config, sql: db.sql, signer, mailer: logOnly },
        { logger: false, rateLimit: false },
      );

      try {
        const refused = await invite(
          (await newcomer('Dayo Newcomer')).id,
          'dayo@example.org',
          a.admin.id,
          a,
          failingApp,
        );

        assert.equal(refused.statusCode, 201, refused.body);
        assert.equal(refused.json().invitation.delivery, 'provider_rejected');

        const [row] =
          await db.sql`SELECT delivery_error FROM staff_invitations WHERE id = ${refused.json().invitation.id}`;

        assert.match(
          row.delivery_error,
          /domain not verified/,
          'the reason is kept for whoever operates the server',
        );

        const logged = await invite(
          (await newcomer('Efe Newcomer')).id,
          'efe@example.org',
          a.admin.id,
          a,
          logApp,
        );

        assert.equal(logged.json().invitation.delivery, 'not_configured', 'never reported as sent');
      } finally {
        await failingApp.close();
        await logApp.close();
      }
    });
  });

  describe('accepting', () => {
    it('activates with the code alone — no PIN or session yet — and proves the address', async () => {
      const person = await newcomer('Funke Newcomer');
      await invite(person.id, 'funke@example.org');
      const code = await invitationCodeFor(db.sql, 'funke@example.org');
      const checked = await check(person.id, code);
      assert.equal(checked.statusCode, 200, 'checking does not spend it');
      assert.deepEqual(checked.json(), { existingAccount: false }, 'a first password is chosen');
      const enrolled = await enrol(person.id, code);
      assert.equal(enrolled.statusCode, 200, enrolled.body);
      assert.ok(enrolled.json().token, 'a verified session from the first activation');
      assert.equal(
        await emailOf(person.id),
        'funke@example.org',
        'possession of the inbox is proven',
      );

      const [pin] =
        await db.sql`SELECT enrolled_by FROM staff_device_pins WHERE staff_id = ${person.id}`;

      assert.equal(pin.enrolled_by, 'invitation');
      const after = await status(person.id);
      assert.equal(after.invitation.status, 'accepted');
      assert.equal(
        after.invitation.destination,
        'f•••@example.org',
        "masked once it is the person's own email",
      );

      assert.equal(after.activation.serverPinDevices, 1);
      assert.equal(
        (await post('/staff/session', { staffId: person.id, pin: '583920' }, device())).statusCode,
        200,
        'from now on the PIN signs in — no email needed',
      );

      assert.equal((await enrol(person.id, code)).json().error, 'invalid_setup_code', 'single use');
    });

    it('grants nothing beyond the staff record: same role, no link to anyone else', async () => {
      const person = await newcomer('Gbenga Newcomer');
      await invite(person.id, 'gbenga@example.org');
      await enrol(person.id, await invitationCodeFor(db.sql, 'gbenga@example.org'));

      const [row] =
        await db.sql`SELECT role, permission, additional_roles, person_id FROM staff WHERE id = ${person.id}`;

      assert.equal(row.role, 'nurse');
      assert.equal(row.person_id, null, 'an invitation never links identities');
    });

    it('refuses a wrong code, and stops working after five', async () => {
      const person = await newcomer('Halima Newcomer');
      await invite(person.id, 'halima@example.org');
      const code = await invitationCodeFor(db.sql, 'halima@example.org');

      for (let i = 0; i < 5; i++) {
        assert.equal((await check(person.id, 'WRONGCDE')).statusCode, 403);
      }

      assert.equal(
        (await enrol(person.id, code)).json().error,
        'invalid_setup_code',
        'even the right code, once locked',
      );

      assert.equal((await status(person.id)).invitation.status, 'locked');
    });

    it('refuses an expired invitation', async () => {
      const person = await newcomer('Ike Newcomer');
      await invite(person.id, 'ike@example.org');
      await db.sql`UPDATE staff_invitations SET expires_on = now() - interval '1 second' WHERE staff_id = ${person.id}`;
      assert.equal(
        (await enrol(person.id, await invitationCodeFor(db.sql, 'ike@example.org'))).json().error,
        'invalid_setup_code',
      );

      assert.equal((await status(person.id)).invitation.status, 'expired');
      assert.equal(await emailOf(person.id), undefined);
    });

    it('refuses a revoked invitation', async () => {
      const person = await newcomer('Jide Newcomer');
      await invite(person.id, 'jide@example.org');

      const revoked = await post(
        `/staff/${person.id}/invitations/revoke`,
        {},
        await as(a.admin.id),
      );

      assert.equal(revoked.statusCode, 200, revoked.body);
      assert.equal(
        (await enrol(person.id, await invitationCodeFor(db.sql, 'jide@example.org'))).json().error,
        'invalid_setup_code',
      );

      const after = await status(person.id);
      assert.equal(after.invitation.status, 'revoked');
      assert.equal(after.invitation.revokedReason, 'revoked');
      assert.equal(
        (await post(`/staff/${person.id}/invitations/revoke`, {}, await as(a.admin.id))).statusCode,
        404,
        'nothing left to revoke',
      );
    });

    it('cannot be used for another person, or at another facility', async () => {
      const person = await newcomer('Kemi Newcomer');
      await invite(person.id, 'kemi@example.org');
      const code = await invitationCodeFor(db.sql, 'kemi@example.org');
      assert.equal((await enrol(nurse.id, code)).json().error, 'invalid_setup_code');
      assert.equal(
        (await check(person.id, code, b)).statusCode,
        403,
        "another facility's device does not find them",
      );

      assert.equal((await enrol(person.id, code, b)).statusCode, 404);
      assert.equal(
        (await invite(person.id, 'kemi@example.org', b.admin.id, b)).statusCode,
        404,
        "nor can another facility's admin invite them",
      );

      assert.equal(
        (await enrol(person.id, code)).statusCode,
        200,
        'still good at their own facility',
      );
    });
  });

  describe('resending', () => {
    it('replaces the earlier code, after a short wait', async () => {
      const person = await newcomer('Lola Newcomer');
      await invite(person.id, 'lola@example.org');
      const first = await invitationCodeFor(db.sql, 'lola@example.org');
      const soon = await invite(person.id, 'lola@example.org');
      assert.equal(soon.statusCode, 429);
      assert.equal(soon.json().error, 'too_soon');
      assert.ok(Number(soon.headers['retry-after']) > 0);
      await aMinutePasses(person.id);
      assert.equal((await invite(person.id, 'lola@example.org')).statusCode, 201);
      const second = await invitationCodeFor(db.sql, 'lola@example.org');
      assert.equal(
        (await enrol(person.id, first)).json().error,
        'invalid_setup_code',
        'the earlier code no longer works',
      );

      const [old] =
        await db.sql`SELECT revoked_reason FROM staff_invitations WHERE staff_id = ${person.id} ORDER BY created_on LIMIT 1`;

      assert.equal(old.revoked_reason, 'resent');
      assert.equal((await enrol(person.id, second)).statusCode, 200);
    });

    it('counts its limits in the database, so a restarted server still applies them', async () => {
      const person = await newcomer('Musa Newcomer');
      await invite(person.id, 'musa@example.org');
      const restarted = testApp(db.sql);

      try {
        assert.equal(
          (await invite(person.id, 'musa@example.org', a.admin.id, a, restarted)).json().error,
          'too_soon',
        );
      } finally {
        await restarted.close();
      }

      for (let i = 0; i < 4; i++) {
        await aMinutePasses(person.id);
        assert.equal((await invite(person.id, 'musa@example.org')).statusCode, 201);
      }

      await aMinutePasses(person.id);
      assert.equal((await invite(person.id, 'musa@example.org')).json().error, 'daily_limit');
    });
  });

  describe('contacts', () => {
    it('refuses an address another active member of staff here already uses', async () => {
      const first = await newcomer('Ola Newcomer');
      const second = await newcomer('Ola Twin');
      await invite(first.id, 'shared@example.org');
      assert.equal(
        (await invite(second.id, 'shared@example.org')).json().error,
        'email_in_use',
        'while the first invitation waits',
      );

      await enrol(first.id, await invitationCodeFor(db.sql, 'shared@example.org'));
      assert.equal(
        (await invite(second.id, 'Shared@Example.org')).json().error,
        'email_in_use',
        'and once it is proven',
      );
    });

    it('never redirects a proven address: invitations go only to it', async () => {
      const person = await newcomer('Pelumi Newcomer');
      await db.sql`INSERT INTO staff_contacts (facility_id, staff_id, email, verified_on) VALUES (${a.facility.id}, ${person.id}, 'pelumi@example.org', now())`;
      assert.equal(
        (await invite(person.id, 'someone.else@example.org')).json().error,
        'contact_change_required',
      );

      assert.equal(
        (await invite(person.id, 'pelumi@example.org')).statusCode,
        201,
        'their own proven address is fine',
      );

      assert.equal(await emailOf(person.id), 'pelumi@example.org');
      // The administrator sees it only masked, so a resend may leave the address out.
      await aMinutePasses(person.id);

      const resent = await post(
        `/staff/${person.id}/invitations`,
        { channel: 'email' },
        await as(a.admin.id),
      );

      assert.equal(resent.statusCode, 201, resent.body);
      assert.equal(
        resent.json().invitation.destination,
        'p•••@example.org',
        'a proven address stays masked to the administrator',
      );

      assert.ok(lastLinkSentTo('pelumi@example.org'), 'but the email went to the real address');

      const nobody = await newcomer('Quadri Newcomer');
      assert.equal(
        (
          await post(`/staff/${nobody.id}/invitations`, { channel: 'email' }, await as(a.admin.id))
        ).json().error,
        'email_required',
      );
    });

    it('keeps a different address the person proved in the meantime', async () => {
      const person = await newcomer('Rotimi Newcomer');
      await invite(person.id, 'rotimi.old@example.org');
      await db.sql`INSERT INTO staff_contacts (facility_id, staff_id, email, verified_on) VALUES (${a.facility.id}, ${person.id}, 'rotimi@example.org', now())`;
      assert.equal(
        (await enrol(person.id, await invitationCodeFor(db.sql, 'rotimi.old@example.org')))
          .statusCode,
        200,
        'activation still works',
      );

      assert.equal(
        await emailOf(person.id),
        'rotimi@example.org',
        'the existing verified email is kept',
      );

      const [audit] =
        await db.sql`SELECT metadata FROM audit_events WHERE metadata->>'context' = 'staff_invitation_accepted' AND entity_id = ${person.id}`;

      assert.equal((audit.metadata as Record<string, string>).contact, 'kept_existing');
    });

    it('leaves existing staff and their verified emails untouched', async () => {
      assert.equal(await emailOf(a.admin.id), 'admin@example.org');

      const summaries = (await post('/staff/invitations/list', {}, await as(a.admin.id))).json()
        .staff as { staffId: string; activated: boolean; invitation?: unknown }[];

      const existing = summaries.find((s) => s.staffId === nurse.id);
      assert.equal(existing?.activated, true, 'their server-registered PIN still counts');
      assert.equal(
        existing?.invitation,
        undefined,
        'someone never invited has no invitation state',
      );
    });
  });

  it('lists who needs attention for the Staff directory', async () => {
    const person = await newcomer('Seun Newcomer');
    await invite(person.id, 'seun@example.org');
    await db.sql`UPDATE staff_invitations SET expires_on = now() - interval '1 second' WHERE staff_id = ${person.id}`;

    const summaries = (await post('/staff/invitations/list', {}, await as(a.admin.id))).json()
      .staff as { staffId: string; activated: boolean; invitation?: { status: string } }[];

    const seun = summaries.find((s) => s.staffId === person.id);
    assert.equal(seun?.invitation?.status, 'expired');
    assert.equal(seun?.activated, false);
    assert.equal(mailbox.filter((m) => m.to === 'seun@example.org').length, 1);
  });

  describe('invitation links', () => {
    const inviteWithDevice = async (staffId: string, email: string, by = a.admin.id) =>
      post(
        `/staff/${staffId}/invitations`,
        { channel: 'email', email, allowNewDevice: true },
        await as(by),
      );

    const open = (token: string) => post('/invitations/link/open', { token }, {});
    const linkCode = (token: string, f = a) => post('/invitations/link/code', { token }, device(f));

    const newDevice = (token: string, deviceId: string, deviceLabel = 'Ward 2 phone') =>
      post('/invitations/link/device', { token, deviceId, deviceLabel }, {});

    // The suite has sent many invitations from this facility; start these with the hourly facility limit's hour passed.
    before(
      () =>
        db.sql`UPDATE staff_invitations SET created_on = created_on - interval '2 hours' WHERE facility_id = ${a.facility.id}`,
    );

    it('emails a link whose token is in the fragment, never a code to type, and stores only a hash', async () => {
      const person = await newcomer('Tola Newcomer');
      const sent = await invite(person.id, 'tola@example.org');
      const token = lastLinkSentTo('tola@example.org');
      const text = mailbox.at(-1)!.text;
      assert.ok(!/code is/i.test(text), 'no code to type: the link leads the way');
      assert.ok(
        text.includes(`${config.corsOrigins[0]}/onboarding/invitation#token=`),
        'opens in the web app, token after #',
      );

      assert.ok(!sent.body.includes(token), 'the administrator never sees the link');

      const [row] =
        await db.sql`SELECT link_hash, allows_new_device FROM staff_invitations WHERE id = ${sent.json().invitation.id}`;

      assert.ok(row.link_hash && row.link_hash !== token, 'only a hash is stored');
      assert.equal(row.allows_new_device, false, 'no device allowance unless asked for');
      assert.equal(sent.json().invitation.allowsNewDevice, false);
    });

    it('shows who it is for without spending anything, and refuses an unknown link', async () => {
      const person = await newcomer('Uche Newcomer');
      await invite(person.id, 'uche@example.org');
      const view = (await open(lastLinkSentTo('uche@example.org'))).json();
      assert.deepEqual(
        { ...view, expiresOn: undefined },
        {
          staffId: person.id,
          staffName: 'Uche Newcomer',
          role: 'nurse',
          facilityId: a.facility.id,
          facilityName: view.facilityName,
          expiresOn: undefined,
          status: 'pending',
          newDevice: 'not_allowed',
        },
      );

      assert.equal((await status(person.id)).invitation.status, 'pending');
      assert.equal((await open('x'.repeat(43))).json().error, 'invalid_invitation');
    });

    it('on a facility device, swaps the link for a fresh one-time code that sets the PIN and accepts the invitation', async () => {
      const person = await newcomer('Vera Newcomer');
      await invite(person.id, 'vera@example.org');
      const emailed = await invitationCodeFor(db.sql, 'vera@example.org');
      const token = lastLinkSentTo('vera@example.org');
      const exchanged = await linkCode(token);
      assert.equal(exchanged.statusCode, 200, exchanged.body);
      const { staffId, code } = exchanged.json();
      assert.equal(staffId, person.id);
      assert.notEqual(code, emailed, 'a fresh code each time');
      assert.equal(
        (await check(person.id, emailed)).statusCode,
        403,
        'the earlier code is replaced',
      );

      assert.equal((await enrol(person.id, code)).statusCode, 200);
      assert.equal(
        await emailOf(person.id),
        'vera@example.org',
        'opening the link proves the inbox, as the code did',
      );

      assert.equal((await open(token)).json().status, 'accepted');
      assert.equal((await linkCode(token)).json().error, 'invalid_invitation', 'single use');
    });

    it("is refused on another facility's device", async () => {
      const person = await newcomer('Wale Newcomer');
      await invite(person.id, 'wale@example.org');
      assert.equal(
        (await linkCode(lastLinkSentTo('wale@example.org'), b)).json().error,
        'other_facility',
      );
    });

    it('enrols a new device only when an administrator who may enrol devices allowed it — once', async () => {
      const plain = await newcomer('Xavi Newcomer');
      await invite(plain.id, 'xavi@example.org');
      assert.equal(
        (await newDevice(lastLinkSentTo('xavi@example.org'), 'device-xavi')).json().error,
        'device_not_allowed',
      );

      assert.equal((await db.sql`SELECT 1 FROM devices WHERE id = 'device-xavi'`).length, 0);

      // May add staff, but not devices: can invite, cannot let the invitation enrol a device.
      const staffManager = await addStaff(db.sql, a, {
        role: 'supervisor',
        name: 'Staff Manager',
        additionalPermissions: ['staff:manage'],
      });

      const yemi = await newcomer('Yemi Newcomer');
      assert.equal(
        (await inviteWithDevice(yemi.id, 'yemi@example.org', staffManager.id)).json().error,
        'device_enroll_forbidden',
      );

      assert.equal(
        (await db.sql`SELECT 1 FROM staff_invitations WHERE staff_id = ${yemi.id}`).length,
        0,
        'nothing is sent',
      );

      assert.equal(
        (await invite(yemi.id, 'yemi@example.org', staffManager.id)).statusCode,
        201,
        'an ordinary invitation is still theirs to send',
      );

      const person = await newcomer('Zainab Newcomer');
      const sent = await inviteWithDevice(person.id, 'zainab@example.org');
      assert.equal(sent.json().invitation.allowsNewDevice, true);
      const token = lastLinkSentTo('zainab@example.org');
      const enrolled = await newDevice(token, 'device-zainab');
      assert.equal(enrolled.statusCode, 201, enrolled.body);
      const credential = enrolled.json();
      assert.equal(credential.facilityId, a.facility.id, 'the invitation decides the facility');

      const [deviceRow] =
        await db.sql`SELECT enrolled_by, label FROM devices WHERE id = 'device-zainab'`;

      assert.equal(
        deviceRow.enrolled_by,
        a.admin.id,
        'enrolled in the name of the administrator who allowed it',
      );

      assert.equal(deviceRow.label, 'Ward 2 phone');
      assert.equal(
        (await db.sql`SELECT 1 FROM enrollment_codes WHERE claimed_by = 'device-zainab'`).length,
        1,
        'recorded like any enrollment',
      );

      assert.equal((await open(token)).json().newDevice, 'used');
      assert.equal(
        (await newDevice(token, 'device-zainab-2')).json().error,
        'device_not_allowed',
        'one device only',
      );

      const exchanged = await post(
        '/invitations/link/code',
        { token },
        asDevice(credential.credential),
      );

      assert.equal(exchanged.statusCode, 200, 'the new device continues to PIN setup');
      assert.equal(
        (
          await post(
            '/staff/session/enrol',
            { staffId: person.id, pin: '583920', setupCode: exchanged.json().code },
            asDevice(credential.credential),
          )
        ).statusCode,
        200,
      );
    });

    it('stops working when revoked or replaced', async () => {
      const person = await newcomer('Ayo Linkholder');
      await inviteWithDevice(person.id, 'ayo@example.org');
      const first = lastLinkSentTo('ayo@example.org');
      await aMinutePasses(person.id);
      await inviteWithDevice(person.id, 'ayo@example.org');
      assert.equal(
        (await open(first)).json().status,
        'revoked',
        'a resend replaces the earlier link',
      );

      assert.equal((await newDevice(first, 'device-ayo')).json().error, 'invalid_invitation');
      const second = lastLinkSentTo('ayo@example.org');
      await post(`/staff/${person.id}/invitations/revoke`, {}, await as(a.admin.id));
      assert.equal((await linkCode(second)).json().error, 'invalid_invitation');
      assert.equal((await newDevice(second, 'device-ayo')).json().error, 'invalid_invitation');
    });
  });
});
