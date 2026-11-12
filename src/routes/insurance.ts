import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Payer, PayerKind, SCHEMA_VERSION, computeAllocation, isRoutine, staffPermissions,
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
import { ContractRefusal, activateContract, activationBlockers, contractVersions, endContract, findContractVersion, insuranceEnabled, saveDraft } from '../insurance/contracts.ts';
import { chargePositions, chargesById } from '../insurance/coverage.ts';
import { RefundRefusal, RefundRequest, recordRefund } from '../insurance/refunds.ts';

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
  const verified = async (request: FastifyRequest, reply: FastifyReply, permission: Permission): Promise<Verified | undefined> => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;
    const staff = await privateStaff(sql, identity, header(request.headers['x-workforce-access']));
    if (!staff) { reply.code(403).send({ error: 'private_verification_required', message: 'Verify your staff email code to use insurance and refund actions' } satisfies ApiErrorBody); return; }
    if (!staffPermissions(staff).includes(permission)) { reply.code(403).send({ error: 'forbidden', message: `This action needs ${permission}` } satisfies ApiErrorBody); return; }
    // Off for every hospital until an operator enables it after the rollout checks — refunds included.
    if (!(await insuranceEnabled(sql, identity.facilityId))) { reply.code(403).send({ error: 'insurance_not_enabled', message: 'Insurance and refunds are not enabled for this hospital yet' } satisfies ApiErrorBody); return; }
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
    if (cause instanceof ContractRefusal || cause instanceof RefundRefusal) return reply.code(409).send({ error: cause.code, message: cause.message, ...(cause.details ? { details: cause.details } : {}) });
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
    const who = await verified(request, reply, 'coverage:confirm'); if (!who) return;
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
    const who = await verified(request, reply, 'coverage:confirm'); if (!who) return;
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
    const who = await verified(request, reply, 'payment:refund'); if (!who) return;
    const body = RefundRequest.safeParse(request.body); if (!body.success) return invalid(reply, 'Choose the charges, amounts, method and a reason for the refund');
    try {
      const { refund, replayed } = await sql.begin((tx) => recordRefund(tx, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, staffId: who.staff.id, request: body.data }));
      if (!replayed) await recordAuditEvent(sql, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staff.id, action: 'create', entityType: 'refund', entityId: refund.id, metadata: { context: 'refund', charges: refund.allocations.length } });
      return reply.code(replayed ? 200 : 201).send(refund);
    } catch (cause) { return refusal(reply, cause); }
  });
};

