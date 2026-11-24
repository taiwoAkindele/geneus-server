import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { FacilityRegistrationResponse } from '#shared';
import {
  addOperator,
  approvedSignupFor,
  asDevice,
  lastCodeSentTo,
  mailbox,
  scratchDatabase,
  scratchFacilityCode,
  testApp,
  verifiedEmailFor,
  type ScratchDatabase,
} from './postgres.ts';

const PASSWORD = 'a long enough password';

/** The token of the newest link of this kind emailed to `to`. */
const linkTokenSentTo = (to: string, path: string): string => {
  const pattern = new RegExp(`${path}#token=([\\w-]+)`);
  const message = [...mailbox]
    .reverse()
    .find((candidate) => pattern.test(candidate.text) && candidate.to === to);
  const token = message?.text.match(pattern)?.[1];

  if (!token) {
    throw new Error(`no ${path} link was emailed to ${to}`);
  }

  return token;
};

const reviewTokenFor = (operatorEmail: string) =>
  linkTokenSentTo(operatorEmail, '/operator/facility-request');

const registrationTokenFor = (email: string) => linkTokenSentTo(email, '/onboarding/register');

/**
 * Facility sign-up through the HTTP contract, the way the PWA does it: a
 * proven email asks Geneus for a facility, an operator decides from the link
 * they were emailed, and the approval's link registers the facility on the
 * device that opens it.
 */
