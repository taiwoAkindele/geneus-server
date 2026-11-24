import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  FacilityDetails,
  FacilityRegistrationView,
  FacilitySignupRequest,
  FacilitySignupReview,
} from '#shared';
import { isPostgresError, UNIQUE_VIOLATION, type Sql, type Tx } from '../db/client.ts';
import { hasPassword } from '../auth/staffPasswords.ts';
import {
  checkVerificationCode,
  consumeVerification,
  registrationSubject,
} from '../email/verifications.ts';
import { maskEmail, type EmailMessage, type Mailer } from '../lib/email.ts';
import { createInvite, findInvite, rejectionFor, type InviteRejection } from './invites.ts';
import {
  approvalEmail,
  deliver,
  operatorReviewEmail,
  registrationLink,
  rejectionEmail,
  reviewLink,
  type DeliveryResult,
  type SignupSummary,
} from './signupEmails.ts';

/**
 * Facility sign-up ("Create an account"). Someone with a proven email asks
 * Geneus for a facility; every active Geneus operator is emailed a review link
 * of their own; the first to decide settles it. An approval mints the
 * single-use invite that the registration link emailed to the requester
 * carries (registration.ts spends it).
 *
 * A review link is a bearer credential for one request, so only its hash is
 * stored, it expires, and it stops working if its operator is deactivated.
 * Opening it shows the request and changes nothing; only an explicit decision
 * does, so a mail scanner that follows the link cannot approve anything.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long an operator's review link works. */
const REVIEW_LINK_DAYS = 30;

/** How long the registration link sent on approval works. */
export const REGISTRATION_LINK_DAYS = 14;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export type SignupRefusalCode = 'already_decided' | 'facility_code_taken' | 'already_registered';

export class SignupRefusal extends Error {
  readonly code: SignupRefusalCode;

  constructor(code: SignupRefusalCode, message: string) {
    super(message);
    this.name = 'SignupRefusal';
    this.code = code;
  }
}

type RequestRow = {
  id: string;
  code: string;
  name: string;
  state: string;
  lga: string;
  level: FacilityDetails['level'];
  admin_full_name: string;
  email: string;
  requested_on: Date;
  status: FacilitySignupReview['status'];
  decided_on: Date | null;
  decision_note: string | null;
  invite_token: string | null;
  requester_email: DeliveryResult | null;
};

const summaryOf = (row: RequestRow): SignupSummary => ({
  facility: {
    code: row.code,
    name: row.name,
    state: row.state,
    lga: row.lga,
    level: row.level,
  },
  adminFullName: row.admin_full_name,
  email: row.email,
});

const facilityCodeTaken = async (sql: Sql | Tx, code: string): Promise<boolean> =>
  (await sql`SELECT 1 FROM facilities WHERE id = ${code}`).length === 1;

/* ---------------- Asking for a facility ---------------- */

export type IssuedReviewLink = { operatorEmail: string; token: string; expiresOn: string };

export type SignupSubmission =
  | { ok: true; summary: SignupSummary; reviewLinks: IssuedReviewLink[] }
  | { ok: false; error: 'invalid_email_code' | 'facility_code_taken' | 'already_requested' };

const issueReviewLinks = async (tx: Tx, requestId: string): Promise<IssuedReviewLink[]> => {
  const operators = await tx<{ id: string; email: string }[]>`
    SELECT id, email FROM platform_operators WHERE active ORDER BY added_on`;

  const expiresOn = new Date(Date.now() + REVIEW_LINK_DAYS * DAY_MS).toISOString();
  const links: IssuedReviewLink[] = [];

  for (const operator of operators) {
    const token = randomBytes(32).toString('base64url');

    await tx`
      INSERT INTO facility_signup_review_links (token_hash, request_id, operator_id, expires_on)
      VALUES (${sha(token)}, ${requestId}, ${operator.id}, ${expiresOn})`;

    links.push({ operatorEmail: operator.email, token, expiresOn });
  }

  return links;
};

/**
 * Records a request once its email code is right. The code is checked before
 * the transaction, so a wrong guess counts even when the request then fails,
 * and is spent inside it.
 */
