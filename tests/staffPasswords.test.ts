import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, Staff } from '#shared';
import { issuePinSetupCode } from '../src/staff/pinSetupCodes.ts';
import { verifyCredential } from '../src/devices/credentials.ts';
import {
  addStaff,
  asDevice,
  lastCodeSentTo,
  mailbox,
  registerScratchFacility,
  scratchDatabase,
  staffSessionFor,
  testApp,
  type ScratchDatabase,
} from './postgres.ts';

/**
 * Staff passwords (SCHEMA.md §10): the first password chosen while accepting an
 * invitation, email + password sign-in giving permission to register a PIN on
 * that device, lockout, reset by emailed code, and change while signed in.
 * Every request goes through the real routes against PostgreSQL.
 */
describe('staff passwords', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let a: FacilityRegistrationResult;
  let b: FacilityRegistrationResult;

  const PASSWORD = 'correct horse battery';

  const device = (f = a) => asDevice(f.device.credential);

  const post = (url: string, payload: unknown, headers: Record<string, string> = device()) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers });

  const asAdmin = async () => ({
    ...device(),
    'x-staff-session': (await staffSessionFor(app, a.device.credential, a.admin.id))!,
  });

  const signIn = (email: string, password: string, f = a) =>
    post('/staff/password/sign-in', { email, password }, device(f));

  /** A new nurse at facility A who accepts an emailed invitation and chooses `password` with their PIN. */
  const invitedNurse = async (email: string, password = PASSWORD): Promise<Staff> => {
    const nurse = await addStaff(db.sql, a, { role: 'nurse', name: `Nurse ${email}` });

    const sent = await post(
      `/staff/${nurse.id}/invitations`,
      { channel: 'email', email },
      await asAdmin(),
    );

    assert.equal(sent.statusCode, 201, sent.body);

    const accepted = await post('/staff/session/enrol', {
      staffId: nurse.id,
      pin: '583920',
      setupCode: lastCodeSentTo(email),
      password,
    });

    assert.equal(accepted.statusCode, 200, accepted.body);

    return nurse;
  };

  const serverPins = async (staffId: string) =>
    (await db.sql`SELECT enrolled_by FROM staff_device_pins WHERE staff_id = ${staffId}`).map(
      (row) => row.enrolled_by as string,
    );

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    [a, b] = await Promise.all([registerScratchFacility(db.sql), registerScratchFacility(db.sql)]);
  });

  after(async () => {
    if (app) {
      await app.close();
    }

    if (db) {
      await db.drop();
    }
  });

  describe('signing in', () => {
    it('accepts the password chosen with the invitation, and gives permission to register a PIN here once', async () => {
      const nurse = await invitedNurse('ada@example.org');

      const signedIn = await signIn(' Ada@Example.org ', PASSWORD);
      assert.equal(signedIn.statusCode, 200, signedIn.body);

      const session = signedIn.json();
      assert.equal(session.staffId, nurse.id);
      assert.ok(session.token);
      assert.ok(session.pinGrant);

      const enrol = () =>
        post('/staff/session/enrol', {
          staffId: nurse.id,
          pin: '246810',
          pinGrant: session.pinGrant,
        });

      const registered = await enrol();
      assert.equal(registered.statusCode, 200, registered.body);
      assert.deepEqual(await serverPins(nurse.id), ['password']);

      const again = await enrol();
      assert.equal(again.statusCode, 403);
      assert.equal(again.json().error, 'invalid_pin_grant', 'a grant is spent by one PIN');
    });

    it('answers a wrong password and an unknown email the same way', async () => {
      await invitedNurse('bola@example.org');

      const wrong = await signIn('bola@example.org', 'not the password');
      const unknown = await signIn('nobody@example.org', PASSWORD);

      assert.equal(wrong.statusCode, 403);
      assert.equal(unknown.statusCode, 403);
      assert.deepEqual(wrong.json(), unknown.json());
      assert.equal(wrong.json().error, 'wrong_password');
    });

    it('locks the email out after five wrong passwords, even for the right one', async () => {
      await invitedNurse('chidi@example.org');

      for (let attempt = 0; attempt < 4; attempt += 1) {
        assert.equal((await signIn('chidi@example.org', 'guess')).json().error, 'wrong_password');
      }

      const fifth = await signIn('chidi@example.org', 'guess');
      assert.equal(fifth.json().error, 'locked');
      assert.ok(fifth.json().details.retryAt);

      assert.equal((await signIn('chidi@example.org', PASSWORD)).json().error, 'locked');
    });

    it('does not open another facility to the same password', async () => {
      await invitedNurse('dayo@example.org');

      const elsewhere = await signIn('dayo@example.org', PASSWORD, b);

      assert.equal(elsewhere.statusCode, 403);
      assert.equal(elsewhere.json().error, 'not_at_facility');
    });

    it('does not let a grant register a PIN for someone else', async () => {
      await invitedNurse('efe@example.org');
      const other = await addStaff(db.sql, a, { role: 'nurse', name: 'Other Nurse' });
      const { pinGrant } = (await signIn('efe@example.org', PASSWORD)).json();

      const misused = await post('/staff/session/enrol', {
        staffId: other.id,
        pin: '246810',
        pinGrant,
      });

      assert.equal(misused.json().error, 'invalid_pin_grant');
      assert.deepEqual(await serverPins(other.id), []);
    });
  });

  describe('choosing the first password', () => {
    it('is refused with a setup code read aloud, which proves no inbox', async () => {
      const nurse = await addStaff(db.sql, a, { role: 'nurse', name: 'Funmi Nurse' });
      const issued = await issuePinSetupCode(db.sql, {
        facilityId: a.facility.id,
        staffId: nurse.id,
        issuedBy: a.admin.id,
        issuedFrom: a.device.deviceId,
      });
      assert.ok(issued.ok);

      const refused = await post('/staff/session/enrol', {
        staffId: nurse.id,
        pin: '583920',
        setupCode: issued.code,
        password: PASSWORD,
      });

      assert.equal(refused.json().error, 'password_needs_invitation');
      assert.deepEqual(await serverPins(nurse.id), [], 'nothing was registered');
    });
  });

  describe('resetting', () => {
    it('sets a new password from the emailed code and signs the email out everywhere', async () => {
      const nurse = await invitedNurse('gbenga@example.org');
      await signIn('gbenga@example.org', PASSWORD);

      const requested = await post('/staff/password/reset/request', {
        email: 'gbenga@example.org',
      });
      assert.equal(requested.statusCode, 202, requested.body);

      const reset = await post('/staff/password/reset', {
        email: 'gbenga@example.org',
        code: lastCodeSentTo('gbenga@example.org'),
        password: 'a brand new password',
      });
      assert.equal(reset.statusCode, 204, reset.body);

      assert.equal((await signIn('gbenga@example.org', PASSWORD)).json().error, 'wrong_password');
      assert.equal((await signIn('gbenga@example.org', 'a brand new password')).statusCode, 200);

      const [open] = await db.sql`
        SELECT count(*)::int AS n FROM staff_sessions WHERE staff_id = ${nurse.id} AND ended_on IS NULL`;
      assert.equal(open?.n, 1, 'only the sign-in after the reset is open');
      assert.deepEqual(await serverPins(nurse.id), [], 'server PIN registrations are cleared');
    });

    it('answers an unknown email the same, and sends nothing', async () => {
      const sentBefore = mailbox.length;

      const requested = await post('/staff/password/reset/request', {
        email: 'stranger@example.org',
      });

      assert.equal(requested.statusCode, 202);
      assert.equal(mailbox.length, sentBefore);
    });

    it('refuses a wrong code', async () => {
      await invitedNurse('halima@example.org');
      await post('/staff/password/reset/request', { email: 'halima@example.org' });

      const wrongCode = lastCodeSentTo('halima@example.org') === '000000' ? '111111' : '000000';

      const refused = await post('/staff/password/reset', {
        email: 'halima@example.org',
        code: wrongCode,
        password: 'a brand new password',
      });

      assert.equal(refused.json().error, 'invalid_code');
      assert.equal((await signIn('halima@example.org', PASSWORD)).statusCode, 200);
    });
  });

  describe('changing', () => {
    it('needs the signed-in session and the current password', async () => {
      await invitedNurse('ike@example.org');
      const { token } = (await signIn('ike@example.org', PASSWORD)).json();
      const signedIn = { ...device(), 'x-staff-session': token as string };

      const noSession = await post('/staff/password/change', {
        currentPassword: PASSWORD,
        password: 'another good password',
      });
      assert.equal(noSession.json().error, 'staff_session_required');

      const wrongCurrent = await post(
        '/staff/password/change',
        { currentPassword: 'not it', password: 'another good password' },
        signedIn,
      );
      assert.equal(wrongCurrent.json().error, 'wrong_password');

      const changed = await post(
        '/staff/password/change',
        { currentPassword: PASSWORD, password: 'another good password' },
        signedIn,
      );
      assert.equal(changed.statusCode, 204, changed.body);
      assert.equal((await signIn('ike@example.org', 'another good password')).statusCode, 200);
    });
  });
});

