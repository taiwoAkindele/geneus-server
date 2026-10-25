import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Payment, PaymentAllocation, SCHEMA_VERSION, type IncomingTransfer, type Permission } from '#shared';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { authorizeStaff } from '../auth/staffAuthorization.ts';
import { availableOnCharge } from '../billing/ledger.ts';
import { accountFromTerminal, callPaystack, openPaystackSecret, PaystackAccount, PaystackTerminal, sealPaystackSecret, validPaystackSignature, VerifiedPaystackTransfer, type PaystackFetch } from '../billing/paystack.ts';
import type { Sql } from '../db/client.ts';
import { fromRow, insertRecord } from '../db/records.ts';
import type { Config } from '../lib/config.ts';

/** Exact request bytes, retained only for the lifetime of a webhook request. */
export const billingRawBodies = new WeakMap<FastifyRequest, string>();
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
const parseBody = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw Object.assign(new Error('Missing or invalid billing request fields'), { statusCode: 400 }); return result.data; };
const Actor = z.object({ actorStaffId: z.string().min(1) });
const LinkAccount = Actor.extend({ providerAccountId: z.string().regex(/^(?:\d+|VT_[A-Za-z0-9]+)$/), departmentId: z.string().min(1).optional() });
const Match = Actor.extend({ patientId: z.string().min(1), allocations: z.array(PaymentAllocation).min(1), requestId: z.string().uuid() })
  .refine((value) => new Set(value.allocations.map((a) => a.chargeId)).size === value.allocations.length);
type ConnectionRow = { encrypted_secret: string; mode: 'test' | 'live' };
type AccountRow = { id: string; department_id: string | null; account_number: string };