export const submitSignupRequest = async (
  sql: Sql,
  input: FacilitySignupRequest,
): Promise<SignupSubmission> => {
  if (await facilityCodeTaken(sql, input.code)) {
    return { ok: false, error: 'facility_code_taken' };
  }

  const verificationId = await checkVerificationCode(sql, {
    purpose: 'registration',
    subject: registrationSubject(input.adminEmail),
    email: input.adminEmail,
    code: input.emailCode,
  });

  if (!verificationId) {
    return { ok: false, error: 'invalid_email_code' };
  }

  const requestId = `facility_signup:${randomUUID()}`;

  try {
    return await sql.begin(async (tx): Promise<SignupSubmission> => {
      if (!(await consumeVerification(tx, verificationId))) {
        return { ok: false, error: 'invalid_email_code' };
      }

      const [row] = await tx<RequestRow[]>`
        INSERT INTO facility_signup_requests (id, code, name, state, lga, level, admin_full_name, email)
        VALUES (${requestId}, ${input.code}, ${input.name.trim()}, ${input.state.trim()},
          ${input.lga.trim()}, ${input.level}, ${input.adminFullName}, ${input.adminEmail})
        RETURNING *`;

      return {
        ok: true,
        summary: summaryOf(row),
        reviewLinks: await issueReviewLinks(tx, requestId),
      };
    });
  } catch (cause) {
    if (isPostgresError(cause, UNIQUE_VIOLATION)) {
      return { ok: false, error: 'already_requested' };
    }

    throw cause;
  }
};

/** Emails each operator their own review link. Returns how many emails went out. */
export const notifyOperators = async (
  mailer: Mailer,
  appUrl: string,
  submission: Extract<SignupSubmission, { ok: true }>,
): Promise<number> => {
  let sent = 0;

  for (const link of submission.reviewLinks) {
    const outcome = await deliver(mailer, {
      to: link.operatorEmail,
      ...operatorReviewEmail(submission.summary, reviewLink(appUrl, link.token), link.expiresOn),
    });

    if (outcome !== 'failed') {
      sent += 1;
    }
  }

  return sent;
};

/* ---------------- Reviewing a request ---------------- */

type ReviewRow = RequestRow & {
  operator_id: string;
  operator_name: string;
  operator_email: string;
  decided_by_name: string | null;
  registered_on: Date | null;
};

type ReviewingOperator = { id: string; name: string; email: string };

const reviewRow = async (
  sql: Sql | Tx,
  token: string,
  options: { lock: boolean },
): Promise<ReviewRow | undefined> => {
  const lock = options.lock ? sql`FOR UPDATE OF r` : sql``;

  const [row] = await sql<ReviewRow[]>`
    SELECT r.*, o.id AS operator_id, o.name AS operator_name, o.email AS operator_email,
      d.name AS decided_by_name, i.claimed_on AS registered_on
    FROM facility_signup_review_links l
    JOIN facility_signup_requests r ON r.id = l.request_id
    JOIN platform_operators o ON o.id = l.operator_id AND o.active
    LEFT JOIN platform_operators d ON d.id = r.decided_by
    LEFT JOIN facility_invites i ON i.token = r.invite_token
    WHERE l.token_hash = ${sha(token)} AND l.expires_on > now()
    ${lock}`;

  return row;
};

const reviewOf = (row: ReviewRow): FacilitySignupReview => {
  const summary = summaryOf(row);

  return {
    id: row.id,
    status: row.status,
    facility: summary.facility,
    adminFullName: summary.adminFullName,
    adminEmail: summary.email,
    requestedOn: new Date(row.requested_on).toISOString(),
    reviewer: { name: row.operator_name, email: row.operator_email },
    ...(row.decided_on
      ? {
          decision: {
            decidedOn: new Date(row.decided_on).toISOString(),
            decidedBy: row.decided_by_name ?? 'A Geneus operator',
            ...(row.decision_note ? { note: row.decision_note } : {}),
          },
        }
      : {}),
    ...(row.registered_on ? { registeredOn: new Date(row.registered_on).toISOString() } : {}),
    ...(row.requester_email ? { requesterEmail: row.requester_email } : {}),
  };
};