describe('one person, several facilities, and new devices', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let a: FacilityRegistrationResult;
  let b: FacilityRegistrationResult;

  const PASSWORD = 'correct horse battery';

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers });

  const asAdminOf = async (f: FacilityRegistrationResult) => ({
    ...asDevice(f.device.credential),
    'x-staff-session': (await staffSessionFor(app, f.device.credential, f.admin.id))!,
  });

  /** Invites a new nurse at `f` by email; returns the nurse and the emailed invitation code. */
  const invite = async (f: FacilityRegistrationResult, email: string) => {
    const nurse = await addStaff(db.sql, f, { role: 'nurse', name: `Nurse ${email}` });

    const sent = await post(
      `/staff/${nurse.id}/invitations`,
      { channel: 'email', email },
      await asAdminOf(f),
    );

    assert.equal(sent.statusCode, 201, sent.body);

    return { nurse, code: lastCodeSentTo(email) };
  };

  const accept = (f: FacilityRegistrationResult, staffId: string, extra: object) =>
    post(
      '/staff/session/enrol',
      { staffId, pin: '583920', ...extra },
      asDevice(f.device.credential),
    );

  const signIn = (f: FacilityRegistrationResult, email: string, password: string) =>
    post('/staff/password/sign-in', { email, password }, asDevice(f.device.credential));

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    [a, b] = await Promise.all([registerScratchFacility(db.sql), registerScratchFacility(db.sql)]);
  });

  after(async () => {
    if (app) {
      await app.close();
    }

    if (db) {
      await db.drop();
    }
  });

  describe('an invitation to an email that already has a password', () => {
    const email = 'joke@example.org';

    before(async () => {
      const first = await invite(a, email);
      const accepted = await accept(a, first.nurse.id, {
        setupCode: first.code,
        password: PASSWORD,
      });
      assert.equal(accepted.statusCode, 200, accepted.body);
    });

    it('says so when the code is checked, and never takes a new password', async () => {
      const second = await invite(b, email);

      const checked = await post(
        `/staff/${second.nurse.id}/invitations/check`,
        { code: second.code },
        asDevice(b.device.credential),
      );
      assert.equal(checked.statusCode, 200, checked.body);
      assert.deepEqual(checked.json(), { existingAccount: true });

      const replacing = await accept(b, second.nurse.id, {
        setupCode: second.code,
        password: 'a different password',
      });
      assert.equal(replacing.json().error, 'existing_account');

      const unproven = await accept(b, second.nurse.id, { setupCode: second.code });
      assert.equal(unproven.json().error, 'existing_account');

      const wrong = await accept(b, second.nurse.id, {
        setupCode: second.code,
        existingAccount: { currentPassword: 'not it' },
      });
      assert.equal(wrong.json().error, 'wrong_password');

      const proven = await accept(b, second.nurse.id, {
        setupCode: second.code,
        existingAccount: { currentPassword: PASSWORD },
      });
      assert.equal(proven.statusCode, 200, proven.body);

      assert.equal((await signIn(b, email, PASSWORD)).statusCode, 200, 'the same password');
      assert.equal((await signIn(a, email, PASSWORD)).statusCode, 200, 'still works at A');
    });

    it('accepts an emailed account code instead of the password', async () => {
      const otherEmail = 'kunle@example.org';
      const first = await invite(a, otherEmail);
      await accept(a, first.nurse.id, { setupCode: first.code, password: PASSWORD });
      const second = await invite(b, otherEmail);

      const sent = await post(
        `/staff/${second.nurse.id}/invitations/account-code`,
        { code: second.code },
        asDevice(b.device.credential),
      );
      assert.equal(sent.statusCode, 202, sent.body);

      const accountCode = lastCodeSentTo(otherEmail);

      const accepted = await accept(b, second.nurse.id, {
        setupCode: second.code,
        existingAccount: { accountCode },
      });
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.equal((await signIn(b, otherEmail, PASSWORD)).statusCode, 200);
    });
  });

  describe('signing in on a device enrolled nowhere', () => {
    const email = 'lara@example.org';

    /** Lara works at A (joined first) and B; B is the organization's original facility. */
    before(async () => {
      const atA = await invite(a, email);
      await accept(a, atA.nurse.id, { setupCode: atA.code, password: PASSWORD });

      const atB = await invite(b, email);
      await accept(b, atB.nurse.id, {
        setupCode: atB.code,
        existingAccount: { currentPassword: PASSWORD },
      });

      await db.sql`INSERT INTO organizations (id, name) VALUES ('org:test', 'Test Health')`;
      await db.sql`
        INSERT INTO organization_facilities (facility_id, organization_id, joined_by, joined_on) VALUES
          (${b.facility.id}, 'org:test', ${b.admin.id}, now() - interval '1 day'),
          (${a.facility.id}, 'org:test', ${a.admin.id}, now())`;
    });

    it('needs the password, then the emailed code, and enrols the device at the primary facility', async () => {
      const deviceId = `device:${Date.now()}`;

      const wrong = await post('/devices/password-sign-in', {
        email,
        password: 'not it',
        deviceId,
      });
      assert.equal(wrong.json().error, 'wrong_password');

      const challenged = await post('/devices/password-sign-in', {
        email,
        password: PASSWORD,
        deviceId,
      });
      assert.equal(challenged.statusCode, 202, challenged.body);

      const code = lastCodeSentTo(email);

      const otherDevice = await post('/devices/password-sign-in/confirm', {
        email,
        deviceId: `${deviceId}:other`,
        code,
      });
      assert.equal(otherDevice.json().error, 'invalid_code', 'the code is for that device only');

      const confirmed = await post('/devices/password-sign-in/confirm', {
        email,
        deviceId,
        code,
        deviceLabel: 'Lara phone',
      });
      assert.equal(confirmed.statusCode, 201, confirmed.body);

      const { device, session } = confirmed.json();
      assert.equal(device.facilityId, b.facility.id, 'the original facility of the organization');
      assert.ok('identity' in (await verifyCredential(db.sql, device.credential)));

      const pin = await post(
        '/staff/session/enrol',
        { staffId: session.staffId, pin: '246810', pinGrant: session.pinGrant },
        asDevice(device.credential),
      );
      assert.equal(pin.statusCode, 200, pin.body);

      const again = await post('/devices/password-sign-in', {
        email,
        password: PASSWORD,
        deviceId,
      });
      assert.equal(again.json().error, 'device_already_enrolled');
    });

    it('answers someone who works nowhere like a wrong password', async () => {
      const refused = await post('/devices/password-sign-in', {
        email: 'nobody@example.org',
        password: PASSWORD,
        deviceId: 'device:nobody',
      });

      assert.equal(refused.json().error, 'wrong_password');
    });
  });
});

