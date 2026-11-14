import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OperatorCodeRequest, OperatorLogin, type ApiErrorBody, type OperatorFacility, type OperatorSession } from '#shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Sql, Tx } from '../db/client.ts';
import { checkVerificationCode, consumeVerification, createVerificationCode, verificationEmail } from '../email/verifications.ts';
import { maskEmail, type Mailer } from '../lib/email.ts';
import { SetupRefusal, activationRequestRow, applyInsuranceState, decideActivation, insuranceSetupStatus } from '../insurance/enablement.ts';

const SESSION_MS = 30 * 60_000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const refuse = (reply: FastifyReply, status: number, error: string, message: string, details?: unknown) => reply.code(status).send({ error, message, ...(details ? { details } : {}) } satisfies ApiErrorBody & { details?: unknown });
type Operator = { id: string; email: string; name: string };

/** The deployment's first operators. Only ever adds; the console adds and removes the rest. */
export const ensureBootstrapOperators = async (sql: Sql, emails: readonly string[]) => {
  for (const email of emails) await sql`INSERT INTO platform_operators (id, email, name, added_by) VALUES (${`operator:${randomUUID()}`}, ${email.toLowerCase()}, ${email.split('@')[0]}, 'deployment') ON CONFLICT (email) DO NOTHING`;
};

const event = (sql: Sql | Tx, operator: Operator, action: string, facilityId: string | null, subject: string | null, metadata: Record<string, unknown> = {}) =>
  sql`INSERT INTO operator_events (id, operator_id, action, facility_id, subject, metadata) VALUES (${`operator_event:${randomUUID()}`}, ${operator.id}, ${action}, ${facilityId}, ${subject}, ${sql.json(metadata as never)})`;

/**
 * The Geneus operator console: platform decisions made in an interface, not by
 * scripts. Operators are Geneus staff, not hospital staff: they sign in with a
 * code sent to their registered address, hold a 30-minute session, and every
 * decision is recorded permanently with who made it.
 */