/** What the review link shows. Undefined when the link is unknown, expired or its operator inactive. */
export const openSignupReview = async (
  sql: Sql,
  token: string,
): Promise<FacilitySignupReview | undefined> => {
  const row = await reviewRow(sql, token, { lock: false });

  return row ? reviewOf(row) : undefined;
};

const operatorOf = (row: ReviewRow): ReviewingOperator => ({
  id: row.operator_id,
  name: row.operator_name,
  email: row.operator_email,
});

/** Every decision is kept permanently in the operator console's log, with who made it. */
const recordOperatorEvent = (
  tx: Tx,
  operator: ReviewingOperator,
  action: string,
  requestId: string,
  metadata: Record<string, unknown>,
) =>
  tx`
    INSERT INTO operator_events (id, operator_id, action, facility_id, subject, metadata)
    VALUES (${`operator_event:${randomUUID()}`}, ${operator.id}, ${action}, NULL, ${requestId},
      ${tx.json(metadata as never)})`;

/** A new registration link, retiring any earlier one that was never used. */
const mintRegistrationInvite = async (tx: Tx, row: RequestRow) => {
  if (row.invite_token) {
    await tx`
      UPDATE facility_invites SET expires_on = now() - interval '1 second'
      WHERE token = ${row.invite_token} AND claimed_on IS NULL`;
  }

  const invite = await createInvite(tx, row.name, REGISTRATION_LINK_DAYS);

  await tx`UPDATE facility_signup_requests SET invite_token = ${invite.token} WHERE id = ${row.id}`;

  return invite;
};

type DecisionEmail = { to: string; message: Omit<EmailMessage, 'to'> };

const approve = async (
  tx: Tx,
  row: ReviewRow,
  note: string | undefined,
  appUrl: string,
): Promise<DecisionEmail> => {
  if (await facilityCodeTaken(tx, row.code)) {
    throw new SignupRefusal(
      'facility_code_taken',
      `Facility code ${row.code} is already registered. Reject this request and say so`,
    );
  }

  // The invite first: an approved request must always have one (migration 0051).
  const invite = await mintRegistrationInvite(tx, row);

  await tx`
    UPDATE facility_signup_requests
    SET status = 'approved', decided_by = ${row.operator_id}, decided_on = now(),
      decision_note = ${note ?? null}
    WHERE id = ${row.id}`;

  await recordOperatorEvent(tx, operatorOf(row), 'facility_signup_approved', row.id, {
    code: row.code,
    email: row.email,
    ...(note ? { note } : {}),
  });

  return {
    to: row.email,
    message: approvalEmail(
      summaryOf(row),
      registrationLink(appUrl, invite.token),
      invite.expiresOn,
    ),
  };
};

const reject = async (tx: Tx, row: ReviewRow, note: string): Promise<DecisionEmail> => {
  await tx`
    UPDATE facility_signup_requests
    SET status = 'rejected', decided_by = ${row.operator_id}, decided_on = now(),
      decision_note = ${note}
    WHERE id = ${row.id}`;

  await recordOperatorEvent(tx, operatorOf(row), 'facility_signup_rejected', row.id, {
    code: row.code,
    email: row.email,
    note,
  });

  return { to: row.email, message: rejectionEmail(summaryOf(row), note) };
};

/** Sends the requester the decision and records whether it went. */
const tellRequester = async (
  sql: Sql,
  mailer: Mailer,
  requestId: string,
  email: DecisionEmail,
): Promise<void> => {
  const outcome = await deliver(mailer, { to: email.to, ...email.message });

  await sql`UPDATE facility_signup_requests SET requester_email = ${outcome} WHERE id = ${requestId}`;
};

/**
 * Approves or rejects an open request from an operator's review link. The
 * requester is emailed after the decision commits: a failed email leaves the
 * decision in place, shows on the review page, and can be sent again.
 * Undefined when the link is not valid.
 */