export const registerBillingRoutes = (app: FastifyInstance, sql: Sql, config: Config, fetcher: PaystackFetch = fetch) => {
  const authorize = async (request: FastifyRequest, reply: Parameters<typeof authenticateDevice>[2], permission: Permission) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;
    const actor = Actor.safeParse(request.body);
    if (!actor.success) { reply.code(400).send({ error: 'invalid_request', message: 'The acting staff member is required' }); return; }
    const result = await authorizeStaff(sql, identity.facilityId, actor.data.actorStaffId, permission);
    if ('denial' in result) { reply.code(403).send({ error: 'forbidden', message: 'Your account cannot perform this billing action' }); return; }
    return { ...identity, actorStaffId: actor.data.actorStaffId };
  };
  const connection = async (facilityId: string) => {
    if (!config.billingEncryptionKey) throw conflict('Paystack setup requires BILLING_ENCRYPTION_KEY on the server');
    const [row] = await sql<ConnectionRow[]>`SELECT encrypted_secret, mode FROM billing_connections WHERE facility_id = ${facilityId}`;
    if (!row) throw conflict('Connect this hospital\'s Paystack account first');
    return { secret: openPaystackSecret(row.encrypted_secret, config.billingEncryptionKey, facilityId), mode: row.mode };
  };
  app.post('/billing/connection/status', async (request, reply) => {
    const who = await authorize(request, reply, 'fee_item:manage'); if (!who) return;
    const [row] = await sql<{ mode: string }[]>`SELECT mode FROM billing_connections WHERE facility_id = ${who.facilityId}`;
    const accounts = await sql`SELECT id, account_number AS "accountNumber", account_name AS "accountName", bank_name AS "bankName", department_id AS "departmentId", mode
      FROM billing_receiving_accounts WHERE facility_id = ${who.facilityId} ORDER BY created_on`;
    return { configured: Boolean(row), mode: row?.mode, encryptionReady: Boolean(config.billingEncryptionKey), accounts,
      webhookPath: `/billing/paystack/${encodeURIComponent(who.facilityId)}/webhook` };
  });
  app.post('/billing/connection', async (request, reply) => {
    const who = await authorize(request, reply, 'fee_item:manage'); if (!who) return;
    const body = parseBody(Actor.extend({ secretKey: z.string().regex(/^sk_(test|live)_[A-Za-z0-9]+$/) }), request.body);
    if (!config.billingEncryptionKey) return reply.code(503).send({ error: 'not_configured', message: 'The server administrator must configure BILLING_ENCRYPTION_KEY first' });
    // Prove access before replacing a working connection. No key is returned or logged.
    await callPaystack(body.secretKey, '/transaction?perPage=1', fetcher);
    const mode = body.secretKey.startsWith('sk_test_') ? 'test' : 'live';
    const encrypted = sealPaystackSecret(body.secretKey, config.billingEncryptionKey, who.facilityId);
    await sql`INSERT INTO billing_connections (facility_id, encrypted_secret, mode, updated_by)
      VALUES (${who.facilityId}, ${encrypted}, ${mode}, ${who.actorStaffId})
      ON CONFLICT (facility_id) DO UPDATE SET encrypted_secret = EXCLUDED.encrypted_secret, mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, updated_on = now()`;
    return { configured: true, mode };
  });
  app.post('/billing/accounts/list', async (request, reply) => {
    const who = await authorize(request, reply, 'payment:receive'); if (!who) return;
    return sql`SELECT a.id, a.account_number AS "accountNumber", a.account_name AS "accountName", a.bank_name AS "bankName", a.department_id AS "departmentId", a.mode
      FROM billing_receiving_accounts a JOIN billing_connections c ON c.facility_id = a.facility_id AND c.mode = a.mode
      WHERE a.facility_id = ${who.facilityId} ORDER BY a.created_on`;
  });
  app.post('/billing/accounts/discover', async (request, reply) => {
    const who = await authorize(request, reply, 'fee_item:manage'); if (!who) return;
    const key = await connection(who.facilityId);
    const accounts = z.array(PaystackAccount).parse(await callPaystack(key.secret, '/dedicated_account?perPage=100', fetcher));
    return accounts.filter((a) => a.active && a.currency === 'NGN').map((a) => ({ providerAccountId: String(a.id), accountNumber: a.account_number, accountName: a.account_name, bankName: a.bank.name }));
  });
  app.post('/billing/accounts/link', async (request, reply) => {
    const who = await authorize(request, reply, 'fee_item:manage'); if (!who) return;
    const body = parseBody(LinkAccount, request.body); const key = await connection(who.facilityId);
    const account = body.providerAccountId.startsWith('VT_')
      ? accountFromTerminal(await callPaystack(key.secret, `/virtual_terminal/${body.providerAccountId}`, fetcher))
      : PaystackAccount.parse(await callPaystack(key.secret, `/dedicated_account/${body.providerAccountId}`, fetcher));
    if (!account.active || account.currency !== 'NGN' || String(account.id) !== body.providerAccountId) return reply.code(400).send({ error: 'invalid_account', message: 'Select an active NGN receiving account belonging to this Paystack connection' });
    if (body.departmentId) {
      const [department] = await sql`SELECT id FROM billing_departments WHERE id = ${body.departmentId} AND facility_id = ${who.facilityId} AND active`;
      if (!department) return reply.code(409).send({ error: 'department_not_synced', message: 'Save the department and wait for it to sync before linking its account' });
    }
    // An existing account cannot silently change ownership after receipts were assigned.
    const [existing] = await sql`SELECT id FROM billing_receiving_accounts WHERE facility_id = ${who.facilityId} AND mode = ${key.mode} AND provider_account_id = ${body.providerAccountId}`;
    if (existing) return reply.code(409).send({ error: 'already_linked', message: 'This receiving account is already linked. Existing ownership is retained for reconciliation history.' });
    const id = randomUUID();
    await sql`INSERT INTO billing_receiving_accounts (id, facility_id, provider_account_id, account_number, account_name, bank_name, department_id, mode, created_by)
      VALUES (${id}, ${who.facilityId}, ${body.providerAccountId}, ${account.account_number}, ${account.account_name}, ${account.bank.name}, ${body.departmentId ?? null}, ${key.mode}, ${who.actorStaffId})`;
    return { id, accountNumber: account.account_number, accountName: account.account_name, bankName: account.bank.name, departmentId: body.departmentId, mode: key.mode };
  });

  app.post('/billing/accounts/create-terminal', async (request, reply) => {
    const who = await authorize(request, reply, 'fee_item:manage'); if (!who) return;
    const body = parseBody(Actor.extend({ departmentId: z.string().min(1), notificationPhone: z.string().regex(/^\+[1-9]\d{7,14}$/) }), request.body);
    const key = await connection(who.facilityId);
    const [department] = await sql<{ name: string }[]>`SELECT name FROM billing_departments WHERE id = ${body.departmentId} AND facility_id = ${who.facilityId} AND active`;
    if (!department) throw conflict('Save the department and let it sync before creating its payment point');
    const [existing] = await sql`SELECT id FROM billing_receiving_accounts WHERE facility_id = ${who.facilityId} AND mode = ${key.mode} AND department_id = ${body.departmentId}`;
    if (existing) throw conflict('This department already has a receiving account. Use its existing bank details.');
    const terminal = PaystackTerminal.parse(await callPaystack(key.secret, '/virtual_terminal', fetcher, {
      name: department.name, currency: 'NGN', destinations: [{ target: body.notificationPhone, name: department.name }],
    }));
    const account = accountFromTerminal(terminal); const id = randomUUID();
    await sql`INSERT INTO billing_receiving_accounts (id, facility_id, provider_account_id, account_number, account_name, bank_name, department_id, mode, created_by)
      VALUES (${id}, ${who.facilityId}, ${terminal.code}, ${account.account_number}, ${account.account_name}, ${account.bank.name}, ${body.departmentId}, ${key.mode}, ${who.actorStaffId})`;
    return { id, accountNumber: account.account_number, accountName: account.account_name, bankName: account.bank.name, departmentId: body.departmentId, mode: key.mode };
  });

  const ingest = async (facilityId: string, reference: string, key: Awaited<ReturnType<typeof connection>>) => {
    const verified = VerifiedPaystackTransfer.parse(await callPaystack(key.secret, `/transaction/verify/${encodeURIComponent(reference)}`, fetcher));
    if (verified.reference !== reference || verified.domain !== key.mode) throw conflict('Paystack transaction does not match this connection');
    const [account] = await sql<AccountRow[]>`SELECT id, department_id, account_number FROM billing_receiving_accounts
      WHERE facility_id = ${facilityId} AND mode = ${key.mode} AND account_number = ${verified.authorization.receiver_bank_account_number}`;
    const [device] = await sql<{ id: string }[]>`SELECT id FROM devices WHERE facility_id = ${facilityId} ORDER BY id LIMIT 1`;
    if (!device) throw conflict('The hospital has no enrolled device');
    const now = new Date().toISOString();
    const record: IncomingTransfer = {
      id: `incoming_transfer:${randomUUID()}`, type: 'incoming_transfer', facilityId, schemaVersion: SCHEMA_VERSION,
      createdBy: 'system', createdOn: now, deviceId: device.id, provider: 'paystack', providerReference: reference,
      mode: key.mode,
      amountMinor: verified.amount, currency: verified.currency, receivedOn: verified.paid_at,
      receivingAccount: verified.authorization.receiver_bank_account_number, departmentId: account?.department_id ?? undefined,
      payerName: verified.authorization.sender_name || undefined,
    };
    // One immutable receipt per provider reference, including concurrent retries.
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM facilities WHERE id = ${facilityId} FOR UPDATE`;
      const [exists] = await tx`SELECT id FROM incoming_transfers WHERE facility_id = ${facilityId} AND mode = ${key.mode} AND provider_reference = ${reference}`;
      if (!exists) await insertRecord(tx, 'incoming_transfer', record);
    });
  };
  app.post<{ Params: { facilityId: string } }>('/billing/paystack/:facilityId/webhook', async (request, reply) => {
    const key = await connection(request.params.facilityId);
    if (!validPaystackSignature(billingRawBodies.get(request) ?? '', request.headers['x-paystack-signature'], key.secret)) return reply.code(401).send({ error: 'invalid_signature' });
    const event = z.object({ event: z.string(), data: z.unknown().optional() }).safeParse(request.body);
    if (!event.success) return reply.code(400).send({ error: 'invalid_event' });
    if (event.data.event !== 'charge.success') return { received: true };
    const data = z.object({ reference: z.string().min(1) }).safeParse(event.data.data);
    if (!data.success) return reply.code(400).send({ error: 'invalid_reference' });
    await ingest(request.params.facilityId, data.data.reference, key);
    return { received: true };
  });
  app.post('/billing/transfers/import', async (request, reply) => {
    const who = await authorize(request, reply, 'payment:receive'); if (!who) return;
    const { reference } = parseBody(Actor.extend({ reference: z.string().min(1).max(200) }), request.body);
    await ingest(who.facilityId, reference, await connection(who.facilityId));
    return { imported: true };
  });
  app.post<{ Params: { id: string } }>('/billing/transfers/:id/match', async (request, reply) => {
    const who = await authorize(request, reply, 'payment:receive'); if (!who) return;
    const body = parseBody(Match, request.body);
    const payment = await sql.begin(async (tx) => {
      const id = `payment:${body.requestId}`;
      const sameRequest = (row: Record<string, unknown>) => row.incoming_transfer_id === request.params.id && row.patient_id === body.patientId && row.created_by === who.actorStaffId && isDeepStrictEqual(row.allocations, body.allocations);
      const [prior] = await tx`SELECT * FROM payments WHERE id = ${id} AND facility_id = ${who.facilityId}`;
      if (prior) {
        if (!sameRequest(prior)) throw conflict('This allocation request was already used');
        return fromRow<Payment>('payment', prior);
      }
      const [source] = await tx<{ amount_minor: number; currency: string; department_id: string | null; provider_reference: string; mode: string }[]>`SELECT * FROM incoming_transfers WHERE facility_id = ${who.facilityId} AND id = ${request.params.id} FOR UPDATE`;
      if (!source) throw conflict('Transfer not found in this hospital');
      if (source.mode !== 'live') throw conflict('This is a test transfer. It cannot settle a patient bill.');
      // Recheck after waiting for a competing request with the same idempotency key.
      const [again] = await tx`SELECT * FROM payments WHERE id = ${id} AND facility_id = ${who.facilityId}`;
      if (again) { if (!sameRequest(again)) throw conflict('This allocation request was already used'); return fromRow<Payment>('payment', again); }
      const priorPayments = await tx<{ amount_minor: number; reverses: string | null }[]>`SELECT amount_minor, reverses FROM payments WHERE facility_id = ${who.facilityId} AND incoming_transfer_id = ${request.params.id}`;
      const available = source.amount_minor - priorPayments.reduce((n, p) => n + (p.reverses ? -1 : 1) * p.amount_minor, 0);
      const amountMinor = body.allocations.reduce((n, a) => n + a.amountMinor, 0);
      if (amountMinor > available) throw conflict('This transfer has already been allocated. Refresh incoming transfers.');
      const ids = body.allocations.map((a) => a.chargeId);
      const charges = await tx<{ id: string; patient_id: string; currency: string; department_id: string | null }[]>`SELECT id, patient_id, currency, department_id FROM charges WHERE facility_id = ${who.facilityId} AND id = ANY(${ids}) ORDER BY id FOR UPDATE`;
      for (const a of body.allocations) {
        const charge = charges.find((c) => c.id === a.chargeId);
        if (!charge || charge.patient_id !== body.patientId || charge.currency !== source.currency || (source.department_id && source.department_id !== charge.department_id)) throw conflict('Select this patient\'s synced bills in the receiving department and currency');
        if (a.amountMinor > await availableOnCharge(tx, who.facilityId, a.chargeId)) throw conflict('An allocation exceeds the current bill balance. Refresh the patient account.');
      }
      await tx`SELECT id FROM facilities WHERE id = ${who.facilityId} FOR UPDATE`;
      const [receiptSequence] = await tx<{ n: number }[]>`SELECT COALESCE(MAX(substring(receipt_number FROM char_length(${who.facilityId}) + 4 FOR 6)::int), 0) + 1 AS n FROM payments WHERE facility_id = ${who.facilityId}`;
      const next = receiptSequence.n;
      if (next > 999999) throw conflict('Receipt sequence exhausted');
      const receiptNumber = `${who.facilityId}-R-${String(next).padStart(6, '0')}-${randomBytes(1).toString('hex').toUpperCase()}`;
      const record = Payment.parse({ id, type: 'payment', facilityId: who.facilityId, deviceId: who.deviceId, schemaVersion: SCHEMA_VERSION,
        createdBy: who.actorStaffId, createdOn: new Date().toISOString(), patientId: body.patientId, method: 'transfer',
        amountMinor, currency: source.currency, incomingTransferId: request.params.id, reference: source.provider_reference,
        receiptNumber,
        allocations: body.allocations });
      await insertRecord(tx, 'payment', record); return record;
    });
    return payment;
  });
};
