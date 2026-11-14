import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FacilityTimeZone, OwnEmailCodeRequest, OwnEmailConfirm, hasRole, staffPermissions, type ApiErrorBody, type OwnEmailStatus, type Staff, type StaffEmailRequestView } from '#shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { authorizeStaff } from '../auth/staffAuthorization.ts';
import type { Sql } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import { checkVerificationCode, consumeVerification, createVerificationCode, findStaffEmail, saveStaffEmail, staffEmailSubject, verificationEmail } from '../email/verifications.ts';
import { maskEmail, type Mailer } from '../lib/email.ts';
import { privateStaff } from '../workforce/privateAccess.ts';
import { recordFacilityTimeZone, TimeZoneRefusal, timeZoneChanges } from '../facility/timeZone.ts';
import { activationBlockers } from '../insurance/contracts.ts';

const header = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);
const refuse = (reply: FastifyReply, status: number, error: string, message: string) => reply.code(status).send({ error, message } satisfies ApiErrorBody);

/**
 * Administration a hospital does for itself: its time zone, staff email
 * addresses and device status. Consequential changes need a server-verified
 * identity — the staff member's own email-code session — never a staff id the
 * device merely asserts.
 */
export const registerSelfServiceRoutes = (app: FastifyInstance, sql: Sql, mailer: Mailer): void => {
  const verifiedStaff = async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;
    const staff = await privateStaff(sql, identity, header(request.headers['x-workforce-access']));
    if (!staff) { refuse(reply, 403, 'private_verification_required', 'Verify your staff email code to continue'); return; }
    return { identity, staff };
  };

  /* ---------------- Facility time zone ---------------- */

  app.post('/facility/time-zone/history', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply); if (!identity) return;
    return { changes: await timeZoneChanges(sql, identity.facilityId) };
  });

  /**
   * A facility administrator records the time zone, or corrects it with a
   * reason. A correction applies from now; earlier records keep their dates.
   */
  app.post('/facility/time-zone', async (request, reply) => {
    const who = await verifiedStaff(request, reply); if (!who) return;
    if (!hasRole(who.staff, 'facility_admin')) return refuse(reply, 403, 'forbidden', 'Only a facility administrator sets the time zone');
    const body = z.strictObject({ timeZone: FacilityTimeZone, reason: z.string().trim().min(5).max(500).optional(), confirm: z.literal(true) }).safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request', 'Choose a valid time zone and confirm it');
    try {
      const result = await sql.begin(async (tx) => {
        const outcome = await recordFacilityTimeZone(tx, { facilityId: who.identity.facilityId, timeZone: body.data.timeZone, by: who.staff.id, deviceId: who.identity.deviceId, ...(body.data.reason ? { reason: body.data.reason } : {}) });
        if (outcome.changed) await recordAuditEvent(tx, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'update', entityType: 'facility', entityId: who.identity.facilityId,
          metadata: { context: outcome.from ? 'facility_time_zone_corrected' : 'facility_time_zone_recorded', to: outcome.timeZone, ...(outcome.from ? { from: outcome.from, reason: body.data.reason ?? '' } : {}) } });
        return outcome;
      });
      return { timeZone: result.timeZone, changed: result.changed };
    } catch (cause) {
      if (cause instanceof TimeZoneRefusal) return refuse(reply, 409, cause.code, cause.message);
      throw cause;
    }
  });

  /* ---------------- Staff email self-service ---------------- */

  const activeStaff = async (facilityId: string, staffId: string) => {
    const staff = await findRecord<Staff>(sql, 'staff', staffId);
    return staff?.active && staff.facilityId === facilityId ? staff : undefined;
  };
  const pendingFor = async (facilityId: string, staffId: string) =>
    (await sql<{ id: string; email: string; requested_on: Date }[]>`SELECT id, email, requested_on FROM staff_email_requests WHERE facility_id = ${facilityId} AND staff_id = ${staffId} AND status = 'pending'`)[0];

  /** What the signed-in person has on file: masked unless they have proven it is them. */
  app.post('/staff/me/email/status', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply); if (!identity) return;
    const body = z.strictObject({ staffId: z.string().min(1) }).safeParse(request.body);
    if (!body.success || !(await activeStaff(identity.facilityId, body.data.staffId))) return refuse(reply, 404, 'unknown_staff', 'No such member of staff here');
    const session = await privateStaff(sql, identity, header(request.headers['x-workforce-access']));
    const own = session?.id === body.data.staffId;
    const email = await findStaffEmail(sql, identity.facilityId, body.data.staffId);
    const pending = await pendingFor(identity.facilityId, body.data.staffId);
    const status: OwnEmailStatus = { verified: Boolean(email), ...(email ? { email: own ? email : maskEmail(email) } : {}),
      ...(pending ? { pending: { id: pending.id, email: own ? pending.email : maskEmail(pending.email), requestedOn: new Date(pending.requested_on).toISOString() } } : {}) };
    return status;
  });

  /** Step one: a code to the address being registered, proving the person can read it. */
  app.post('/staff/me/email/code', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply); if (!identity) return;
    const body = OwnEmailCodeRequest.safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request', 'Enter a valid email address');
    if (!mailer.configured) return refuse(reply, 503, 'email_required', 'Email delivery is not configured for this deployment');
    if (!(await activeStaff(identity.facilityId, body.data.staffId))) return refuse(reply, 404, 'unknown_staff', 'No such member of staff here');
    const email = body.data.email.toLowerCase();
    const [taken] = await sql`SELECT 1 FROM staff_contacts c JOIN staff s ON s.facility_id = c.facility_id AND s.id = c.staff_id WHERE c.facility_id = ${identity.facilityId} AND lower(c.email) = ${email} AND c.staff_id <> ${body.data.staffId} AND s.active`;
    if (taken) return refuse(reply, 409, 'email_in_use', 'Another member of staff here uses this address');
    const fresh = await createVerificationCode(sql, { purpose: 'staff_email', subject: staffEmailSubject(identity.facilityId, body.data.staffId), email });
    await mailer.send({ to: email, ...verificationEmail(fresh.code, 'staff_email') });
    return reply.code(202).send({ sentTo: maskEmail(email), expiresOn: fresh.expiresOn });
  });

  /**
   * Step two. Someone already verified by their current email changes it at
   * once. Otherwise the proven address waits for a verified administrator to
   * confirm it belongs to this person: the device alone cannot prove who is
   * holding it, so no one can claim a colleague's identity with an inbox.
   */
  app.post('/staff/me/email', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply); if (!identity) return;
    const body = OwnEmailConfirm.safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request', 'The email and its 6-digit code are needed');
    const staffId = body.data.staffId, email = body.data.email.toLowerCase();
    if (!(await activeStaff(identity.facilityId, staffId))) return refuse(reply, 404, 'unknown_staff', 'No such member of staff here');
    const proof = await checkVerificationCode(sql, { purpose: 'staff_email', subject: staffEmailSubject(identity.facilityId, staffId), email, code: body.data.code });
    if (!proof) return refuse(reply, 403, 'invalid_email_code', 'The code is not right, or has expired — ask for a new one');
    const session = await privateStaff(sql, identity, header(request.headers['x-workforce-access']));
    const outcome = await sql.begin(async (tx) => {
      if (!(await consumeVerification(tx, proof))) return 'spent' as const;
      if (session?.id === staffId) {
        await saveStaffEmail(tx, identity.facilityId, staffId, email);
        await tx`UPDATE staff_email_requests SET status = 'superseded', decided_on = now() WHERE facility_id = ${identity.facilityId} AND staff_id = ${staffId} AND status = 'pending'`;
        await recordAuditEvent(tx, { facilityId: identity.facilityId, deviceId: identity.deviceId, actorStaffId: staffId, action: 'update', entityType: 'staff', entityId: staffId, metadata: { context: 'staff_email_changed', email: maskEmail(email) } });
        return 'verified' as const;
      }
      await tx`UPDATE staff_email_requests SET status = 'superseded', decided_on = now() WHERE facility_id = ${identity.facilityId} AND staff_id = ${staffId} AND status = 'pending'`;
      const id = `staff_email_request:${randomUUID()}`;
      await tx`INSERT INTO staff_email_requests (id, facility_id, staff_id, email, requested_from) VALUES (${id}, ${identity.facilityId}, ${staffId}, ${email}, ${identity.deviceId})`;
      await recordAuditEvent(tx, { facilityId: identity.facilityId, deviceId: identity.deviceId, actorStaffId: staffId, action: 'create', entityType: 'staff', entityId: staffId, metadata: { context: 'staff_email_requested', requestId: id, email: maskEmail(email) } });
      return 'pending_approval' as const;
    });
    if (outcome === 'spent') return refuse(reply, 403, 'invalid_email_code', 'The code was already used — ask for a new one');
    return { status: outcome };
  });

  /** Addresses waiting for an administrator to confirm who they belong to. */
  app.post('/staff/email-requests/list', async (request, reply) => {
    const who = await verifiedStaff(request, reply); if (!who) return;
    if (!staffPermissions(who.staff).includes('staff:manage')) return refuse(reply, 403, 'forbidden', 'Confirming staff email addresses needs staff:manage');
    const rows = await sql<{ id: string; staff_id: string; full_name: string; email: string; requested_on: Date; current: string | null }[]>`
      SELECT r.id, r.staff_id, s.full_name, r.email, r.requested_on, c.email AS current FROM staff_email_requests r JOIN staff s ON s.facility_id = r.facility_id AND s.id = r.staff_id
      LEFT JOIN staff_contacts c ON c.facility_id = r.facility_id AND c.staff_id = r.staff_id WHERE r.facility_id = ${who.identity.facilityId} AND r.status = 'pending' ORDER BY r.requested_on`;
    const requests: StaffEmailRequestView[] = rows.map((r) => ({ id: r.id, staffId: r.staff_id, staffName: r.full_name, email: r.email, requestedOn: new Date(r.requested_on).toISOString(), ...(r.current ? { replacing: maskEmail(r.current) } : {}) }));
    return { requests };
  });

  app.post<{ Params: { id: string } }>('/staff/email-requests/:id/decide', async (request, reply) => {
    const who = await verifiedStaff(request, reply); if (!who) return;
    if (!staffPermissions(who.staff).includes('staff:manage')) return refuse(reply, 403, 'forbidden', 'Confirming staff email addresses needs staff:manage');
    const body = z.strictObject({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() }).safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request', 'Approve or reject');
    const outcome = await sql.begin(async (tx) => {
      const [row] = await tx<{ staff_id: string; email: string; status: string }[]>`SELECT staff_id, email, status FROM staff_email_requests WHERE facility_id = ${who.identity.facilityId} AND id = ${request.params.id} FOR UPDATE`;
      if (!row) return 'not_found' as const;
      if (row.status !== 'pending') return 'decided' as const;
      if (row.staff_id === who.staff.id) return 'self' as const;
      await tx`UPDATE staff_email_requests SET status = ${body.data.decision === 'approve' ? 'approved' : 'rejected'}, decided_by = ${who.staff.id}, decided_on = now(), decision_note = ${body.data.note ?? null} WHERE id = ${request.params.id}`;
      if (body.data.decision === 'approve') await saveStaffEmail(tx, who.identity.facilityId, row.staff_id, row.email);
      await recordAuditEvent(tx, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'update', entityType: 'staff', entityId: row.staff_id,
        metadata: { context: body.data.decision === 'approve' ? 'staff_email_approved' : 'staff_email_rejected', requestId: request.params.id, email: maskEmail(row.email) } });
      return 'ok' as const;
    });
    if (outcome === 'not_found') return refuse(reply, 404, 'not_found', 'No such request');
    if (outcome === 'decided') return refuse(reply, 409, 'already_decided', 'This request was already decided');
    if (outcome === 'self') return refuse(reply, 403, 'own_request', 'Another administrator confirms your own address');
    return { ok: true };
  });

  /* ---------------- Device status ---------------- */

  /**
   * Every device of the facility with its last report: app version support,
   * unsent changes and when it last synced, and why it would block a feature.
   */
  app.post('/devices/status', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply); if (!identity) return;
    const body = z.strictObject({ requestedBy: z.string().min(1) }).safeParse(request.body);
    if (!body.success) return refuse(reply, 400, 'invalid_request', 'requestedBy is required');
    const allowed = 'denial' in await authorizeStaff(sql, identity.facilityId, body.data.requestedBy, 'device:revoke') ? !('denial' in await authorizeStaff(sql, identity.facilityId, body.data.requestedBy, 'device:enroll')) : true;
    if (!allowed) return refuse(reply, 403, 'forbidden', 'Device status needs device administration permission');
    const rows = await sql<{ id: string; label: string | null; status: string; enrolled_on: Date; revoked_on: Date | null; last_seen_on: Date | null; insurance_version: number | null; pending_mutation_count: number | null; recorded_on: Date | null }[]>`
      SELECT d.id, d.label, d.status, d.enrolled_on, d.revoked_on, d.last_seen_on, v.insurance_version, v.pending_mutation_count, v.recorded_on
      FROM devices d LEFT JOIN workforce_client_versions v ON v.device_id = d.id WHERE d.facility_id = ${identity.facilityId} ORDER BY d.status, d.label NULLS LAST, d.id`;
    const blockers = new Map((await activationBlockers(sql, identity.facilityId)).map((b) => [b.deviceId, b.reasons]));
    return { devices: rows.map((r) => ({
      id: r.id, label: r.label ?? undefined, status: r.status, enrolledOn: new Date(r.enrolled_on).toISOString(), ...(r.revoked_on ? { revokedOn: new Date(r.revoked_on).toISOString() } : {}),
      ...(r.last_seen_on ? { lastSeenOn: new Date(r.last_seen_on).toISOString() } : {}), insuranceCapable: r.insurance_version === 1,
      ...(r.pending_mutation_count !== null ? { pendingChanges: r.pending_mutation_count } : {}), ...(r.recorded_on ? { lastReportedOn: new Date(r.recorded_on).toISOString() } : {}),
      blocking: blockers.get(r.id) ?? [], thisDevice: r.id === identity.deviceId,
    })) };
  });
};