describe('facility sign-up', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;

  const OPERATOR = 'ops@geneus.example';
  const SECOND_OPERATOR = 'ops2@geneus.example';

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers });

  const newDeviceId = () => `device-${Math.random().toString(36).slice(2)}`;

  /** A well-formed request with a fresh facility code and a proven email. */
  const signupRequest = async (overrides: Record<string, unknown> = {}) => {
    const email =
      (overrides.adminEmail as string | undefined) ??
      `amaka-${Math.random().toString(36).slice(2, 8)}@example.org`;

    return {
      code: scratchFacilityCode(),
      name: 'Test PHC',
      state: 'Oyo',
      lga: 'Ibadan SW',
      level: 'phc',
      adminFullName: 'Amaka Okoro',
      ...(await verifiedEmailFor(db.sql, email)),
      ...overrides,
    };
  };

  /** Submits a request and returns it with the first operator's review token. */
  const submitted = async (overrides: Record<string, unknown> = {}) => {
    const body = await signupRequest(overrides);
    const response = await post('/facility-requests', body);

    assert.equal(response.statusCode, 201, response.body);

    return { body, reviewToken: reviewTokenFor(OPERATOR) };
  };

  /** Submitted and approved: the registration link's token. */
  const approved = async (overrides: Record<string, unknown> = {}) => {
    const { body, reviewToken } = await submitted(overrides);
    const decided = await post('/facility-requests/review/decide', {
      token: reviewToken,
      decision: 'approve',
    });

    assert.equal(decided.statusCode, 200, decided.body);

    return { body, reviewToken, token: registrationTokenFor(body.adminEmail) };
  };

  const register = (token: string, overrides: Record<string, unknown> = {}) =>
    post('/facilities', { token, deviceId: newDeviceId(), password: PASSWORD, ...overrides });

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    await addOperator(db.sql, OPERATOR);
    await addOperator(db.sql, SECOND_OPERATOR);
  });

  after(async () => {
    await app.close();
    await db.drop();
  });

  describe('asking for a facility', () => {
    it('emails a code to prove the address', async () => {
      const sent = await post('/email-verifications', { email: ' Ngozi@Example.ORG ' });

      assert.equal(sent.statusCode, 202, sent.body);
      assert.equal(sent.json().sentTo, 'n•••@example.org');
      assert.match(lastCodeSentTo('ngozi@example.org'), /^\d{6}$/);
    });

    it('records the request and emails each operator a review link of their own', async () => {
      const body = await signupRequest();
      const response = await post('/facility-requests', body);

      assert.equal(response.statusCode, 201, response.body);

      const first = reviewTokenFor(OPERATOR);
      const second = reviewTokenFor(SECOND_OPERATOR);

      assert.notEqual(first, second);

      const [row] = await db.sql<{ status: string; email: string }[]>`
        SELECT status, email FROM facility_signup_requests WHERE code = ${body.code}`;

      assert.deepEqual({ ...row }, { status: 'requested', email: body.adminEmail });

      const hashes = await db.sql<{ token_hash: string }[]>`
        SELECT token_hash FROM facility_signup_review_links`;

      assert.equal(
        hashes.some((link) => link.token_hash === first),
        false,
        'only a hash of a review link is kept',
      );
    });

    it('refuses a wrong email code, and stops accepting one after five wrong guesses', async () => {
      const body = await signupRequest();
      const wrong = body.emailCode === '000000' ? '000001' : '000000';

      const refused = await post('/facility-requests', { ...body, emailCode: wrong });

      assert.equal(refused.statusCode, 403);
      assert.equal(refused.json().error, 'invalid_email_code');

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await post('/facility-requests', { ...body, emailCode: wrong });
      }

      assert.equal((await post('/facility-requests', body)).statusCode, 403);
    });

    it('refuses a second open request from the same email', async () => {
      const { body } = await submitted();
      const again = await post('/facility-requests', {
        ...(await signupRequest({ adminEmail: body.adminEmail })),
      });

      assert.equal(again.statusCode, 409);
      assert.equal(again.json().error, 'already_requested');
    });

    it('refuses a facility code that is already registered', async () => {
      const { body, token } = await approved();
      await register(token);

      const response = await post('/facility-requests', await signupRequest({ code: body.code }));

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error, 'facility_code_taken');
    });

    it('refuses a malformed request with the validation issues', async () => {
      const response = await post(
        '/facility-requests',
        await signupRequest({ code: 'not a code' }),
      );

      assert.equal(response.statusCode, 400);
      assert.ok(Array.isArray(response.json().issues));
    });
  });

  describe('deciding a request from the email', () => {
    it('shows the request without deciding it', async () => {
      const { body, reviewToken } = await submitted();

      const opened = await post('/facility-requests/review/open', { token: reviewToken });

      assert.equal(opened.statusCode, 200, opened.body);
      assert.equal(opened.json().status, 'requested');
      assert.equal(opened.json().facility.code, body.code);
      assert.equal(opened.json().adminEmail, body.adminEmail);
      assert.equal(opened.json().reviewer.email, OPERATOR);
    });

    it('approves once, records the operator, and emails the requester a registration link', async () => {
      const { body, reviewToken } = await submitted();

      const decided = await post('/facility-requests/review/decide', {
        token: reviewToken,
        decision: 'approve',
      });

      assert.equal(decided.statusCode, 200, decided.body);
      assert.equal(decided.json().status, 'approved');
      assert.equal(decided.json().requesterEmail, 'sent');
      assert.match(registrationTokenFor(body.adminEmail), /^[A-Z2-9]{32}$/);

      const events = await db.sql<{ action: string }[]>`
        SELECT e.action FROM operator_events e
        JOIN platform_operators o ON o.id = e.operator_id
        WHERE o.email = ${OPERATOR} AND e.subject = ${decided.json().id}`;

      assert.deepEqual(
        events.map((event) => event.action),
        ['facility_signup_approved'],
      );

      // The other operator's link now shows who decided, and cannot decide again.
      const otherToken = reviewTokenFor(SECOND_OPERATOR);
      const other = await post('/facility-requests/review/open', { token: otherToken });
      const twice = await post('/facility-requests/review/decide', {
        token: otherToken,
        decision: 'reject',
        note: 'Too late',
      });

      assert.equal(other.json().decision.decidedBy, 'ops');
      assert.equal(twice.statusCode, 409);
      assert.equal(twice.json().error, 'already_decided');
    });

    it('needs a reason to reject, and emails it to the requester', async () => {
      const { body, reviewToken } = await submitted();

      const withoutReason = await post('/facility-requests/review/decide', {
        token: reviewToken,
        decision: 'reject',
      });

      const rejected = await post('/facility-requests/review/decide', {
        token: reviewToken,
        decision: 'reject',
        note: 'We could not confirm this facility',
      });

      assert.equal(withoutReason.statusCode, 400);
      assert.equal(rejected.statusCode, 200, rejected.body);
      assert.equal(rejected.json().status, 'rejected');

      const email = [...mailbox].reverse().find((message) => message.to === body.adminEmail);

      assert.match(email?.text ?? '', /We could not confirm this facility/);
    });

    it('lets the requester ask again once a request is rejected', async () => {
      const { body, reviewToken } = await submitted();
      await post('/facility-requests/review/decide', {
        token: reviewToken,
        decision: 'reject',
        note: 'Wrong level of care',
      });

      const again = await post(
        '/facility-requests',
        await signupRequest({ adminEmail: body.adminEmail }),
      );

      assert.equal(again.statusCode, 201, again.body);
    });

    it('refuses an unknown link, and the link of an operator no longer active', async () => {
      await addOperator(db.sql, 'leaving@geneus.example');
      await submitted();
      const leaving = reviewTokenFor('leaving@geneus.example');

      await db.sql`UPDATE platform_operators SET active = false WHERE email = 'leaving@geneus.example'`;

      const unknown = await post('/facility-requests/review/open', { token: 'x'.repeat(43) });
      const inactive = await post('/facility-requests/review/decide', {
        token: leaving,
        decision: 'approve',
      });

      assert.equal(unknown.statusCode, 404);
      assert.equal(inactive.statusCode, 404);
    });

    it('refuses to approve a facility code registered since the request', async () => {
      const { body, reviewToken } = await submitted();
      const taken = await approvedSignupFor(db.sql, { code: body.code });
      await register(taken.token);

      const decided = await post('/facility-requests/review/decide', {
        token: reviewToken,
        decision: 'approve',
      });

      assert.equal(decided.statusCode, 409);
      assert.equal(decided.json().error, 'facility_code_taken');
    });

    it('sends the approval again with a new link, and the earlier link stops working', async () => {
      const { body, reviewToken, token: first } = await approved();

      const resent = await post('/facility-requests/review/resend', { token: reviewToken });
      const second = registrationTokenFor(body.adminEmail);

      assert.equal(resent.statusCode, 200, resent.body);
      assert.notEqual(first, second);
      assert.equal((await post('/facility-registration/open', { token: first })).statusCode, 404);
      assert.equal((await post('/facility-registration/open', { token: second })).statusCode, 200);
    });

    it('has nothing to resend once the facility is registered', async () => {
      const { reviewToken, token } = await approved();
      await register(token);

      const resent = await post('/facility-requests/review/resend', { token: reviewToken });
      const opened = await post('/facility-requests/review/open', { token: reviewToken });

      assert.equal(resent.statusCode, 409);
      assert.equal(resent.json().error, 'already_registered');
      assert.ok(opened.json().registeredOn);
    });
  });

  describe('POST /facilities', () => {
    it('shows the approved details from the link, spending nothing', async () => {
      const { body, token } = await approved();

      const opened = await post('/facility-registration/open', { token });

      assert.equal(opened.statusCode, 200, opened.body);
      assert.equal(opened.json().facility.code, body.code);
      assert.equal(opened.json().adminFullName, 'Amaka Okoro');
      assert.equal(opened.json().hasPassword, false);
    });

    it('registers the approved facility and signs its admin in on this device', async () => {
      const { body, token } = await approved();
      const deviceId = newDeviceId();

      const response = await register(token, { deviceId });

      assert.equal(response.statusCode, 201, response.body);
      const result = FacilityRegistrationResponse.parse(response.json());

      assert.equal(result.facility.id, body.code);
      assert.equal(result.facility.name, 'Test PHC');
      assert.equal(result.admin.role, 'facility_admin');
      assert.equal(result.admin.fullName, 'Amaka Okoro');
      assert.equal(result.device.deviceId, deviceId);
      assert.ok(result.device.credential.startsWith(`${deviceId}.`));
      assert.equal(result.session.staffId, result.admin.id);
      assert.doesNotMatch(response.body, /postgres|credential_hash/);

      // The PIN grant registers the admin's PIN on this device, as after a password sign-in.
      const enrolled = await post(
        '/staff/session/enrol',
        { staffId: result.admin.id, pin: '583920', pinGrant: result.session.pinGrant },
        asDevice(result.device.credential),
      );

      assert.equal(enrolled.statusCode, 200, enrolled.body);

      // The password works for signing in from now on.
      const signedIn = await post(
        '/staff/password/sign-in',
        { email: body.adminEmail, password: PASSWORD },
        asDevice(result.device.credential),
      );

      assert.equal(signedIn.statusCode, 200, signedIn.body);
    });

    it('writes the facility, its admin and its device, and audits both events', async () => {
      const { body, token } = await approved();
      const deviceId = newDeviceId();
      await register(token, { deviceId });

      const [facilities, staff, devices, audits] = await Promise.all([
        db.sql`SELECT id FROM facilities WHERE id = ${body.code}`,
        db.sql`SELECT role, active FROM staff WHERE facility_id = ${body.code}`,
        db.sql`SELECT status FROM devices WHERE id = ${deviceId}`,
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

    it('stores only a hash of the credential, and the email on the server only', async () => {
      const { body, token } = await approved();
      const result = FacilityRegistrationResponse.parse((await register(token)).json());

      const [credential] = await db.sql<{ credential_hash: string }[]>`
        SELECT credential_hash FROM device_credentials WHERE device_id = ${result.device.deviceId}`;

      const [contact] = await db.sql<{ email: string }[]>`
        SELECT email FROM staff_contacts WHERE staff_id = ${result.admin.id}`;

      const published =
        await db.sql`SELECT 1 FROM pg_publication_tables WHERE tablename = 'staff_contacts'`;

      assert.equal(result.device.credential.includes(credential.credential_hash), false);
      assert.equal(contact?.email, body.adminEmail);
      assert.equal(JSON.stringify(result.admin).includes('@'), false);
      assert.equal(published.length, 0);
    });

    it('refuses a password that is too short, without spending the link', async () => {
      const { token } = await approved();

      const refused = await register(token, { password: 'short' });
      const opened = await post('/facility-registration/open', { token });

      assert.equal(refused.statusCode, 400);
      assert.equal(refused.json().error, 'invalid_password');
      assert.equal(opened.statusCode, 200);
    });

    it('works once: a spent link refuses a second registration', async () => {
      const { token } = await approved();
      await register(token);

      const again = await register(token);

      assert.equal(again.statusCode, 403);
      assert.equal(again.json().error, 'invalid_invite');
    });

    it('never replaces a password the email already has: it must be entered', async () => {
      const existing = await approved();
      await register(existing.token);

      // The same person asks for a second facility.
      const { body, token } = await approved({ adminEmail: existing.body.adminEmail });
      const opened = await post('/facility-registration/open', { token });
      const wrong = await register(token, { password: 'a different password' });
      const right = await register(token);

      assert.equal(opened.json().hasPassword, true);
      assert.equal(wrong.statusCode, 403);
      assert.equal(wrong.json().error, 'wrong_password');
      assert.equal(right.statusCode, 201, right.body);

      const [row] = await db.sql<{ set_by: string }[]>`
        SELECT set_by FROM staff_passwords WHERE email = ${body.adminEmail}`;

      assert.equal(row.set_by, 'registration');
    });

    it('refuses a device that is already enrolled, and releases the link', async () => {
      const first = await approved();
      const deviceId = newDeviceId();
      await register(first.token, { deviceId });

      const { token } = await approved();
      const response = await register(token, { deviceId });
      const opened = await post('/facility-registration/open', { token });

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error, 'device_already_enrolled');
      assert.equal(opened.statusCode, 200, 'the failed registration rolled its claim back');
    });

    it('refuses an invite that has no approved request behind it', async () => {
      const response = await register('ABCDEFGHJKLMNPQRSTUVWXYZ23456789');

      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'invalid_invite');
    });
  });

  it('reports PostgreSQL on /health', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.json().postgres, 'reachable');
    assert.equal(response.json().schemaVersion, 7);
  });
});
