import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DocumentLinkRequest, SendToPatientRequest, Payment, PaymentAllocation, ServiceChargeAllocation,SCHEMA_VERSION, billKeyParts, staffPermissions, type DocumentLinkResponse, type DocumentLinkStopResponse, type IncomingTransfer, type Permission } from '#shared';
import { createDocumentLink, patientPagePath, stopDocumentLinks } from '../patientDocuments/links.ts';
import { sendDocumentToPatient, type MessagingDeps } from '../messaging/patientMessages.ts';
import { providerConnection } from '../billing/connection.ts';
import { nextReceiptNumber } from '../billing/receipts.ts';
import { confirmCheckout } from '../billing/checkout.ts';
import { loadBill, loadReceipt } from '../patientDocuments/documentData.ts';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { verifiedRequestStaff } from '../auth/staffSessions.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { availableOnCharge } from '../billing/ledger.ts';
import { reserveSource,sourceCapacity } from '../billing/sourceCapacity.ts';
import {integratedEnabled,integratedReadiness} from '../billing/integrated.ts';
import {buildPatientStatement} from '../billing/patientStatements.ts';
import {confirmInsuranceReturn} from '../billing/insuranceReturns.ts';
import { catalogueEnabled, catalogueReadiness, BillingCompatibilityError } from '../billing/catalogue.ts';
import { accountFromTerminal, callPaystack, PaystackTerminal, sealPaystackSecret, type PaystackFetch } from '../billing/paystack.ts';
import { paymentProvider, PROVIDERS, serialiseCredentials } from '../billing/providers/index.ts';
import type { Sql } from '../db/client.ts';
import { findRecord,fromRow, insertRecord } from '../db/records.ts';
import type { Config } from '../lib/config.ts';

/** Exact request bytes, retained only for the lifetime of a webhook request. */
export const billingRawBodies = new WeakMap<FastifyRequest, string>();
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
const parseBody = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw Object.assign(new Error('Missing or invalid billing request fields'), { statusCode: 400 }); return result.data; };
const Actor = z.object({ actorStaffId: z.string().min(1).optional() });
/** A provider's own account id: a Paystack dedicated-account number or VT_ code, a Monnify account reference, ... */
const LinkAccount = Actor.extend({ providerAccountId: z.string().regex(/^[A-Za-z0-9_|-]{1,100}$/), departmentId: z.string().min(1).optional() });
const Match = Actor.extend({ patientId: z.string().min(1), allocations: z.array(PaymentAllocation).min(1), requestId: z.string().uuid() })
  .refine((value) => new Set(value.allocations.map((a) => a.chargeId)).size === value.allocations.length);
type AccountRow = { id: string; department_id: string | null; account_number: string };