describe('a first password for staff who signed in before passwords', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let a: FacilityRegistrationResult;

  const post = (url: string, payload: unknown, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers });

  /** A nurse with a verified email, signed in with their PIN: no password yet. */
  const signedInNurse = async (email: string | undefined) => {
    const nurse = await addStaff(db.sql, a, { role: 'nurse', name: `Nurse ${email ?? 'none'}` });

    if (email) {
      await db.sql`INSERT INTO staff_contacts (facility_id, staff_id, email, verified_on) VALUES (${a.facility.id}, ${nurse.id}, ${email}, now())`;
    }

    const session = (await staffSessionFor(app, a.device.credential, nurse.id))!;

    return { nurse, headers: { ...asDevice(a.device.credential), 'x-staff-session': session } };
  };

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    a = await registerScratchFacility(db.sql);
  });

  after(async () => {
    if (app) {
      await app.close();
    }

    if (db) {
      await db.drop();
    }
  });

  it('sets it from a code to their own email, once, and never replaces it', async () => {
    const { headers } = await signedInNurse('mide@example.org');

    const before = await post('/staff/me/password/status', {}, headers);
    assert.deepEqual(before.json(), { email: before.json().email, hasPassword: false });
    assert.ok(before.json().email.includes('@example.org'), 'the masked address');

    assert.equal((await post('/staff/me/password/code', {}, headers)).statusCode, 202);

    const set = await post(
      '/staff/me/password',
      { code: lastCodeSentTo('mide@example.org'), password: 'my first password' },
      headers,
    );
    assert.equal(set.statusCode, 204, set.body);
    assert.equal((await post('/staff/me/password/status', {}, headers)).json().hasPassword, true);

    const signedIn = await post(
      '/staff/password/sign-in',
      { email: 'mide@example.org', password: 'my first password' },
      asDevice(a.device.credential),
    );
    assert.equal(signedIn.statusCode, 200, signedIn.body);

    // Signing in on this device ended the earlier session here: one person at a time.
    const again = await post(
      '/staff/me/password/code',
      {},
      { ...asDevice(a.device.credential), 'x-staff-session': signedIn.json().token },
    );
    assert.equal(again.json().error, 'existing_account', 'a forgotten one is reset instead');
  });

  it('needs their proven session and a verified email', async () => {
    const noSession = await post('/staff/me/password/status', {}, asDevice(a.device.credential));
    assert.equal(noSession.json().error, 'staff_session_required');

    const { headers } = await signedInNurse(undefined);
    assert.deepEqual((await post('/staff/me/password/status', {}, headers)).json(), {
      email: null,
      hasPassword: false,
    });
    assert.equal((await post('/staff/me/password/code', {}, headers)).json().error, 'no_email');
  });

  it('shows administrators who has an email and a password', async () => {
    const { nurse: withEmail } = await signedInNurse('nneka@example.org');
    const { nurse: withoutEmail } = await signedInNurse(undefined);

    const admin = {
      ...asDevice(a.device.credential),
      'x-staff-session': (await staffSessionFor(app, a.device.credential, a.admin.id))!,
    };

    const listed = await post('/staff/invitations/list', {}, admin);
    assert.equal(listed.statusCode, 200, listed.body);

    const byId = new Map(
      (listed.json().staff as { staffId: string; hasEmail: boolean; passwordSet: boolean }[]).map(
        (s) => [s.staffId, s],
      ),
    );

    assert.equal(byId.get(withEmail.id)?.hasEmail, true);
    assert.equal(byId.get(withEmail.id)?.passwordSet, false);
    assert.equal(byId.get(withoutEmail.id)?.hasEmail, false);

    const panel = await post(`/staff/${withEmail.id}/contact-activation`, {}, admin);
    assert.equal(panel.json().password, 'not_set');
  });
});
