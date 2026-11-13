import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DOCUMENT_MAX_BYTES, ImportKind, ImportTemplateSave, InsuranceDocument, InsuranceDocumentUpload, Payer, PayerKind, SCHEMA_VERSION, StoredSubmissionProfile, SubmissionProfile, TariffImport,
  computeAllocation, documentContentType, isRoutine, staffPermissions,
  type ApiErrorBody, type Permission, type Staff,
} from '#shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord, insertRecord } from '../db/records.ts';
import type { DeviceIdentity } from '../devices/credentials.ts';
import { privateStaff } from '../workforce/privateAccess.ts';
import { confirmAllocations } from '../insurance/allocations.ts';
import { ContractRefusal, activateContract, activationBlockers, contractVersions, endContract, findContractVersion, insuranceState, saveDraft } from '../insurance/contracts.ts';
import { chargePositions, chargesById } from '../insurance/coverage.ts';
import { RefundRefusal, RefundRequest, recordRefund } from '../insurance/refunds.ts';
import { SetupRefusal, insuranceSetupStatus, setInsuranceSetup } from '../insurance/enablement.ts';
import { billingPeriods } from '../insurance/billingPeriods.ts';
import { applyTariffImport, listImportTemplates, saveImportTemplate } from '../insurance/tariffImport.ts';

/**
 * Online insurance actions. Each needs a server-verified staff identity — the
 * existing workforce access session (a one-time code sent to the staff
 * member's independently verified email, bound to this device, 15 minutes) —
 * never a staff id the device merely asserts. Permission is then decided from
 * the server's own staff row. Offline work (cover, checks, desk elections)
 * keeps using sync upload.
 */
type Verified = { identity: DeviceIdentity; staff: Staff };

const header = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);
const hashBody = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

const PayerSave = z.strictObject({
  id: z.string().regex(/^payer:[A-Za-z0-9_-]{4,100}$/).optional(),
  name: z.string().trim().min(1).max(200), kind: PayerKind, code: z.string().trim().min(1).max(30), active: z.boolean(),
});
const DraftSave = z.strictObject({ terms: z.unknown(), expectedRevision: z.number().int().positive().optional() });
const Activate = z.strictObject({
  contractVersionId: z.string().min(1), acknowledgeUnsupported: z.boolean().default(false), requestKey: z.string().min(8).max(200),
  /** Revoked devices whose unsent work the administrator accepts will never arrive — named one by one. */
  acceptRevokedDevices: z.array(z.string().min(1)).max(100).default([]),
});
const End = z.strictObject({ contractVersionId: z.string().min(1), endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().trim().min(1).max(1000), requestKey: z.string().min(8).max(200) });
const ChargeList = z.strictObject({ chargeIds: z.array(z.string().min(1)).min(1).max(200) });
const Confirm = ChargeList.extend({
  requestKey: z.string().min(8).max(200),
  basis: z.enum(['visit', 'routine_bulk', 'exception']),
  decision: z.enum(['apply_cover', 'self_pay']).default('apply_cover'),
  reason: z.string().trim().min(1).max(1000).optional(),
}).refine((b) => b.basis !== 'exception' || b.reason, { message: 'An exception needs a reason', path: ['reason'] })
  .refine((b) => b.decision !== 'self_pay' || b.basis === 'exception', { message: 'Recording self-pay is an exception', path: ['basis'] });

