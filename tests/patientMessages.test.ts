import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { billKey, type FacilityRegistrationResult } from '#shared';
import { buildApp } from '../src/app.ts';
import { insertRecord } from '../src/db/records.ts';
import { EmailNotSent, type EmailMessage, type Mailer } from '../src/lib/email.ts';
import { issuePinSetupCode } from '../src/staff/pinSetupCodes.ts';
import { retryPatientMessages, sendQueuedReceipts, smsNumber } from '../src/messaging/patientMessages.ts';
import { billMessage } from '../src/messaging/documentMessages.ts';
import { createSendarSender, smsSenderFrom, SmsNotSent } from '../src/messaging/sendar.ts';
import { config, envelopeFor, signer, registerScratchFacility, scratchDatabase, type ScratchDatabase } from './postgres.ts';

describe('patient message helpers', () => {
  it('turns what staff type into an SMS number', () => {
    assert.equal(smsNumber('0803 123 4567'), '2348031234567');
    assert.equal(smsNumber('+234 803-123-4567'), '2348031234567');
    assert.equal(smsNumber('2348031234567'), '2348031234567');
    assert.equal(smsNumber('12345'), undefined);
  });
  it('keeps a bill SMS to the hospital, the number, the amount and the link', () => {
    const sms = billMessage({ reference: 'B-63AF2E1C9D04', currency: 'NGN', totals: { dueMinor: 20_500_00 }, hospital: { name: 'Sunrise Hospital' }, patient: { name: 'A' } } as never, 'https://app.example.org/p/b/' + 'x'.repeat(43)).sms;
    assert.equal(sms, `Sunrise Hospital: bill B-63AF2E1C9D04, NGN 20,500.00 due. View and pay: https://app.example.org/p/b/${'x'.repeat(43)}`);
  });
});

