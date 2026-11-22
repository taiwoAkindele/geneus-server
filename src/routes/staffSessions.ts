import {
  StaffPinEnrol,
  StaffSessionOpen,
  UploadRequest,
  isConfigurationWrite,
  type ApiErrorBody,
  type ConfigurationSaveResponse,
} from '#shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import {
  StaffSessionRefusal,
  endSession,
  enrolPin,
  requestStaff,
  verifiedRequestStaff,
  signInSession,
} from '../auth/staffSessions.ts';
import type { Sql } from '../db/client.ts';
import type { Signer } from '../lib/signing.ts';
import { processUpload } from '../sync/upload.ts';

const header = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
const refuse = (
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
  details?: unknown,
) =>
  reply.code(status).send({
    error,
    message,
    ...(details ? { details } : {}),
  } satisfies ApiErrorBody & {
    details?: unknown;
  });

/**
 * Staff sessions and online configuration. Signing in online proves the PIN
 * to the server; configuration is then saved directly — validated, versioned
 * and audited by the same rules as sync — and never queued on a device.
 */
export const registerStaffSessionRoutes = (
  app: FastifyInstance,
  sql: Sql,
  signer: Signer,
): void => {
  const failed = (reply: FastifyReply, cause: unknown) => {
    if (cause instanceof StaffSessionRefusal) {
      return refuse(
        reply,
        cause.code === 'unknown_staff' ? 404 : 403,
        cause.code,
        cause.message,
        cause.details,
      );
    }
    throw cause;
  };

  app.post('/staff/session/enrol', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) {
      return;
    }
    const body = StaffPinEnrol.safeParse(request.body);
    if (!body.success) {
      return refuse(
        reply,
        400,
        'invalid_request',
        body.error.issues.map((i) => i.message).join('; '),
      );
    }
    try {
      const session = await enrolPin(sql, identity, body.data);
      await recordAuditEvent(sql, {
        facilityId: identity.facilityId,
        deviceId: identity.deviceId,
        actorStaffId: body.data.staffId,
        action: 'login',
        metadata: {
          context: 'staff_pin_enrolled',
          proof: body.data.setupCode ? 'setup_code' : 'email',
        },
      });
      return session;
    } catch (cause) {
      return failed(reply, cause);
    }
  });

  app.post('/staff/session', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) {
      return;
    }
    const body = StaffSessionOpen.safeParse(request.body);
    if (!body.success) {
      return refuse(reply, 400, 'invalid_request', 'Enter your 6-digit PIN');
    }
    try {
      const session = await signInSession(sql, identity, body.data);
      await recordAuditEvent(sql, {
        facilityId: identity.facilityId,
        deviceId: identity.deviceId,
        actorStaffId: body.data.staffId,
        action: 'login',
        metadata: { context: 'staff_session' },
      });
      return session;
    } catch (cause) {
      return failed(reply, cause);
    }
  });

  app.post('/staff/session/end', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) {
      return;
    }
    const token = header(request.headers['x-staff-session']);
    if (token) {
      await endSession(sql, identity, token);
    }
    return reply.code(204).send();
  });

  /**
   * Saves configuration online. Every mutation must be configuration and be
   * attributed to the signed-in person; each is checked by the same rules as
   * a sync upload, plus an exact-version check, and the answer says what the
   * server accepted. Nothing is queued: a refusal leaves no trace to retry.
   */
  app.post('/config/save', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) {
      return;
    }
    const body = UploadRequest.safeParse(request.body);
    if (!body.success) {
      return refuse(reply, 400, 'invalid_request', 'The change is malformed');
    }
    const financial = body.data.mutations.some(
      (m) =>
        m.table === 'fee_item' ||
        m.table === 'billing_department' ||
        (['stock_item', 'service_definition', 'service_offering'].includes(m.table) &&
          'feeItemId' in m.data),
    );
    const staff = await (financial ? verifiedRequestStaff : requestStaff)(
      sql,
      identity,
      request.headers,
    );
    if (!staff) {
      return refuse(
        reply,
        403,
        'staff_session_required',
        'Confirm your PIN to save financial settings',
      );
    }
    for (const m of body.data.mutations) {
      if (!isConfigurationWrite(m.table, m.op, Object.keys(m.data ?? {}))) {
        return refuse(reply, 400, 'not_configuration', `${m.table} is not saved through settings`);
      }
      const by = m.op === 'put' ? m.data.createdBy : m.data.updatedBy;
      if (by !== staff.id) {
        return refuse(
          reply,
          403,
          'attribution_mismatch',
          'A change is saved in the name of the person signed in',
        );
      }
    }
    const billingPolicy = (request.query as Record<string, unknown>).billingPolicy === '1';
    const billingImport = (request.query as Record<string, unknown>).billingImport === '1';
    if (
      billingImport &&
      (body.data.mutations.length > 500 ||
        body.data.mutations.some(
          (m) =>
            m.table !== 'fee_item' ||
            m.op === 'delete' ||
            (m.op === 'patch' &&
              Object.keys(m.data).some(
                (k) => !['amountMinor', 'description', 'updatedBy', 'updatedOn'].includes(k),
              )),
        ))
    ) {
      return refuse(
        reply,
        400,
        'invalid_request',
        'A price import contains at most 500 catalogue items and only explicit price/description updates',
      );
    }
    const response = await processUpload(sql, identity, body.data, Date.now(), signer, {
      online: { staffId: staff.id, billingPolicy, atomic: billingImport },
    });
    const result: ConfigurationSaveResponse = {
      applied: response.applied,
      duplicates: response.duplicates,
      rejected: response.rejected.map((r) => ({
        table: r.table,
        id: r.id,
        category: r.category,
        reason: r.reason,
      })),
    };
    return reply.code(result.rejected.length ? 409 : 200).send(
      result.rejected.length
        ? {
            error: 'configuration_refused',
            message: result.rejected.map((r) => r.reason).join('; '),
            details: result,
          }
        : result,
    );
  });
};