export const registerOperatorRoutes = (app: FastifyInstance, sql: Sql, mailer: Mailer): void => {
  const operator = async (request: FastifyRequest, reply: FastifyReply): Promise<Operator | undefined> => {
    const token = request.headers['x-operator-session'];
    if (typeof token !== 'string' || token.length > 200) { refuse(reply, 401, 'operator_session_required', 'Sign in to the operator console'); return; }
    const [row] = await sql<Operator[]>`SELECT o.id, o.email, o.name FROM operator_sessions s JOIN platform_operators o ON o.id = s.operator_id WHERE s.token_hash = ${hash(token)} AND s.expires_on > now() AND o.active`;
    if (!row) { refuse(reply, 401, 'operator_session_required', 'Your operator session ended. Sign in again'); return; }
    return row;
  };

  /** Always answers the same way, so the console never reveals who is an operator. */
  app.post('/operator/login/code', async (request, reply) => {
    const body = OperatorCodeRequest.safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request', 'Enter your email address');
    if (!mailer.configured) return refuse(reply, 503, 'email_required', 'Email delivery is not configured for this deployment');
    const email = body.data.email.toLowerCase();
    const [found] = await sql`SELECT 1 FROM platform_operators WHERE email = ${email} AND active`;
    if (found) {
      const fresh = await createVerificationCode(sql, { purpose: 'operator_login', subject: `operator:${email}`, email });
      await mailer.send({ to: email, ...verificationEmail(fresh.code, 'operator_login') });
    }
    return reply.code(202).send({ sentTo: maskEmail(email) });
  });

  app.post('/operator/login', async (request, reply) => {
    const body = OperatorLogin.safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request', 'Enter your email and the 6-digit code');
    const email = body.data.email.toLowerCase();
    const proof = await checkVerificationCode(sql, { purpose: 'operator_login', subject: `operator:${email}`, email, code: body.data.code });
    if (!proof) return refuse(reply, 403, 'invalid_code', 'The code is not right, or has expired');
    const token = randomBytes(32).toString('base64url');
    const session = await sql.begin(async (tx) => {
      const [op] = await tx<Operator[]>`SELECT id, email, name FROM platform_operators WHERE email = ${email} AND active`;
      if (!op || !(await consumeVerification(tx, proof))) return undefined;
      const expiresOn = new Date(Date.now() + SESSION_MS).toISOString();
      await tx`INSERT INTO operator_sessions (token_hash, operator_id, expires_on) VALUES (${hash(token)}, ${op.id}, ${expiresOn})`;
      await event(tx, op, 'login', null, null);
      return { token, expiresOn, operator: op } satisfies OperatorSession;
    });
    return session ?? refuse(reply, 403, 'invalid_code', 'The code is not right, or has expired');
  });

  app.post('/operator/logout', async (request, reply) => {
    const token = request.headers['x-operator-session'];
    if (typeof token === 'string') await sql`DELETE FROM operator_sessions WHERE token_hash = ${hash(token)}`;
    return reply.code(204).send();
  });

  /** Facilities with their insurance state and any request waiting for Geneus. */
  app.post('/operator/facilities', async (request, reply) => {
    if (!(await operator(request, reply))) return;
    const rows = await sql<{ id: string; name: string; code: string; insurance_state: OperatorFacility['insuranceState']; time_zone: string | null; request_id: string | null; requested_on: Date | null }[]>`
      SELECT f.id, f.name, f.code, f.insurance_state, f.time_zone, r.id AS request_id, r.requested_on FROM facilities f
      LEFT JOIN insurance_activation_requests r ON r.facility_id = f.id AND r.status = 'requested' ORDER BY (r.id IS NULL), f.name LIMIT 500`;
    const facilities: OperatorFacility[] = rows.map((r) => ({ id: r.id, name: r.name, code: r.code, insuranceState: r.insurance_state, ...(r.time_zone ? { timeZone: r.time_zone } : {}),
      ...(r.request_id ? { openRequest: { id: r.request_id, requestedOn: new Date(r.requested_on!).toISOString() } } : {}) }));
    return { facilities };
  });

  /** One facility's readiness, as the hospital sees it, and its request history. */
  app.post<{ Params: { id: string } }>('/operator/facilities/:id/insurance', async (request, reply) => {
    if (!(await operator(request, reply))) return;
    const [facility] = await sql`SELECT id FROM facilities WHERE id = ${request.params.id}`;
    if (!facility) return refuse(reply, 404, 'not_found', 'No such facility');
    const requests = await sql<Record<string, unknown>[]>`SELECT r.*, s.full_name AS requested_by_name FROM insurance_activation_requests r LEFT JOIN staff s ON s.facility_id = r.facility_id AND s.id = r.requested_by
      WHERE r.facility_id = ${request.params.id} ORDER BY r.requested_on DESC LIMIT 20`;
    return { status: await insuranceSetupStatus(sql, request.params.id), requests: requests.map(activationRequestRow) };
  });

  /** Approving activates billing in the same transaction, only if every billing item passes now. */
  app.post<{ Params: { id: string } }>('/operator/insurance/requests/:id/decide', async (request, reply) => {
    const op = await operator(request, reply); if (!op) return;
    const body = z.strictObject({ decision: z.enum(['approve', 'reject']), note: z.string().trim().min(3).max(1000) }).safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request', 'Approve or reject, with a note recording the reason or approval reference');
    try {
      const facilityId = await sql.begin(async (tx) => {
        const id = await decideActivation(tx, { requestId: request.params.id, operator: op, decision: body.data.decision, note: body.data.note });
        await event(tx, op, body.data.decision === 'approve' ? 'insurance_activation_approved' : 'insurance_activation_rejected', id, request.params.id, { note: body.data.note });
        return id;
      });
      return { status: await insuranceSetupStatus(sql, facilityId) };
    } catch (cause) {
      if (cause instanceof SetupRefusal) return refuse(reply, 409, cause.code, cause.message, cause.details);
      throw cause;
    }
  });

  /** Turning billing off (or back to setup) for a hospital. Confirmed obligations always remain. */
  app.post<{ Params: { id: string } }>('/operator/facilities/:id/insurance-state', async (request, reply) => {
    const op = await operator(request, reply); if (!op) return;
    const body = z.strictObject({ state: z.enum(['off', 'setup']), reason: z.string().trim().min(5).max(1000) }).safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request', 'Choose off or setup and give the reason');
    try {
      await sql.begin(async (tx) => {
        await applyInsuranceState(tx, { facilityId: request.params.id, state: body.data.state, operator: `${op.name} <${op.email}>`, governanceReference: body.data.reason });
        await event(tx, op, 'insurance_state_changed', request.params.id, body.data.state, { reason: body.data.reason });
      });
      return { status: await insuranceSetupStatus(sql, request.params.id) };
    } catch (cause) {
      if (cause instanceof SetupRefusal) return refuse(reply, 409, cause.code, cause.message, cause.details);
      throw cause;
    }
  });

  /* ---------------- Operators ---------------- */

  app.post('/operator/operators', async (request, reply) => {
    if (!(await operator(request, reply))) return;
    return { operators: await sql`SELECT id, email, name, active, added_by AS "addedBy", added_on AS "addedOn" FROM platform_operators ORDER BY active DESC, name` };
  });
  app.post('/operator/operators/add', async (request, reply) => {
    const op = await operator(request, reply); if (!op) return;
    const body = z.strictObject({ email: z.email().max(254), name: z.string().trim().min(2).max(120) }).safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request', 'Give the operator\'s name and email');
    const email = body.data.email.toLowerCase();
    const added = await sql.begin(async (tx) => {
      const rows = await tx`INSERT INTO platform_operators (id, email, name, added_by) VALUES (${`operator:${randomUUID()}`}, ${email}, ${body.data.name}, ${op.id})
        ON CONFLICT (email) DO UPDATE SET active = true, name = EXCLUDED.name WHERE platform_operators.active = false RETURNING id`;
      if (rows.length) await event(tx, op, 'operator_added', null, email);
      return rows.length > 0;
    });
    return added ? { ok: true } : refuse(reply, 409, 'already_operator', 'This person is already an operator');
  });
  app.post<{ Params: { id: string } }>('/operator/operators/:id/remove', async (request, reply) => {
    const op = await operator(request, reply); if (!op) return;
    if (request.params.id === op.id) return refuse(reply, 409, 'self', 'Another operator removes you');
    const done = await sql.begin(async (tx) => {
      const rows = await tx`UPDATE platform_operators SET active = false WHERE id = ${request.params.id} AND active RETURNING email`;
      if (!rows.length) return false;
      await tx`DELETE FROM operator_sessions WHERE operator_id = ${request.params.id}`;
      await event(tx, op, 'operator_removed', null, rows[0].email as string);
      return true;
    });
    return done ? { ok: true } : refuse(reply, 404, 'not_found', 'No such active operator');
  });

  app.post('/operator/events', async (request, reply) => {
    if (!(await operator(request, reply))) return;
    return { events: await sql`SELECT e.action, e.facility_id AS "facilityId", e.subject, e.metadata, e.at, o.email FROM operator_events e JOIN platform_operators o ON o.id = e.operator_id ORDER BY e.at DESC LIMIT 100` };
  });
};
