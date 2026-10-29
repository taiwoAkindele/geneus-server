import { z } from 'zod';
import { RESTRICTED_FACILITY_DOCUMENT_TYPES, staffPermissions, parseDocument, type ApiErrorBody, type SyncRejection } from '#shared';
import type { FastifyInstance } from 'fastify';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import type { Sql } from '../db/client.ts';
import type { Mailer } from '../lib/email.ts';
import { maskEmail } from '../lib/email.ts';
import { beginPrivateAccess, completePrivateAccess, endPrivateAccess, privateStaff, canReadWorkforceEvidence } from '../workforce/privateAccess.ts';
import { recordsInFacility } from '../workforce/records.ts';
import { workforceReadiness } from '../workforce/readiness.ts';
import { authorizeStaff } from '../auth/staffAuthorization.ts';
import { findRecord } from '../db/records.ts';
import { approveHistoricalReview } from '../workforce/clinical.ts';
import { workforcePayloadHash } from '../workforce/digests.ts';
const codeRequest = z.strictObject({ staffId: z.string().min(1).max(200) });
const codeConfirmation = codeRequest.extend({ code: z.string().regex(/^\d{6}$/) });
const evidenceQuery = z.object({ type: z.enum(RESTRICTED_FACILITY_DOCUMENT_TYPES), staffId: z.string().max(200).optional() });
const tokenHeader = (value: string | string[] | undefined): string | undefined => typeof value === 'string' ? value : undefined;
/** No public authority/bootstrap/clinical mutation endpoint: clinical writes continue through sync upload. */
export const registerWorkforceRoutes = (app: FastifyInstance, sql: Sql, mailer: Mailer): void => {
  app.post('/workforce/clinical-preview', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity)
      return;
    const staff = await privateStaff(sql, identity, tokenHeader(request.headers['x-workforce-access']));
    if (!staff)
      return reply.code(403).send({ error: 'private_verification_required', message: 'Verify the reviewing staff contact first' } satisfies ApiErrorBody);
    const parsed = parseDocument(request.body);
    if (!parsed.success || !['encounter_entry', 'clinical_event'].includes(parsed.data.type) || parsed.data.facilityId !== identity.facilityId)
      return reply.code(400).send({ error: 'invalid_request', message: 'Provide a valid clinical entry in this facility' } satisfies ApiErrorBody);
    return { recordId: parsed.data.id, payloadHash: workforcePayloadHash(parsed.data) };
  });
  app.post<{
    Params: {
      id: string;
    };
  }>('/workforce/rejections/:id/review', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity)
      return;
    const staff = await privateStaff(sql, identity, tokenHeader(request.headers['x-workforce-access']));
    if (!staff)
      return reply.code(403).send({ error: 'private_verification_required', message: 'Verify the independent reviewer contact first' } satisfies ApiErrorBody);
    const body = z.strictObject({ reason: z.string().trim().min(1).max(1000) }).safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: 'invalid_request', message: 'Explain the independent historical review' } satisfies ApiErrorBody);
    try {
      const reviewId = await sql.begin(async (tx) => {
        await tx`SELECT id FROM facilities WHERE id=${identity.facilityId} FOR UPDATE`;
        const rejection = await findRecord<SyncRejection>(tx, 'sync_rejection', request.params.id);
        if (!rejection || rejection.facilityId !== identity.facilityId)
          throw new Error('Select a refused clinical entry in this facility');
        return approveHistoricalReview(tx, identity, staff, rejection, body.data.reason, Date.now());
      });
      return reply.code(201).send({ reviewId, disposition: 'resubmit_exact_source_through_sync' });
    }
    catch (cause) {
      if (cause instanceof Error && !('code' in cause))
        return reply.code(403).send({ error: 'review_refused', message: cause.message } satisfies ApiErrorBody);
      throw cause;
    }
  });
  app.post('/workforce/access/code', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity)
      return;
    const parsed = codeRequest.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_request', message: 'An enrolled staff identity is required' } satisfies ApiErrorBody);
    if (!mailer.configured)
      return reply.code(503).send({ error: 'email_required', message: 'Configure private email delivery before using restricted workforce records' } satisfies ApiErrorBody);
    const access = await beginPrivateAccess(sql, identity, parsed.data.staffId);
    if (!access)
      return reply.code(403).send({ error: 'contact_required', message: 'An independently established verified staff contact is required' } satisfies ApiErrorBody);
    await mailer.send({ to: access.email, subject: 'Your Geneus workforce access code', text: `Your Geneus workforce access code is ${access.code}. It works once for 15 minutes. Ignore this message if you did not request restricted workforce access.` });
    return reply.code(202).send({ sentTo: maskEmail(access.email), expiresOn: access.expiresOn });
  });
  app.post('/workforce/access/verify', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity)
      return;
    const parsed = codeConfirmation.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_request', message: 'Staff identity and six-digit verification code are required' } satisfies ApiErrorBody);
    const session = await completePrivateAccess(sql, identity, parsed.data.staffId, parsed.data.code);
    if (!session)
      return reply.code(403).send({ error: 'invalid_code', message: 'The code is invalid, expired or already used' } satisfies ApiErrorBody);
    await recordAuditEvent(sql, { facilityId: identity.facilityId, deviceId: identity.deviceId, actorStaffId: parsed.data.staffId, action: 'login', metadata: { context: 'restricted_workforce' } });
    return session;
  });
  app.post('/workforce/access/end', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity)
      return;
    const token = tokenHeader(request.headers['x-workforce-access']);
    if (token)
      await endPrivateAccess(sql, identity, token);
    return reply.code(204).send();
  });
  app.get('/workforce/evidence', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity)
      return;
    const staff = await privateStaff(sql, identity, tokenHeader(request.headers['x-workforce-access']));
    if (!staff)
      return reply.code(403).send({ error: 'private_verification_required', message: 'Verify your workforce contact to read restricted evidence' } satisfies ApiErrorBody);
    const parsed = evidenceQuery.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_request', message: 'Select a supported restricted record type' } satisfies ApiErrorBody);
    const privileged = canReadWorkforceEvidence(staff);
    if (parsed.data.staffId && parsed.data.staffId !== staff.staffId && !privileged)
      return reply.code(403).send({ error: 'forbidden', message: 'Credential evidence is restricted to its owner and authorized workforce readers' } satisfies ApiErrorBody);
    const records = (await recordsInFacility(sql, identity.facilityId, parsed.data.type)).filter((r) => {
      const owner = 'staffId' in r ? r.staffId : r.linkedStaffId;
      return privileged ? !parsed.data.staffId || owner === parsed.data.staffId : owner === staff.staffId;
    });
    await recordAuditEvent(sql, { facilityId: identity.facilityId, deviceId: identity.deviceId, actorStaffId: staff.staffId, action: 'view', entityType: parsed.data.type, metadata: { context: 'restricted_workforce', count: records.length } });
    return { records };
  });
  app.get('/workforce/rejections', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity)
      return;
    const staff = await privateStaff(sql, identity, tokenHeader(request.headers['x-workforce-access']));
    if (!staff)
      return reply.code(403).send({ error: 'private_verification_required', message: 'Verify your workforce contact first' } satisfies ApiErrorBody);
    const records = (await recordsInFacility(sql, identity.facilityId, 'sync_rejection')).filter((r) => r.visibility === 'restricted'
      && (canReadWorkforceEvidence(staff) || r.visibleToStaffIds?.includes(staff.staffId)));
    await recordAuditEvent(sql, { facilityId: identity.facilityId, deviceId: identity.deviceId, actorStaffId: staff.staffId, action: 'view', entityType: 'sync_rejection', metadata: { context: 'restricted_workforce', count: records.length } });
    return { records };
  });
  app.get('/workforce/readiness', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity)
      return;
    const parsed = z.object({ requestedBy: z.string().min(1) }).safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_request', message: 'Name the requesting staff member' } satisfies ApiErrorBody);
    const result = await authorizeStaff(sql, identity.facilityId, parsed.data.requestedBy, 'staff:manage');
    if ('denial' in result || !staffPermissions(result.staff).includes('staff:manage'))
      return reply.code(403).send({ error: 'forbidden', message: 'Workforce management access is required' } satisfies ApiErrorBody);
    return workforceReadiness(sql, identity.facilityId);
  });
};