export const decideSignupRequest = async (
  sql: Sql,
  mailer: Mailer,
  appUrl: string,
  input: { token: string; decision: 'approve' | 'reject'; note?: string },
): Promise<FacilitySignupReview | undefined> => {
  const decided = await sql.begin(async (tx) => {
    const row = await reviewRow(tx, input.token, { lock: true });

    if (!row) {
      return undefined;
    }

    if (row.status !== 'requested') {
      throw new SignupRefusal(
        'already_decided',
        `This request was already ${row.status} by ${row.decided_by_name ?? 'another operator'}`,
      );
    }

    const email =
      input.decision === 'approve'
        ? await approve(tx, row, input.note, appUrl)
        : await reject(tx, row, input.note ?? '');

    return { requestId: row.id, email };
  });

  if (!decided) {
    return undefined;
  }

  await tellRequester(sql, mailer, decided.requestId, decided.email);

  return openSignupReview(sql, input.token);
};

/**
 * Sends the decision email again, for when it did not reach the requester.
 * An approval gets a fresh registration link and the earlier one stops
 * working; once the facility is registered there is nothing to resend.
 */
export const resendSignupDecision = async (
  sql: Sql,
  mailer: Mailer,
  appUrl: string,
  token: string,
): Promise<FacilitySignupReview | undefined> => {
  const resent = await sql.begin(async (tx) => {
    const row = await reviewRow(tx, token, { lock: true });

    if (!row) {
      return undefined;
    }

    if (row.status === 'requested') {
      throw new SignupRefusal('already_decided', 'Approve or reject the request first');
    }

    if (row.registered_on) {
      throw new SignupRefusal('already_registered', 'This facility is already registered');
    }

    await recordOperatorEvent(tx, operatorOf(row), 'facility_signup_email_resent', row.id, {
      status: row.status,
    });

    if (row.status === 'rejected') {
      return {
        requestId: row.id,
        email: { to: row.email, message: rejectionEmail(summaryOf(row), row.decision_note ?? '') },
      };
    }

    const invite = await mintRegistrationInvite(tx, row);
    const link = registrationLink(appUrl, invite.token);

    return {
      requestId: row.id,
      email: { to: row.email, message: approvalEmail(summaryOf(row), link, invite.expiresOn) },
    };
  });

  if (!resent) {
    return undefined;
  }

  await tellRequester(sql, mailer, resent.requestId, resent.email);

  return openSignupReview(sql, token);
};

/* ---------------- Registering from the link ---------------- */

export type ApprovedSignup = {
  requestId: string;
  facility: FacilityDetails;
  adminFullName: string;
  email: string;
};

/** The approved request a registration link's invite was minted for. */
export const approvedRequestForInvite = async (
  sql: Sql | Tx,
  inviteToken: string,
): Promise<ApprovedSignup | undefined> => {
  const [row] = await sql<RequestRow[]>`
    SELECT * FROM facility_signup_requests
    WHERE invite_token = ${inviteToken.trim().toUpperCase()} AND status = 'approved'`;

  if (!row) {
    return undefined;
  }

  const summary = summaryOf(row);

  return {
    requestId: row.id,
    facility: summary.facility,
    adminFullName: summary.adminFullName,
    email: summary.email,
  };
};

export type RegistrationLinkOutcome =
  { ok: true; view: FacilityRegistrationView } | { ok: false; rejection: InviteRejection };

/** What the registration link shows before anything is created. Spends nothing. */
export const openRegistrationLink = async (
  sql: Sql,
  token: string,
): Promise<RegistrationLinkOutcome> => {
  const invite = await findInvite(sql, token);
  const rejection = rejectionFor(invite);

  if (rejection || !invite) {
    return { ok: false, rejection: rejection ?? 'unknown' };
  }

  const signup = await approvedRequestForInvite(sql, token);

  if (!signup) {
    return { ok: false, rejection: 'unknown' };
  }

  return {
    ok: true,
    view: {
      facility: signup.facility,
      adminFullName: signup.adminFullName,
      sentTo: maskEmail(signup.email),
      hasPassword: await hasPassword(sql, signup.email),
      expiresOn: invite.expiresOn,
    },
  };
};