export const registerInsuranceRoutes = (app: FastifyInstance, sql: Sql): void => {
  /** `configure` needs setup or active; `billing` needs active billing. */
  const verified = async (request: FastifyRequest, reply: FastifyReply, permission: Permission, needs: 'any' | 'configure' | 'billing' = 'configure'): Promise<Verified | undefined> => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;
    const staff = await privateStaff(sql, identity, header(request.headers['x-workforce-access']));
    if (!staff) { reply.code(403).send({ error: 'private_verification_required', message: 'Verify your staff email code to use insurance and refund actions' } satisfies ApiErrorBody); return; }
    if (!staffPermissions(staff).includes(permission)) { reply.code(403).send({ error: 'forbidden', message: `This action needs ${permission}` } satisfies ApiErrorBody); return; }
    // Off for every hospital until an operator enables it after the rollout checks — refunds included.
    const state = await insuranceState(sql, identity.facilityId);
    const history = state !== 'active' && needs === 'billing' && (await billingPeriods(sql, identity.facilityId)).length > 0;
    if (state === 'off' && needs !== 'any' && !history) { reply.code(403).send({ error: 'insurance_not_enabled', message: 'Insurance is not enabled for this hospital' } satisfies ApiErrorBody); return; }
    // Billing work continues for charges raised while billing was on, even after it is turned off.
    if (needs === 'billing' && state !== 'active' && !history) { reply.code(403).send({ error: 'insurance_billing_inactive', message: 'Insurance billing is not active for this hospital yet' } satisfies ApiErrorBody); return; }
    return { identity, staff };
  };
  const invalid = (reply: FastifyReply, message: string) => reply.code(400).send({ error: 'invalid_request', message } satisfies ApiErrorBody);

  /**
   * Replays a completed request instead of repeating it, under an advisory lock
   * so two identical requests cannot both run. A reused key with a different
   * body is refused.
   */
  const once = async <T>(tx: Tx, who: Verified, key: string, operation: string, body: unknown, run: () => Promise<T>): Promise<{ replayed: boolean; response: T } | { conflict: true }> => {
    const facilityId = who.identity.facilityId;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`${facilityId}:${key}`}))`;
    const hash = hashBody(body);
    const [prior] = await tx<{ operation: string; staff_id: string; body_hash: string; response: T }[]>`SELECT operation, staff_id, body_hash, response FROM insurance_requests WHERE facility_id = ${facilityId} AND request_key = ${key}`;
    if (prior) return prior.operation === operation && prior.staff_id === who.staff.id && prior.body_hash === hash ? { replayed: true, response: prior.response } : { conflict: true };
    const response = await run();
    await tx`INSERT INTO insurance_requests (facility_id, request_key, operation, staff_id, body_hash, response) VALUES (${facilityId}, ${key}, ${operation}, ${who.staff.id}, ${hash}, ${tx.json(response as never)})`;
    return { replayed: false, response };
  };
  const refusal = (reply: FastifyReply, cause: unknown) => {
    if (cause instanceof ContractRefusal || cause instanceof RefundRefusal || cause instanceof SetupRefusal) return reply.code(409).send({ error: cause.code, message: cause.message, ...(cause.details ? { details: cause.details } : {}) });
    throw cause;
  };

  app.post('/insurance/payers/save', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:manage'); if (!who) return;
    const body = PayerSave.safeParse(request.body); if (!body.success) return invalid(reply, 'Give the payer a name, kind and code');
    const now = new Date().toISOString();
    const payer = await sql.begin(async (tx) => {
      await tx`SELECT id FROM facilities WHERE id = ${who.identity.facilityId} FOR UPDATE`;
      const fields = { name: body.data.name, kind: body.data.kind, code: body.data.code, active: body.data.active };
      const existing = body.data.id ? await findRecord<Payer>(tx, 'payer', body.data.id) : undefined;
      if (existing && existing.facilityId !== who.identity.facilityId) return undefined;
      if (existing) {
        const next = Payer.parse({ ...existing, ...fields, updatedBy: who.staff.id, updatedOn: now });
        await tx`UPDATE payers SET name = ${next.name}, kind = ${next.kind}, code = ${next.code}, active = ${next.active}, updated_by = ${who.staff.id}, updated_on = ${now} WHERE id = ${next.id}`;
        return next;
      }
      const created = Payer.parse({ id: body.data.id ?? `payer:${randomUUID()}`, type: 'payer', facilityId: who.identity.facilityId, schemaVersion: SCHEMA_VERSION,
        createdBy: who.staff.id, createdOn: now, deviceId: who.identity.deviceId, ...fields });
      await insertRecord(tx, 'payer', created);
      return created;
    });
    if (!payer) return reply.code(404).send({ error: 'not_found', message: 'This payer is not in this hospital' } satisfies ApiErrorBody);
    await recordAuditEvent(sql, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: body.data.id ? 'update' : 'create', entityType: 'payer', entityId: payer.id, metadata: { context: 'insurance' } });
    return payer;
  });

  app.post('/insurance/contracts/list', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:read'); if (!who) return;
    const versions = await contractVersions(sql, who.identity.facilityId);
    await recordAuditEvent(sql, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'view', entityType: 'payer', metadata: { context: 'insurance_contracts', count: versions.length } });
    return { versions };
  });

  /**
   * Versions without their prices, for an administrator who activates or ends
   * contracts but does not read them: the decision needs the version, dates and
   * status, never the tariff.
   */
  app.post('/insurance/contracts/summaries', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:activate'); if (!who) return;
    const versions = await contractVersions(sql, who.identity.facilityId);
    return { versions: versions.map((v) => ({ id: v.id, contractId: v.contractId, version: v.version, status: v.status, payerId: v.terms.payerId, effectiveFrom: v.terms.effectiveFrom, effectiveTo: v.terms.effectiveTo, endedOn: v.endedOn, endReason: v.endReason, activatedOn: v.activatedOn })) };
  });

  app.post('/insurance/contracts/draft', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:manage'); if (!who) return;
    const body = DraftSave.safeParse(request.body); if (!body.success) return invalid(reply, 'Send the contract terms to save');
    try {
      const saved = await sql.begin((tx) => saveDraft(tx, who.identity.facilityId, who.staff.id, body.data));
      await recordAuditEvent(sql, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'update', entityType: 'payer', entityId: saved.version.terms.payerId, metadata: { context: 'insurance_contract_draft', contractVersionId: saved.version.id, revision: saved.version.revision } });
      return saved;
    } catch (cause) { return refusal(reply, cause); }
  });

  app.post('/insurance/contracts/readiness', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:activate'); if (!who) return;
    return { devices: await activationBlockers(sql, who.identity.facilityId) };
  });

  app.post('/insurance/contracts/activate', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:activate'); if (!who) return;
    const body = Activate.safeParse(request.body); if (!body.success) return invalid(reply, 'Choose the contract version and a request key');
    try {
      const result = await sql.begin((tx) => once(tx, who, body.data.requestKey, 'activate', body.data, () => activateContract(tx, {
        facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, staffId: who.staff.id,
        contractVersionId: body.data.contractVersionId, acknowledgeUnsupported: body.data.acknowledgeUnsupported, acceptRevokedDevices: body.data.acceptRevokedDevices,
      })));
      if ('conflict' in result) return reply.code(409).send({ error: 'request_reused', message: 'This request key was already used for a different action' } satisfies ApiErrorBody);
      if (!result.replayed) await recordAuditEvent(sql, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'update', entityType: 'cover_schedule', metadata: { context: 'insurance_contract_activated', contractVersionId: result.response.contractVersionId, schedules: result.response.scheduleIds.length, unsupported: result.response.unsupported.length, acceptedRevokedDevices: result.response.acceptedRevokedDevices.join(',') } });
      return result.response;
    } catch (cause) { return refusal(reply, cause); }
  });

  /** Ends cover under an active version from today or later. Confirmed splits are snapshots and never change. */
  app.post('/insurance/contracts/end', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:activate'); if (!who) return;
    const body = End.safeParse(request.body); if (!body.success) return invalid(reply, 'Choose the contract version, the end date and a reason');
    try {
      const result = await sql.begin((tx) => once(tx, who, body.data.requestKey, 'end', body.data, () => endContract(tx, {
        facilityId: who.identity.facilityId, staffId: who.staff.id, contractVersionId: body.data.contractVersionId, endsOn: body.data.endsOn, reason: body.data.reason,
      })));
      if ('conflict' in result) return reply.code(409).send({ error: 'request_reused', message: 'This request key was already used for a different action' } satisfies ApiErrorBody);
      if (!result.replayed) await recordAuditEvent(sql, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'update', entityType: 'cover_schedule', metadata: { context: 'insurance_contract_ended', contractVersionId: result.response.contractVersionId, endsOn: result.response.endsOn } });
      return result.response;
    } catch (cause) { return refusal(reply, cause); }
  });

  /**
   * What the officer sees before confirming. The payer share and contract
   * adjustment are returned only to staff who may read contracts.
   */
  app.post('/insurance/allocations/preview', async (request, reply) => {
    const who = await verified(request, reply, 'coverage:confirm', 'billing'); if (!who) return;
    const body = ChargeList.safeParse(request.body); if (!body.success) return invalid(reply, 'Choose up to 200 charges');
    const mayReadContracts = staffPermissions(who.staff).includes('insurance_contract:read');
    const facilityId = who.identity.facilityId;
    const charges = await chargesById(sql, facilityId, body.data.chargeIds);
    const positions = await chargePositions(sql, facilityId, charges);
    const items = [];
    for (const position of positions.values()) {
      const { estimate, money, charge } = position;
      const paid = money.receivedMinor + money.waivedByPaymentMinor - money.refundedMinor;
      let split;
      if (mayReadContracts && estimate.state === 'estimated') {
        const version = await findContractVersion(sql, facilityId, estimate.schedule.contractVersionId);
        const computed = version ? computeAllocation({ terms: version.terms, planCode: estimate.cover.planCode, charge, units: estimate.units }) : undefined;
        if (computed?.ok) split = computed.split;
      }
      items.push({
        chargeId: charge.id, patientId: charge.patientId, state: estimate.state,
        ...(estimate.state === 'undetermined' ? { reason: estimate.reason, detail: estimate.detail } : {}),
        patientResponsibilityMinor: position.baseMinor, undeterminedMinor: position.undeterminedMinor, balanceMinor: position.balanceMinor,
        routine: isRoutine(estimate, paid), ...(split ? { split } : {}),
      });
    }
    return { items };
  });

  app.post('/insurance/allocations/confirm', async (request, reply) => {
    const who = await verified(request, reply, 'coverage:confirm', 'billing'); if (!who) return;
    const body = Confirm.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues.map((i) => i.message).join('; '));
    const result = await sql.begin((tx) => once(tx, who, body.data.requestKey, 'confirm', body.data, () => confirmAllocations(tx, {
      facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, staffId: who.staff.id, requestKey: body.data.requestKey,
      chargeIds: body.data.chargeIds, basis: body.data.basis, decision: body.data.decision, reason: body.data.reason,
    })));
    if ('conflict' in result) return reply.code(409).send({ error: 'request_reused', message: 'This request key was already used for a different action' } satisfies ApiErrorBody);
    if (!result.replayed) await recordAuditEvent(sql, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'create', entityType: 'coverage_allocation', metadata: { context: 'insurance_confirm', basis: body.data.basis, decision: body.data.decision, confirmed: result.response.filter((o) => o.outcome === 'confirmed').length, skipped: result.response.filter((o) => o.outcome === 'skipped').length } });
    return { outcomes: result.response };
  });

  app.post('/billing/refunds', async (request, reply) => {
    const who = await verified(request, reply, 'payment:refund', 'billing'); if (!who) return;
    const body = RefundRequest.safeParse(request.body); if (!body.success) return invalid(reply, 'Choose the charges, amounts, method and a reason for the refund');
    try {
      const { refund, replayed } = await sql.begin((tx) => recordRefund(tx, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, staffId: who.staff.id, request: body.data }));
      if (!replayed) await recordAuditEvent(sql, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'create', entityType: 'refund', entityId: refund.id, metadata: { context: 'refund', charges: refund.allocations.length } });
      return reply.code(replayed ? 200 : 201).send(refund);
    } catch (cause) { return refusal(reply, cause); }
  });

  /* ---------------- Setup (Milestone 1) ---------------- */

  /** What the hospital has and still needs; readable by anyone who configures or activates insurance. */
  app.post('/insurance/setup/status', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:activate', 'any') ?? undefined;
    if (!who) return;
    return insuranceSetupStatus(sql, who.identity.facilityId);
  });
  app.post('/insurance/setup/status/officer', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:manage', 'any'); if (!who) return;
    return insuranceSetupStatus(sql, who.identity.facilityId);
  });

  /** A hospital administrator enters or leaves setup. Billing activation is never reachable here. */
  app.post('/insurance/setup', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:activate', 'any'); if (!who) return;
    const body = z.strictObject({ state: z.enum(['off', 'setup']) }).safeParse(request.body);
    if (!body.success) return invalid(reply, 'Choose setup or off');
    try {
      const state = await setInsuranceSetup(sql, { facilityId: who.identity.facilityId, staffId: who.staff.id, deviceId: who.identity.deviceId, to: body.data.state });
      return { state };
    } catch (cause) { return refusal(reply, cause); }
  });

  /* ---------------- Documents ---------------- */

  const docRow = (r: Record<string, unknown>) => InsuranceDocument.parse({
    id: r.id, payerId: r.payer_id, documentType: r.document_type, title: r.title, fileName: r.file_name, mimeType: r.mime_type, byteSize: r.byte_size, sha256: r.sha256,
    version: r.version, ...(r.replaces ? { replaces: r.replaces } : {}), ...(r.effective_from ? { effectiveFrom: r.effective_from } : {}), ...(r.notes ? { notes: r.notes } : {}),
    verification: r.verification, ...(r.verified_by ? { verifiedBy: r.verified_by, verifiedOn: new Date(r.verified_on as string).toISOString() } : {}), ...(r.verification_note ? { verificationNote: r.verification_note } : {}),
    uploadedBy: r.uploaded_by, uploadedOn: new Date(r.uploaded_on as string).toISOString(),
  });

  /**
   * Upload: the file is the body; its metadata a URL-encoded JSON header. The
   * content must be what it claims (sniffed, never trusted from the browser),
   * within the size limit, and match its checksum. Stored server-side only.
   */
  app.post('/insurance/documents', { bodyLimit: DOCUMENT_MAX_BYTES }, async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:manage'); if (!who) return;
    let meta: unknown; try { meta = JSON.parse(decodeURIComponent(header(request.headers['x-document-meta']) ?? '')); } catch { return invalid(reply, 'Describe the document'); }
    const upload = InsuranceDocumentUpload.safeParse(meta);
    const body = request.body;
    if (!upload.success) return invalid(reply, upload.error.issues.map((i) => i.message).join('; '));
    if (!Buffer.isBuffer(body) || !body.length || body.length > DOCUMENT_MAX_BYTES) return invalid(reply, 'Choose a PDF or image up to 10 MB');
    const mime = documentContentType(body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (!mime || sha256 !== header(request.headers['x-file-sha256'])) return invalid(reply, 'The file is not a PDF or image, or did not arrive intact');
    const result = await sql.begin(async (tx) => {
      await tx`SELECT id FROM facilities WHERE id = ${who.identity.facilityId} FOR UPDATE`;
      const [payer] = await tx`SELECT id FROM payers WHERE facility_id = ${who.identity.facilityId} AND id = ${upload.data.payerId}`;
      if (!payer) return { error: 'unknown_payer' as const };
      let version = 1;
      if (upload.data.replaces) {
        const [previous] = await tx<{ version: number; payer_id: string; document_type: string }[]>`SELECT version, payer_id, document_type FROM insurance_documents WHERE facility_id = ${who.identity.facilityId} AND id = ${upload.data.replaces}`;
        if (!previous || previous.payer_id !== upload.data.payerId || previous.document_type !== upload.data.documentType) return { error: 'invalid_replaces' as const };
        const [later] = await tx`SELECT 1 FROM insurance_documents WHERE facility_id = ${who.identity.facilityId} AND replaces = ${upload.data.replaces}`;
        if (later) return { error: 'already_replaced' as const };
        version = previous.version + 1;
      }
      const id = `insurance_document:${randomUUID()}`;
      await tx`INSERT INTO insurance_documents (id, facility_id, payer_id, document_type, title, file_name, mime_type, byte_size, sha256, content, version, replaces, effective_from, notes, uploaded_by, device_id)
        VALUES (${id}, ${who.identity.facilityId}, ${upload.data.payerId}, ${upload.data.documentType}, ${upload.data.title}, ${upload.data.fileName}, ${mime}, ${body.length}, ${sha256}, ${body}, ${version},
          ${upload.data.replaces ?? null}, ${upload.data.effectiveFrom ?? null}, ${upload.data.notes ?? null}, ${who.staff.id}, ${who.identity.deviceId})`;
      await recordAuditEvent(tx, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'create', entityType: 'payer', entityId: upload.data.payerId, metadata: { context: 'insurance_document_uploaded', documentId: id, documentType: upload.data.documentType, version } });
      return { id };
    });
    if (result.error || !result.id) return reply.code(409).send({ error: result.error ?? 'conflict', message: result.error === 'unknown_payer' ? 'Choose a payer of this hospital' : 'Replace the current version of a document of the same payer and type' } satisfies ApiErrorBody);
    const [row] = await sql`SELECT * FROM insurance_documents WHERE id = ${result.id}`;
    return reply.code(201).send(docRow(row));
  });

  app.post('/insurance/documents/list', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:read'); if (!who) return;
    const body = z.strictObject({ payerId: z.string().min(1).optional() }).safeParse(request.body ?? {});
    if (!body.success) return invalid(reply, 'Choose a payer');
    const rows = body.data.payerId
      ? await sql`SELECT id, payer_id, document_type, title, file_name, mime_type, byte_size, sha256, version, replaces, effective_from, notes, verification, verified_by, verified_on, verification_note, uploaded_by, uploaded_on FROM insurance_documents WHERE facility_id = ${who.identity.facilityId} AND payer_id = ${body.data.payerId} ORDER BY uploaded_on`
      : await sql`SELECT id, payer_id, document_type, title, file_name, mime_type, byte_size, sha256, version, replaces, effective_from, notes, verification, verified_by, verified_on, verification_note, uploaded_by, uploaded_on FROM insurance_documents WHERE facility_id = ${who.identity.facilityId} ORDER BY uploaded_on`;
    return { documents: rows.map(docRow) };
  });

  /** Download: the stored bytes with their sniffed type, as an attachment, never rendered inline. Audited. */
  app.post<{ Params: { id: string } }>('/insurance/documents/:id/file', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:read'); if (!who) return;
    const [file] = await sql<{ mime_type: string; content: Buffer; file_name: string; payer_id: string }[]>`SELECT mime_type, content, file_name, payer_id FROM insurance_documents WHERE facility_id = ${who.identity.facilityId} AND id = ${request.params.id}`;
    if (!file) return reply.code(404).send({ error: 'not_found', message: 'This document is not in this hospital' } satisfies ApiErrorBody);
    await recordAuditEvent(sql, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'view', entityType: 'payer', entityId: file.payer_id, metadata: { context: 'insurance_document_downloaded', documentId: request.params.id } });
    return reply.type(file.mime_type).header('content-disposition', `attachment; filename="${file.file_name.replace(/[^\w.\- ]+/g, '_')}"`).header('x-content-type-options', 'nosniff').header('cache-control', 'no-store').send(file.content);
  });

  /** Verification is recorded once, by name, and never changes the document. */
  app.post<{ Params: { id: string } }>('/insurance/documents/:id/verify', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:manage'); if (!who) return;
    const body = z.strictObject({ verification: z.enum(['verified', 'rejected']), note: z.string().trim().min(1).max(1000).optional() }).safeParse(request.body);
    if (!body.success) return invalid(reply, 'Choose verified or rejected');
    const updated = await sql`UPDATE insurance_documents SET verification = ${body.data.verification}, verified_by = ${who.staff.id}, verified_on = now(), verification_note = ${body.data.note ?? null}
      WHERE facility_id = ${who.identity.facilityId} AND id = ${request.params.id} AND verification = 'unverified' RETURNING *`;
    if (!updated.length) return reply.code(409).send({ error: 'already_verified', message: 'This document was already reviewed' } satisfies ApiErrorBody);
    await recordAuditEvent(sql, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'update', entityType: 'payer', entityId: updated[0].payer_id as string, metadata: { context: 'insurance_document_reviewed', documentId: request.params.id, verification: body.data.verification } });
    return docRow(updated[0]);
  });

  /* ---------------- Submission method per payer ---------------- */

  app.post('/insurance/submission/list', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:read'); if (!who) return;
    const rows = await sql<{ payer_id: string; profile: unknown; revision: number; updated_by: string; updated_on: string }[]>`SELECT payer_id, profile, revision, updated_by, updated_on FROM payer_submission_profiles WHERE facility_id = ${who.identity.facilityId}`;
    return { profiles: rows.map((r) => StoredSubmissionProfile.parse({ payerId: r.payer_id, profile: r.profile, revision: r.revision, updatedBy: r.updated_by, updatedOn: new Date(r.updated_on).toISOString() })) };
  });

  /** Manual submission only. Direct submission is shown as coming soon and refused here. */
  app.post('/insurance/submission/save', async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:manage'); if (!who) return;
    const body = z.strictObject({ payerId: z.string().min(1), profile: SubmissionProfile, expectedRevision: z.number().int().positive().optional() }).safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues.map((i) => `${i.path.slice(1).join('.')}: ${i.message}`).join('; '));
    if (body.data.profile.method === 'direct') return reply.code(409).send({ error: 'direct_submission_unavailable', message: 'Direct submission to HMOs is not available yet. Choose manual submission' } satisfies ApiErrorBody);
    const result = await sql.begin(async (tx) => {
      const [payer] = await tx`SELECT id FROM payers WHERE facility_id = ${who.identity.facilityId} AND id = ${body.data.payerId}`;
      if (!payer) return 'unknown_payer' as const;
      const [current] = await tx<{ revision: number }[]>`SELECT revision FROM payer_submission_profiles WHERE facility_id = ${who.identity.facilityId} AND payer_id = ${body.data.payerId} FOR UPDATE`;
      if ((current?.revision ?? undefined) !== body.data.expectedRevision) return 'stale' as const;
      const revision = (current?.revision ?? 0) + 1;
      await tx`INSERT INTO payer_submission_profiles (facility_id, payer_id, profile, revision, updated_by) VALUES (${who.identity.facilityId}, ${body.data.payerId}, ${tx.json(body.data.profile as never)}, ${revision}, ${who.staff.id})
        ON CONFLICT (facility_id, payer_id) DO UPDATE SET profile = EXCLUDED.profile, revision = EXCLUDED.revision, updated_by = EXCLUDED.updated_by, updated_on = now()`;
      await recordAuditEvent(tx, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'update', entityType: 'payer', entityId: body.data.payerId, metadata: { context: 'insurance_submission_method', revision, channel: body.data.profile.channel } });
      return revision;
    });
    if (result === 'unknown_payer') return reply.code(404).send({ error: 'not_found', message: 'Choose a payer of this hospital' } satisfies ApiErrorBody);
    if (result === 'stale') return reply.code(409).send({ error: 'stale_submission_method', message: 'Someone changed this payer\'s submission method. Review the current one' } satisfies ApiErrorBody);
    return { payerId: body.data.payerId, profile: body.data.profile, revision: result };
  });

  /* ---------------- Spreadsheet import (Milestone 2) ---------------- */

  /** Saved column mappings. Generic by kind; the tariff kind needs contract management. */
  const IMPORT_PERMISSION: Record<ImportKind, Permission> = { contract_tariff: 'insurance_contract:manage' };
  app.post('/insurance/import-templates/list', async (request, reply) => {
    const body = z.strictObject({ kind: ImportKind }).safeParse(request.body);
    if (!body.success) return invalid(reply, 'Choose what is being imported');
    const who = await verified(request, reply, IMPORT_PERMISSION[body.data.kind]); if (!who) return;
    return { templates: await listImportTemplates(sql, who.identity.facilityId, body.data.kind) };
  });
  app.post('/insurance/import-templates/save', async (request, reply) => {
    const body = ImportTemplateSave.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const who = await verified(request, reply, IMPORT_PERMISSION[body.data.kind]); if (!who) return;
    try {
      const saved = await sql.begin((tx) => saveImportTemplate(tx, who.identity.facilityId, who.staff.id, body.data));
      await recordAuditEvent(sql, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'update', entityType: 'facility', entityId: who.identity.facilityId, metadata: { context: 'import_template_saved', templateId: saved.id, kind: saved.kind, revision: saved.revision } });
      return saved;
    } catch (cause) { return refusal(reply, cause); }
  });

  /**
   * Applies confirmed tariff rows to the payer's draft contract. Idempotent by
   * request key, audited with the file's name and checksum (never its content),
   * and never activates anything: the draft is reviewed and activated as usual.
   */
  app.post('/insurance/contracts/import-tariff', { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const who = await verified(request, reply, 'insurance_contract:manage'); if (!who) return;
    const body = TariffImport.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.issues.slice(0, 20).map((i) => i.message).join('; '));
    try {
      const result = await sql.begin((tx) => once(tx, who, body.data.requestKey, 'import_tariff', body.data, () => applyTariffImport(tx, who.identity.facilityId, who.staff.id, body.data)));
      if ('conflict' in result) return reply.code(409).send({ error: 'request_reused', message: 'This request key was already used for a different action' } satisfies ApiErrorBody);
      if (!result.replayed) await recordAuditEvent(sql, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'update', entityType: 'payer', entityId: body.data.payerId, metadata: {
        context: 'insurance_tariff_imported', contractVersionId: result.response.contractVersionId, revision: result.response.revision, mode: body.data.mode,
        fileName: body.data.source.fileName, sha256: body.data.source.sha256, rows: body.data.source.rows, lines: body.data.lines.length,
        added: result.response.added, changed: result.response.changed, unchanged: result.response.unchanged, removed: result.response.removed, ...(body.data.source.templateId ? { templateId: body.data.source.templateId } : {}),
      } });
      return result.response;
    } catch (cause) { return refusal(reply, cause); }
  });
};