/** Sending bills and receipts by email (docs/PATIENT-BILL-DELIVERY-PLAN-2026-11-21.md, step 3). Synthetic data only. */
describe('sending bills and receipts to patients', () => {
  let db: ScratchDatabase; let app: FastifyInstance; let f: FacilityRegistrationResult; let session: string | undefined;
  const sent: EmailMessage[] = []; let failing = false;
  const mailer: Mailer = { configured: true, send: async (message) => { if (failing) throw new EmailNotSent('Resend answered 500: synthetic'); sent.push(message); return { providerMessageId: 'email-1' }; } };
  const texts: { to: string; text: string }[] = [];
  const sms = { configured: false, send: async (to: string, text: string) => { texts.push({ to, text }); return { providerMessageId: 'sms-1' }; } };
  const patient = (n: string) => `${f.facility.id}-${n}-K2`;
  const billId = randomUUID(); let key = '';
  const post = async (path: string, body: Record<string, unknown>) => {
    if (!session) {
      const proof = await issuePinSetupCode(db.sql, { facilityId: f.facility.id, staffId: f.admin.id, issuedBy: f.admin.id, issuedFrom: f.device.deviceId });
      assert.ok(proof.ok);
      const response = await app.inject({ method: 'POST', url: '/staff/session/enrol', headers: { authorization: `Bearer ${f.device.credential}` }, payload: { staffId: f.admin.id, pin: '246810', setupCode: proof.code } });
      session = response.json().token;
    }
    return app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${f.device.credential}`, 'x-staff-session': session!, 'x-actor-staff-id': f.admin.id }, payload: body });
  };
  const contact = (id: string, extra: Record<string, unknown>) => insertRecord(db.sql, 'patient_contact', { ...envelopeFor(f), schemaVersion: 7, createdBy: f.admin.id, id, type: 'patient_contact', patientId: patient('000001'), smsStopped: false, emailStopped: false, source: 'staff', ...extra });
  const messages = () => db.sql`SELECT channel, "to", status, attempts, reason, automatic FROM patient_messages ORDER BY created_on`;

  before(async () => {
    db = await scratchDatabase(); f = await registerScratchFacility(db.sql);
    app = buildApp({ config, sql: db.sql, signer, mailer, smsSender: sms }, { logger: false, rateLimit: false });
    await db.sql`UPDATE facilities SET email = 'desk@example.org' WHERE id = ${f.facility.id}`;
    const admin = { ...envelopeFor(f), schemaVersion: 5 };
    await insertRecord(db.sql, 'fee_item', { ...admin, id: 'fee:any', type: 'fee_item', name: 'Synthetic test', category: 'laboratory', amountMinor: 100_00, currency: 'NGN', chargeWhen: 'when_ordered' });
    await insertRecord(db.sql, 'patient', { ...admin, id: patient('000001'), patientId: patient('000001'), type: 'patient', fullName: 'Synthetic Patient', address: 'Synthetic address', sex: 'female', ageYears: 30, phone: '08031234567' });
    const charge = { ...admin, id: 'charge:one', type: 'charge', patientId: patient('000001'), feeItemId: 'fee:any', category: 'laboratory', description: 'Full blood count', listPriceMinor: 5_000_00, amountMinor: 5_000_00, currency: 'NGN', billId };
    await insertRecord(db.sql, 'charge', charge);
    key = billKey(charge as never);
    await contact('patient_contact:one', { email: 'ada@example.org' });
  });
  after(async () => { if (app) await app.close(); if (db) await db.drop(); });

  it('emails the bill with its PDF, from the hospital, and says why SMS is not sent yet', async () => {
    const response = await post('/billing/documents/send', { kind: 'bill', billKey: key, channels: ['email', 'sms'] });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().messages.map((m: { channel: string; status: string; reason?: string }) => [m.channel, m.status, m.reason]),
      [['email', 'queued', undefined], ['sms', 'refused', "SMS sending isn't set up yet"]]);
    assert.equal(sent.length, 1);
    const [email] = sent;
    assert.equal(email.to, 'ada@example.org');
    assert.equal(email.replyTo, 'desk@example.org');
    assert.match(email.fromName!, /via Geneus$/);
    assert.match(email.subject, /^Your bill B-/);
    assert.match(email.text, new RegExp(`${config.corsOrigins[0]}/p/b/[A-Za-z0-9_-]{43}`), 'the link opens the web app');
    assert.match(email.text, /NGN 5,000\.00/);
    assert.equal(email.attachments?.[0].contentType, 'application/pdf');
    assert.equal(Buffer.from(email.attachments![0].content).subarray(0, 4).toString(), '%PDF');
    const [row] = await messages();
    assert.deepEqual({ ...row }, { channel: 'email', to: 'a***@example.org', status: 'sent', attempts: 1, reason: null, automatic: false });
  });

  it('retries a failed email with back-off, then marks it failed with a safe reason', async () => {
    failing = true;
    await db.sql`DELETE FROM patient_messages`;
    await post('/billing/documents/send', { kind: 'bill', billKey: key, channels: ['email'] });
    let [row] = await messages();
    assert.deepEqual([row.status, row.attempts], ['queued', 1]);
    assert.match(row.reason, /Trying again shortly/);
    assert.equal(await retryPatientMessages({ sql: db.sql, mailer, appUrl: config.corsOrigins[0], log: { warn: () => undefined } }), 0, 'not before the back-off');
    for (let i = 0; i < 2; i++) {
      await db.sql`UPDATE patient_messages SET updated_on = now() - interval '1 hour'`;
      await retryPatientMessages({ sql: db.sql, mailer, appUrl: config.corsOrigins[0], log: { warn: () => undefined } });
    }
    [row] = await messages();
    assert.deepEqual([row.status, row.attempts, row.reason], ['failed', 3, "The email service didn't accept the message"]);
    failing = false;
  });

  it('never sends on a channel the patient stopped', async () => {
    await contact('patient_contact:two', { email: 'ada@example.org', emailStopped: true, source: 'patient', createdBy: 'patient', replaces: 'patient_contact:one' });
    const response = await post('/billing/documents/send', { kind: 'bill', billKey: key, channels: ['email'] });
    assert.deepEqual(response.json().messages, [{ channel: 'email', status: 'refused', reason: 'The patient stopped email' }]);
  });

  it('texts the bill once Geneus has SMS: hospital, number, amount and the web app link', async () => {
    sms.configured = true;
    const response = await post('/billing/documents/send', { kind: 'bill', billKey: key, channels: ['sms'] });
    assert.equal(response.json().messages[0].status, 'queued');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].to, '2348031234567');
    assert.match(texts[0].text, new RegExp(`: bill B-[^,]+, NGN 5,000\\.00 due\\. View and pay: ${config.corsOrigins[0]}/p/b/[A-Za-z0-9_-]{43}$`));
    const [row] = await db.sql`SELECT "to", status FROM patient_messages WHERE channel = 'sms'`;
    assert.deepEqual({ ...row }, { to: '0803 *** 4567', status: 'sent' });
  });

  it('sends a receipt automatically once a payment is accepted, never for a waiver', async () => {
    const pay = (id: string, method: string, receipt: string) => insertRecord(db.sql, 'payment', { ...envelopeFor(f), schemaVersion: 5, createdBy: f.admin.id, id, type: 'payment', patientId: patient('000001'),
      receiptNumber: `${f.facility.id}-R-${receipt}-K2`, method, amountMinor: 1_000_00, currency: 'NGN', allocations: [{ chargeId: 'charge:one', amountMinor: 1_000_00 }], ...(method === 'waiver' ? { reason: 'Synthetic waiver' } : {}) });
    await pay('payment:cash', 'cash', '300001');
    await pay('payment:waived', 'waiver', '300002');
    assert.deepEqual((await db.sql`SELECT payment_id FROM patient_receipt_queue`).map((r) => r.payment_id), ['payment:cash']);
    texts.length = 0;
    const deps = { sql: db.sql, mailer, sms, appUrl: config.corsOrigins[0], log: { warn: () => undefined } };
    assert.equal(await sendQueuedReceipts(deps), 1);
    assert.equal(await sendQueuedReceipts(deps), 0, 'each receipt is sent once');
    // The patient stopped email earlier, so only the SMS goes.
    assert.equal(texts.length, 1);
    assert.match(texts[0].text, /: receipt .*-R-300001-K2, NGN 1,000\.00 paid\. Download: /);
    const [row] = await db.sql`SELECT kind, subject, automatic, created_by, status FROM patient_messages WHERE kind = 'receipt'`;
    assert.deepEqual({ ...row }, { kind: 'receipt', subject: 'payment:cash', automatic: true, created_by: f.admin.id, status: 'sent' });
  });

  it('refuses a receipt that is not on the server', async () => {
    assert.equal((await post('/billing/documents/send', { kind: 'receipt', paymentId: 'payment:none', channels: ['email'] })).statusCode, 409);
  });
});

describe('Sendar', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (body: unknown, status = 200): typeof fetch => async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); };
  it('sends one transactional SMS as Sendar specifies', async () => {
    const sender = createSendarSender({ apiKey: 'fictional-key', senderId: 'Geneus', baseUrl: 'https://sms.example.org/' }, reply({ status: true, data: [{ number: '2348031234567', message_id: 991, status: 'queued' }] }));
    assert.deepEqual(await sender.send('2348031234567', 'Hello'), { providerMessageId: '991' });
    assert.equal(calls[0].url, 'https://sms.example.org/api/sms/send');
    assert.equal((calls[0].init.headers as Record<string, string>)['API-KEY'], 'fictional-key');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { contact: [{ number: '2348031234567', body: 'Hello', sms_type: 'plain' }], sender_id: 'Geneus', wallet_type: 'transactional' });
  });
  it('reports a refusal with Sendar\'s status for the log', async () => {
    await assert.rejects(createSendarSender({ apiKey: 'bad', senderId: 'Geneus', baseUrl: 'https://sms.example.org' }, reply({ message: 'Invalid API key' }, 401)).send('2348031234567', 'Hello'),
      (e: SmsNotSent) => e.providerStatus === 401 && e.providerReason === 'Invalid API key');
    await assert.rejects(createSendarSender({ apiKey: 'k', senderId: 'Geneus', baseUrl: 'https://sms.example.org' }, reply({ status: true, data: [{ status: 'failed' }] })).send('2348031234567', 'Hello'), SmsNotSent);
  });
  it('is off until Geneus configures it', () => {
    assert.equal(smsSenderFrom({ sendarBaseUrl: 'https://sms-submit.sendar.io' }), undefined);
    assert.ok(smsSenderFrom({ sendarApiKey: 'k', sendarSenderId: 'Geneus', sendarBaseUrl: 'https://sms-submit.sendar.io' })?.configured);
  });
});