export const registerBillingRoutes = (app: FastifyInstance, sql: Sql, config: Config, fetcher: PaystackFetch = fetch, messaging?: MessagingDeps) => {
  const authorize = async (request: FastifyRequest, reply: Parameters<typeof authenticateDevice>[2], permission: Permission|readonly Permission[]) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;
    const staff = await verifiedRequestStaff(sql, identity, request.headers);
    if (!staff) { reply.code(403).send({ error: 'staff_session_required', message: 'Confirm your PIN to continue' }); return; }
    if (await catalogueEnabled(sql,identity.facilityId) && request.headers['x-billing-catalogue-version']!=='1') throw new BillingCompatibilityError('Update this financial client before continuing');
    if(await integratedEnabled(sql,identity.facilityId)&&request.headers['x-integrated-billing-version']!=='1')throw new BillingCompatibilityError('Update this financial client before continuing');
    const actor = Actor.safeParse(request.body ?? {});
    if (!actor.success) { reply.code(400).send({ error: 'invalid_request', message: 'Invalid billing request' }); return; }
    const assertedHeader = request.headers['x-actor-staff-id'];
    if ((actor.data.actorStaffId && actor.data.actorStaffId !== staff.id) || (assertedHeader !== undefined && assertedHeader !== staff.id)) {
      reply.code(403).send({ error: 'attribution_mismatch', message: 'A billing action must belong to the verified staff member' }); return;
    }
    if (!(typeof permission==='string'?[permission]:permission).some(p=>staffPermissions(staff).includes(p))) { reply.code(403).send({ error: 'forbidden', message: 'Your account cannot perform this billing action' }); return; }
    return { ...identity, actorStaffId: staff.id };
  };
  app.post('/billing/catalogue/readiness', async (request,reply)=>{
    const who=await authorize(request,reply,'fee_item:manage'); if(!who)return;
    return catalogueReadiness(sql,who.facilityId);
  });
  app.post('/billing/integrated/readiness',async(request,reply)=>{const who=await authorize(request,reply,'fee_item:manage');if(who)return integratedReadiness(sql,who.facilityId);});
  app.post('/billing/associations/insurance-return',async(request,reply)=>{
    const who=await authorize(request,reply,'coverage:confirm');if(!who||!await authorize(request,reply,'charge:associate'))return;
    if(!await integratedEnabled(sql,who.facilityId))throw conflict('Insured returns require compatible financial readers');
    const body=parseBody(Actor.extend({requestId:z.string().uuid(),input:z.record(z.string(),z.unknown())}),request.body),now=Date.now();
    const parsed=ServiceChargeAllocation.safeParse({...body.input,id:'service_charge_allocation:'+body.requestId,type:'service_charge_allocation',facilityId:who.facilityId,deviceId:who.deviceId,createdBy:who.actorStaffId,createdOn:new Date(now).toISOString(),schemaVersion:7,acceptedOn:undefined,creditMinor:undefined,updatedBy:undefined,updatedOn:undefined});
    if(!parsed.success)return reply.code(400).send({error:'invalid_request',message:'Select the exact accepted supply allocation, returned quantity and reason'});
    return sql.begin(async tx=>{
      await tx`SELECT id FROM facilities WHERE id=${who.facilityId} FOR UPDATE`;
      const prior=await findRecord<ServiceChargeAllocation>(tx,'service_charge_allocation',parsed.data.id);
      if(prior){const content=(a:ServiceChargeAllocation)=>Object.fromEntries(Object.entries(a).filter(([k,v])=>v!==undefined&&!['acceptedOn','creditMinor','createdOn'].includes(k)));if(!isDeepStrictEqual(content(prior),content(parsed.data)))throw conflict('This return request was already used for another decision');const claims=await tx`SELECT claim_id FROM insurance_claim_lines WHERE facility_id=${who.facilityId} AND charge_id=${prior.chargeId} AND current`;return {record:prior,replayed:true,claimReviewRequired:claims.length>0};}
      const result=await confirmInsuranceReturn(tx,parsed.data,now);
      await recordAuditEvent(tx,{facilityId:who.facilityId,deviceId:who.deviceId,actorStaffId:who.actorStaffId,action:'create',entityType:'service_charge_allocation',entityId:result.record.id,metadata:{context:'insured_return_confirmed',allocationId:result.allocationId,claimReviewRequired:result.claimReviewRequired}});
      return result;
    });
  });
  // A link the patient opens without signing in: their bill or a receipt (src/routes/patientDocuments.ts).
  const DOCUMENT_STAFF = ['payment:receive', 'payment:waive', 'coverage:confirm', 'charge:create'] as const;
  const documentRequest = (body: unknown) => { const { actorStaffId: _actor, ...rest } = (body ?? {}) as Record<string, unknown>; return parseBody(DocumentLinkRequest, rest); };
  const documentSubject = async (facilityId: string, body: DocumentLinkRequest) => {
    if (body.kind === 'bill') { const bill = await loadBill(sql, facilityId, body.billKey); return bill && { subject: bill.key, patientId: bill.patient.patientId }; }
    const receipt = await loadReceipt(sql, facilityId, body.paymentId); return receipt && { subject: receipt.paymentId, patientId: receipt.patient.patientId };
  };
  app.post('/billing/documents/link', async (request, reply) => {
    const who = await authorize(request, reply, DOCUMENT_STAFF); if (!who) return;
    const body = documentRequest(request.body);
    const found = await documentSubject(who.facilityId, body);
    if (!found) throw conflict(body.kind === 'bill' ? 'This bill has no charges on the server yet. Let this device sync, then try again' : 'This receipt is not on the server yet, or it is a waiver, which has no receipt');
    const { token, expiresOn } = await createDocumentLink(sql, { facilityId: who.facilityId, kind: body.kind, subject: found.subject, patientId: found.patientId, createdBy: who.actorStaffId });
    await recordAuditEvent(sql, { facilityId: who.facilityId, deviceId: who.deviceId, actorStaffId: who.actorStaffId, action: 'export', entityType: body.kind === 'receipt' ? 'payment' : 'patient', entityId: body.kind === 'receipt' ? found.subject : found.patientId, metadata: { context: 'patient_document_link', kind: body.kind } });
    // The patient opens it in the web app (its first configured origin), which reads the document from this server.
    return { url: `${config.corsOrigins[0].replace(/\/+$/, '')}${patientPagePath(body.kind, token)}`, expiresOn } satisfies DocumentLinkResponse;
  });
  // Send a bill or receipt to the patient by SMS and/or email (src/messaging/patientMessages.ts).
  app.post('/billing/documents/send', async (request, reply) => {
    const who = await authorize(request, reply, DOCUMENT_STAFF); if (!who) return;
    if (!messaging) throw conflict('Sending to patients is not available on this server');
    const { actorStaffId: _actor, ...rest } = (request.body ?? {}) as Record<string, unknown>;
    const body = parseBody(SendToPatientRequest, rest);
    const subject = body.kind === 'bill' ? body.billKey : body.paymentId;
    const result = await sendDocumentToPatient(messaging, { facilityId: who.facilityId, deviceId: who.deviceId, createdBy: who.actorStaffId, automatic: false, kind: body.kind, subject, channels: body.channels });
    await recordAuditEvent(sql, { facilityId: who.facilityId, deviceId: who.deviceId, actorStaffId: who.actorStaffId, action: 'export', entityType: body.kind === 'receipt' ? 'payment' : 'patient',
      entityId: body.kind === 'receipt' ? subject : billKeyParts(subject)?.patientId, metadata: { context: 'patient_message', kind: body.kind, channels: body.channels.join(','), queued: result.messages.filter((m) => m.status === 'queued').length } });
    return result;
  });
  app.post('/billing/documents/stop', async (request, reply) => {
    const who = await authorize(request, reply, DOCUMENT_STAFF); if (!who) return;
    const body = documentRequest(request.body);
    const subject = body.kind === 'bill' ? body.billKey : body.paymentId;
    const stopped = await stopDocumentLinks(sql, who.facilityId, body.kind, subject, who.actorStaffId);
    if (stopped) await recordAuditEvent(sql, { facilityId: who.facilityId, deviceId: who.deviceId, actorStaffId: who.actorStaffId, action: 'revoke', entityType: body.kind === 'receipt' ? 'payment' : 'patient', entityId: body.kind === 'receipt' ? subject : billKeyParts(subject)?.patientId, metadata: { context: 'patient_document_link', kind: body.kind, stopped: String(stopped) } });
    return { stopped } satisfies DocumentLinkStopResponse;
  });

  app.post('/billing/statements/patient',async(request,reply)=>{
    const who=await authorize(request,reply,['payment:receive','payment:waive','coverage:confirm','charge:create']);if(!who)return;
    if(!await integratedEnabled(sql,who.facilityId))throw conflict('Comprehensive statements are waiting for compatible financial readers');
    const body=parseBody(Actor.extend({patientId:z.string().min(1),currency:z.string().regex(/^[A-Z]{3}$/),cutoff:z.string().datetime({offset:true}).optional()}),request.body);
    const cutoff=body.cutoff??new Date().toISOString();if(Date.parse(cutoff)>Date.now()+1000)throw conflict('A statement cutoff cannot be in the future');
    const [patient]=await sql`SELECT id FROM patients WHERE facility_id=${who.facilityId} AND id=${body.patientId}`;if(!patient)throw conflict('Select a patient in this hospital');
    reply.header('cache-control','no-store');
    return sql.begin(async tx=>{await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;return buildPatientStatement(tx,who.facilityId,body.patientId,body.currency,cutoff);});
  });
  app.post('/billing/reports/financial',async(request,reply)=>{
    const who=await authorize(request,reply,['payment:receive','payment:waive','insurance_remittance:record','fee_item:manage']);if(!who)return;
    if(!await integratedEnabled(sql,who.facilityId))throw conflict('Financial snapshots are waiting for compatible readers');
    const body=parseBody(Actor.extend({currency:z.string().regex(/^[A-Z]{3}$/),cutoff:z.string().datetime({offset:true}).optional(),after:z.string().optional()}),request.body),cutoff=body.cutoff??new Date().toISOString();
    if(Date.parse(cutoff)>Date.now()+1000)throw conflict('A report cutoff cannot be in the future');
    reply.header('cache-control','no-store');
    return sql.begin(async tx=>{await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      const patients=await tx`SELECT DISTINCT patient_id FROM charges WHERE facility_id=${who.facilityId} AND currency=${body.currency} AND created_on<=${cutoff} AND patient_id>${body.after??''} ORDER BY patient_id LIMIT 26`;
      const statements=[];for(const patient of patients.slice(0,25))statements.push(await buildPatientStatement(tx,who.facilityId,String(patient.patient_id),body.currency,cutoff));
      // Payer money not yet assigned to a claim cannot be attributed to a patient.
      const [payerMoney]=await tx`SELECT COALESCE(SUM(r.amount_minor),0) AS received,
       COALESCE(SUM((SELECT COALESCE(SUM(a.amount_minor),0) FROM insurance_remittance_allocations a WHERE a.facility_id=r.facility_id AND a.remittance_id=r.id AND a.recorded_on<=${cutoff})),0) AS allocated
       FROM insurance_remittances r WHERE r.facility_id=${who.facilityId} AND r.currency=${body.currency} AND r.recorded_on<=${cutoff}
       AND NOT EXISTS(SELECT 1 FROM insurance_remittance_reversals v WHERE v.facility_id=r.facility_id AND v.remittance_id=r.id AND v.reversed_on<=${cutoff})`;
      return {cutoff,statements,payerReceiptsMinor:Number(payerMoney.received),unallocatedPayerReceiptsMinor:Number(payerMoney.received)-Number(payerMoney.allocated),...(patients.length>25?{nextAfter:String(patients[24].patient_id)}:{})};
    });
  });
  app.post('/billing/transfers/capacity',async(request,reply)=>{
    const who=await authorize(request,reply,['payment:receive','insurance_remittance:record']);if(!who)return;
    const body=parseBody(Actor.extend({ids:z.array(z.string().min(1)).max(200)}),request.body);
    return sql.begin(async tx=>{await tx`SELECT id FROM facilities WHERE id=${who.facilityId} FOR UPDATE`;const sources=[];for(const id of [...new Set(body.ids)].sort()){const c=await sourceCapacity(tx,who.facilityId,id);sources.push({id,patientMinor:c.patientMinor,payerMinor:c.payerMinor,availableMinor:Math.max(0,c.availableMinor),overRecognizedMinor:Math.max(0,-c.availableMinor)});}return {sources};});
  });
  /** The hospital's connected provider, its decrypted credentials (server memory only) and mode. */
  const connection = (facilityId: string) => providerConnection(sql, config, facilityId);
  app.post('/billing/connection/status', async (request, reply) => {
    const who = await authorize(request, reply, 'fee_item:manage'); if (!who) return;
    const [row] = await sql<{ mode: string; provider: string; receiving_account_id: string | null }[]>`SELECT mode,provider,receiving_account_id FROM billing_connections WHERE facility_id = ${who.facilityId}`;
    const accounts = await sql`SELECT id, account_number AS "accountNumber", account_name AS "accountName", bank_name AS "bankName", department_id AS "departmentId", mode, provider
      FROM billing_receiving_accounts WHERE facility_id = ${who.facilityId} ORDER BY created_on`;
    const provider = row?.provider ?? 'paystack';
    return { configured: Boolean(row), provider: row?.provider, mode: row?.mode, receivingAccountId:row?.receiving_account_id ?? undefined, encryptionReady: Boolean(config.billingEncryptionKey), accounts,
      webhookPath: `/billing/${provider}/${encodeURIComponent(who.facilityId)}/webhook` };
  });
  /** Providers this server supports and the fields each needs. Descriptors never contain secrets. */
  app.post('/billing/providers', async (request, reply) => {
    const who = await authorize(request, reply, 'fee_item:manage'); if (!who) return;
    return { providers: PROVIDERS };
  });
  app.post('/billing/connection', async (request, reply) => {
    const who = await authorize(request, reply, 'fee_item:manage'); if (!who) return;
    // Current form { provider, credentials }; the earlier { secretKey } form is still accepted from older clients as Paystack.
    const body = parseBody(Actor.extend({ provider: z.string().optional(), credentials: z.record(z.string(), z.string()).optional(), secretKey: z.string().optional() }), request.body);
    const providerId = body.provider ?? 'paystack', provider = paymentProvider(providerId);
    if (!provider) return reply.code(400).send({ error: 'unknown_provider', message: 'Choose a supported payment provider' });
    const credentials = provider.credentials(body.credentials ?? { secretKey: body.secretKey });
    if (!credentials) return reply.code(400).send({ error: 'invalid_credentials', message: `Check the ${provider.descriptor.name} keys: copy each one exactly as the provider shows it` });
    if (!config.billingEncryptionKey) return reply.code(503).send({ error: 'not_configured', message: 'Payment setup isn\'t finished on the server. Ask your system administrator.' });
    // Prove access before replacing a working connection. No key is returned or logged.
    await provider.checkAccess(credentials, fetcher);
    const mode = provider.mode(credentials);
    const encrypted = sealPaystackSecret(serialiseCredentials(provider, credentials), config.billingEncryptionKey, who.facilityId);
    await sql`INSERT INTO billing_connections (facility_id, provider, encrypted_secret, mode, updated_by)
      VALUES (${who.facilityId}, ${providerId}, ${encrypted}, ${mode}, ${who.actorStaffId})
      ON CONFLICT (facility_id) DO UPDATE SET encrypted_secret = EXCLUDED.encrypted_secret, provider = EXCLUDED.provider,
      receiving_account_id=NULL,
      mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, updated_on = now()`;
    await recordAuditEvent(sql, { facilityId: who.facilityId, deviceId: who.deviceId, actorStaffId: who.actorStaffId, action: 'update', metadata: { context: 'billing_provider_connected', provider: providerId, mode } });
    return { configured: true, provider: providerId, mode };
  });
  app.post('/billing/accounts/list', async (request, reply) => {
    const who = await authorize(request, reply, 'payment:receive'); if (!who) return;
    return sql`SELECT a.id, a.account_number AS "accountNumber", a.account_name AS "accountName", a.bank_name AS "bankName", a.department_id AS "departmentId", a.mode, (a.id=c.receiving_account_id) AS "general"
      FROM billing_receiving_accounts a JOIN billing_connections c ON c.facility_id = a.facility_id AND c.mode = a.mode AND c.provider = a.provider
      WHERE a.facility_id = ${who.facilityId} ORDER BY (a.id=c.receiving_account_id) DESC NULLS LAST,a.created_on`;
  });
  app.post('/billing/accounts/general',async(request,reply)=>{
    const who=await authorize(request,reply,'fee_item:manage');if(!who)return;
    const body=parseBody(Actor.extend({accountId:z.string().min(1)}),request.body);
    const key=await connection(who.facilityId);
    const [candidate]=await sql`SELECT * FROM billing_receiving_accounts WHERE facility_id=${who.facilityId} AND id=${body.accountId} AND mode=${key.mode} AND provider=${key.providerId}`;
    if(!candidate)throw conflict('Choose an account held with the connected provider, in the same test or live mode');
    const id=String(candidate.provider_account_id),verified=await key.provider.getAccount(key.credentials,id,fetcher);
    if(!verified.active||verified.currency!=='NGN'||verified.providerAccountId!==id||verified.accountNumber!==candidate.account_number)throw conflict('This receiving account is not verified under the current hospital connection');
    await sql.begin(async tx=>{
      await tx`SELECT id FROM facilities WHERE id=${who.facilityId} FOR UPDATE`;
      const [current]=await tx`SELECT mode,provider,encrypted_secret FROM billing_connections WHERE facility_id=${who.facilityId}`;
      if(!current||current.mode!==key.mode||current.provider!==key.providerId||current.encrypted_secret!==key.encryptedSecret)throw conflict('The hospital connection changed. Refresh and select the receiving account again');
      const [account]=await tx`SELECT a.id FROM billing_receiving_accounts a JOIN billing_connections c ON c.facility_id=a.facility_id AND c.mode=a.mode AND c.provider=a.provider WHERE a.facility_id=${who.facilityId} AND a.id=${body.accountId}`;
      if(!account)throw conflict('Select a linked receiving account in the current provider mode');
      await tx`UPDATE billing_connections SET receiving_account_id=${body.accountId},updated_by=${who.actorStaffId},updated_on=now() WHERE facility_id=${who.facilityId}`;
      await recordAuditEvent(tx,{facilityId:who.facilityId,deviceId:who.deviceId,actorStaffId:who.actorStaffId,action:'update',metadata:{context:'billing_general_account_selected',accountId:body.accountId}});
    });
    return {receivingAccountId:body.accountId};
  });
  app.post('/billing/accounts/discover', async (request, reply) => {
    const who = await authorize(request, reply, 'fee_item:manage'); if (!who) return;
    const key = await connection(who.facilityId);
    if (!key.provider.listAccounts) throw conflict('Finding existing accounts isn\'t available for this provider. Create the hospital\'s account instead.');
    const accounts = await key.provider.listAccounts(key.credentials, fetcher);
    return accounts.filter((a) => a.active && a.currency === 'NGN').map(({ providerAccountId, accountNumber, accountName, bankName }) => ({ providerAccountId, accountNumber, accountName, bankName }));
  });
  app.post('/billing/accounts/link', async (request, reply) => {
    const who = await authorize(request, reply, 'fee_item:manage'); if (!who) return;
    const body = parseBody(LinkAccount, request.body); const key = await connection(who.facilityId);
    const account = await key.provider.getAccount(key.credentials, body.providerAccountId, fetcher);
    if (!account.active || account.currency !== 'NGN' || account.providerAccountId !== body.providerAccountId) return reply.code(400).send({ error: 'invalid_account', message: 'Choose an active NGN receiving account belonging to the connected provider account' });
    if (body.departmentId) {
      const [department] = await sql`SELECT id FROM billing_departments WHERE id = ${body.departmentId} AND facility_id = ${who.facilityId} AND active`;
      if (!department) return reply.code(409).send({ error: 'department_not_synced', message: 'Save the department and wait for it to sync before linking its account' });
    }
    // An existing account cannot silently change ownership after receipts were assigned.
    const [existing] = await sql`SELECT id FROM billing_receiving_accounts WHERE facility_id = ${who.facilityId} AND provider = ${key.providerId} AND mode = ${key.mode} AND provider_account_id = ${body.providerAccountId}`;
    if (existing) return reply.code(409).send({ error: 'already_linked', message: 'This receiving account is already linked. Existing ownership is retained for reconciliation history.' });
    const id = randomUUID();
    await sql`INSERT INTO billing_receiving_accounts (id, facility_id, provider, provider_account_id, account_number, account_name, bank_name, department_id, mode, created_by)
      VALUES (${id}, ${who.facilityId}, ${key.providerId}, ${body.providerAccountId}, ${account.accountNumber}, ${account.accountName}, ${account.bankName}, ${body.departmentId ?? null}, ${key.mode}, ${who.actorStaffId})`;
    if(!body.departmentId)await sql`UPDATE billing_connections SET receiving_account_id=${id},updated_by=${who.actorStaffId},updated_on=now() WHERE facility_id=${who.facilityId} AND mode=${key.mode} AND receiving_account_id IS NULL`;
    await recordAuditEvent(sql, { facilityId: who.facilityId, deviceId: who.deviceId, actorStaffId: who.actorStaffId, action: 'create', metadata: { context: 'billing_account_linked', accountId: id, provider: key.providerId, mode: key.mode } });
    return { id, accountNumber: account.accountNumber, accountName: account.accountName, bankName: account.bankName, departmentId: body.departmentId, mode: key.mode };
  });

  /**
   * Creates the hospital's central receiving account with the connected provider (Paystack: a dedicated
   * virtual account; Monnify: a reserved account at one bank) and makes it the account patients pay into.
   * Identity details such as a BVN go to the provider only; they are not stored or logged.
   */
  app.post('/billing/accounts/create', async (request, reply) => {
    const who = await authorize(request, reply, 'fee_item:manage'); if (!who) return;
    const body = parseBody(Actor.extend({ details: z.record(z.string(), z.string()) }), request.body);
    const key = await connection(who.facilityId);
    const details = key.provider.accountDetails(body.details);
    if (!details) return reply.code(400).send({ error: 'invalid_account_details', message: `Check the details ${key.provider.descriptor.name} needs to open the account` });
    const [hospital] = await sql<{ name: string }[]>`SELECT name FROM facilities WHERE id = ${who.facilityId}`;
    const [existing] = await sql`SELECT id FROM billing_receiving_accounts WHERE facility_id = ${who.facilityId} AND provider = ${key.providerId} AND mode = ${key.mode} AND department_id IS NULL`;
    if (existing) throw conflict('The hospital already has a receiving account with this provider. Choose it under Advanced instead of creating another.');
    const account = await key.provider.createAccount(key.credentials, { id: who.facilityId, name: hospital.name }, details, fetcher);
    if (!account.active || account.currency !== 'NGN') throw conflict('The new account isn\'t active for NGN yet. Try again shortly.');
    const id = randomUUID();
    await sql`INSERT INTO billing_receiving_accounts (id, facility_id, provider, provider_account_id, account_number, account_name, bank_name, department_id, mode, created_by)
      VALUES (${id}, ${who.facilityId}, ${key.providerId}, ${account.providerAccountId}, ${account.accountNumber}, ${account.accountName}, ${account.bankName}, NULL, ${key.mode}, ${who.actorStaffId})`;
    await sql`UPDATE billing_connections SET receiving_account_id=${id},updated_by=${who.actorStaffId},updated_on=now() WHERE facility_id=${who.facilityId} AND mode=${key.mode} AND receiving_account_id IS NULL`;
    await recordAuditEvent(sql, { facilityId: who.facilityId, deviceId: who.deviceId, actorStaffId: who.actorStaffId, action: 'create', metadata: { context: 'billing_central_account_created', accountId: id, provider: key.providerId, mode: key.mode } });
    return { id, accountNumber: account.accountNumber, accountName: account.accountName, bankName: account.bankName, mode: key.mode };
  });

  /** Kept for clients released before central dedicated accounts; the setup screen no longer creates Virtual Terminals. */
  app.post('/billing/accounts/create-terminal', async (request, reply) => {
    const who = await authorize(request, reply, 'fee_item:manage'); if (!who) return;
    const body = parseBody(Actor.extend({ notificationPhone: z.string().regex(/^\+[1-9]\d{7,14}$/) }), request.body);
    const key = await connection(who.facilityId);
    if (key.providerId !== 'paystack') throw conflict('Use Create account for this provider');
    const [hospital] = await sql<{ name: string }[]>`SELECT name FROM facilities WHERE id = ${who.facilityId}`;
    const [existing] = await sql`SELECT id FROM billing_receiving_accounts WHERE facility_id = ${who.facilityId} AND provider = 'paystack' AND mode = ${key.mode} AND department_id IS NULL`;
    if (existing) throw conflict('A general receiving account is already linked. Select its existing bank details.');
    const terminal = PaystackTerminal.parse(await callPaystack(key.credentials.secretKey, '/virtual_terminal', fetcher, {
      name: hospital.name, currency: 'NGN', destinations: [{ target: body.notificationPhone, name: hospital.name }],
    }));
    const account = accountFromTerminal(terminal); const id = randomUUID();
    await sql`INSERT INTO billing_receiving_accounts (id, facility_id, provider, provider_account_id, account_number, account_name, bank_name, department_id, mode, created_by)
      VALUES (${id}, ${who.facilityId}, 'paystack', ${terminal.code}, ${account.account_number}, ${account.account_name}, ${account.bank.name}, NULL, ${key.mode}, ${who.actorStaffId})`;
    await sql`UPDATE billing_connections SET receiving_account_id=${id},updated_by=${who.actorStaffId},updated_on=now() WHERE facility_id=${who.facilityId} AND mode=${key.mode} AND receiving_account_id IS NULL`;
    await recordAuditEvent(sql, { facilityId: who.facilityId, deviceId: who.deviceId, actorStaffId: who.actorStaffId, action: 'create', metadata: { context: 'billing_terminal_created', accountId: id, mode: key.mode } });
    return { id, accountNumber: account.account_number, accountName: account.account_name, bankName: account.bank.name, mode: key.mode };
  });

  /** Records a transfer only after asking the connected provider directly; the webhook or a typed reference is never proof. */
  const ingest = async (facilityId: string, reference: string, key: Awaited<ReturnType<typeof connection>>) => {
    const verified = await key.provider.verifyTransfer(key.credentials, reference, fetcher);
    if (!verified) throw conflict('The provider has no successful bank transfer with that reference');
    if (verified.mode !== key.mode) throw conflict('That payment belongs to the provider\'s other mode (test or live)');
    const [account] = await sql<AccountRow[]>`SELECT id, department_id, account_number FROM billing_receiving_accounts
      WHERE facility_id = ${facilityId} AND provider = ${key.providerId} AND mode = ${key.mode}
        AND (account_number = ${verified.receivingAccountNumber ?? ''} OR provider_account_id = ${verified.receivingAccountRef ?? ''})`;
    const [device] = await sql<{ id: string }[]>`SELECT id FROM devices WHERE facility_id = ${facilityId} ORDER BY id LIMIT 1`;
    if (!device) throw conflict('The hospital has no enrolled device');
    const now = new Date().toISOString();
    const record: IncomingTransfer = {
      id: `incoming_transfer:${randomUUID()}`, type: 'incoming_transfer', facilityId, schemaVersion: SCHEMA_VERSION,
      createdBy: 'system', createdOn: now, deviceId: device.id, provider: key.providerId, providerReference: reference,
      mode: key.mode,
      amountMinor: verified.amountMinor, currency: verified.currency, receivedOn: verified.paidAt,
      receivingAccount: verified.receivingAccountNumber ?? account?.account_number, departmentId: account?.department_id ?? undefined,
      payerName: verified.payerName,
    };
    // One immutable receipt per provider reference, including concurrent retries.
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM facilities WHERE id = ${facilityId} FOR UPDATE`;
      const [exists] = await tx`SELECT id FROM incoming_transfers WHERE facility_id = ${facilityId} AND provider = ${key.providerId} AND mode = ${key.mode} AND provider_reference = ${reference}`;
      if (!exists) await insertRecord(tx, 'incoming_transfer', record);
    });
  };
  /** One webhook address per provider: /billing/<provider>/<facility>/webhook. Only the hospital's connected provider is heard. */
  app.post<{ Params: { provider: string; facilityId: string } }>('/billing/:provider/:facilityId/webhook', async (request, reply) => {
    const provider = paymentProvider(request.params.provider);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
    const key = await connection(request.params.facilityId);
    if (key.providerId !== request.params.provider) return reply.code(409).send({ error: 'inactive_provider' });
    const result = key.provider.webhookReference(billingRawBodies.get(request) ?? '', request.headers[key.provider.webhookHeader], key.credentials);
    if (!result.ok) return reply.code(401).send({ error: 'invalid_signature' });
    if (result.checkoutReference) {
      await confirmCheckout(sql, config, result.checkoutReference, fetcher, {
        facilityId: request.params.facilityId,
        provider: request.params.provider,
      });
    }
    if (result.reference) await ingest(request.params.facilityId, result.reference, key);
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
      await tx`SELECT id FROM facilities WHERE id=${who.facilityId} FOR UPDATE`;
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
      const amountMinor = body.allocations.reduce((n, a) => n + a.amountMinor, 0);
      await reserveSource(tx,who.facilityId,request.params.id,amountMinor,source.currency);
      const ids = body.allocations.map((a) => a.chargeId);
      const charges = await tx<{ id: string; patient_id: string; currency: string; department_id: string | null }[]>`SELECT id, patient_id, currency, department_id FROM charges WHERE facility_id = ${who.facilityId} AND id = ANY(${ids}) ORDER BY id FOR UPDATE`;
      for (const a of body.allocations) {
        const charge = charges.find((c) => c.id === a.chargeId);
        if (!charge || charge.patient_id !== body.patientId || charge.currency !== source.currency) throw conflict('Select this patient\'s synced bills in the receipt currency');
        if (a.amountMinor > await availableOnCharge(tx, who.facilityId, a.chargeId)) throw conflict('An allocation exceeds the current bill balance. Refresh the patient account.');
      }
      await tx`SELECT id FROM facilities WHERE id = ${who.facilityId} FOR UPDATE`;
      const receiptNumber = await nextReceiptNumber(tx, who.facilityId);
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
