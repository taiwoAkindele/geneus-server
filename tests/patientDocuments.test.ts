import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { billKey, type FacilityRegistrationResult } from '#shared';
import { buildApp } from '../src/app.ts';
import { insertRecord } from '../src/db/records.ts';
import { issuePinSetupCode } from '../src/staff/pinSetupCodes.ts';
import { pdfSafe } from '../src/patientDocuments/documentPdf.ts';
import { maskEmail, maskPhone } from '../src/messaging/mask.ts';
import {
  config,
  envelopeFor,
  signer,
  registerScratchFacility,
  scratchDatabase,
  type ScratchDatabase,
} from './postgres.ts';

describe('patient document helpers', () => {
  it('keeps any name printable in the standard PDF font', () => {
    assert.equal(pdfSafe('Ọlá Àdìgún'), 'Ola Adigun');
    assert.equal(pdfSafe('Ama  Mensah'), 'Ama Mensah');
    assert.equal(pdfSafe('NGN ₦ 李'), 'NGN ? ?');
  });

  it('masks contact details', () => {
    assert.equal(maskPhone('0803 123 4567'), '0803 *** 4567');
    assert.equal(maskEmail('ada@example.org'), 'a***@example.org');
  });
});

/** Links a patient opens without signing in (docs/PATIENT-BILL-DELIVERY-PLAN-2026-11-21.md, step 2). Synthetic data only. */
describe('patient document links', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let f: FacilityRegistrationResult;
  let session: string | undefined;
  const patient = (n: string) => `${f.facility.id}-${n}-K2`;
  const billId = randomUUID();
  let receipt = 200_000;

  const post = async (path: string, body: Record<string, unknown>) => {
    if (!session) {
      const proof = await issuePinSetupCode(db.sql, {
        facilityId: f.facility.id,
        staffId: f.admin.id,
        issuedBy: f.admin.id,
        issuedFrom: f.device.deviceId,
      });

      assert.ok(proof.ok);

      const response = await app.inject({
        method: 'POST',
        url: '/staff/session/enrol',
        headers: { authorization: `Bearer ${f.device.credential}` },
        payload: { staffId: f.admin.id, pin: '246810', setupCode: proof.code },
      });

      assert.equal(response.statusCode, 200, response.body);
      session = response.json().token;
    }

    return app.inject({
      method: 'POST',
      url: path,
      headers: {
        authorization: `Bearer ${f.device.credential}`,
        'x-staff-session': session!,
        'x-actor-staff-id': f.admin.id,
      },
      payload: body,
    });
  };

  const charge = async (
    id: string,
    description: string,
    listPriceMinor: number,
    extra: Record<string, unknown> = {},
  ) => {
    const record = {
      ...envelopeFor(f),
      schemaVersion: 5,
      id,
      type: 'charge',
      patientId: patient('000001'),
      feeItemId: 'fee:any',
      category: 'laboratory',
      description,
      listPriceMinor,
      amountMinor: listPriceMinor,
      currency: 'NGN',
      billId,
      ...extra,
    };

    await insertRecord(db.sql, 'charge', record);

    return record;
  };

  const pay = async (
    id: string,
    allocations: { chargeId: string; amountMinor: number }[],
    method = 'cash',
  ) =>
    insertRecord(db.sql, 'payment', {
      ...envelopeFor(f),
      schemaVersion: 5,
      id,
      type: 'payment',
      patientId: patient('000001'),
      receiptNumber: `${f.facility.id}-R-${String(receipt++)}-K2`,
      method,
      amountMinor: allocations.reduce((n, a) => n + a.amountMinor, 0),
      currency: 'NGN',
      allocations,
      ...(method === 'waiver' ? { reason: 'Synthetic waiver' } : {}),
    });

  let key: string;
  let billUrl: string;
  let receiptUrl: string;

  before(async () => {
    db = await scratchDatabase();
    f = await registerScratchFacility(db.sql);
    app = buildApp({ config, sql: db.sql, signer }, { logger: false, rateLimit: false });
    await db.sql`UPDATE facilities SET address = 'Synthetic Road 1', phone = '0800 000 0000', email = 'desk@example.org' WHERE id = ${f.facility.id}`;
    const admin = { ...envelopeFor(f), schemaVersion: 5 };
    await insertRecord(db.sql, 'patient', {
      ...admin,
      id: patient('000001'),
      patientId: patient('000001'),
      type: 'patient',
      fullName: 'Synthetic Patient',
      address: 'Synthetic address',
      sex: 'female',
      ageYears: 30,
      phone: '08031234567',
    });

    await insertRecord(db.sql, 'fee_item', {
      ...admin,
      id: 'fee:any',
      type: 'fee_item',
      name: 'Synthetic test',
      category: 'laboratory',
      amountMinor: 100_00,
      currency: 'NGN',
      chargeWhen: 'when_ordered',
    });

    const first = await charge('charge:fbc', 'Full blood count', 5_000_00);
    await charge('charge:malaria', 'Malaria parasite test', 2_500_00);
    await charge('charge:card', 'Patient card', 1_000_00, {
      category: 'card',
      amountMinor: 0,
      exemptionReason: 'Synthetic exemption',
    });

    await pay('payment:part', [{ chargeId: 'charge:fbc', amountMinor: 3_000_00 }]);
    await pay('payment:waiver', [{ chargeId: 'charge:malaria', amountMinor: 500_00 }], 'waiver');
    key = billKey(first as never);
  });

  after(async () => {
    if (app) {
      await app.close();
    }

    if (db) {
      await db.drop();
    }
  });

  /** The token at the end of a patient link, and the public API address for it. */
  const token = (url: string) => new URL(url).pathname.split('/').at(-1)!;

  const api = (kind: 'bill' | 'receipt', url: string, rest = '') =>
    `/public/documents/${kind}/${token(url)}${rest}`;

  it('staff get a web app link to a bill; the public API gives the patient the full bill', async () => {
    const created = await post('/billing/documents/link', { kind: 'bill', billKey: key });
    assert.equal(created.statusCode, 200, created.body);
    billUrl = created.json().url;
    assert.ok(billUrl.startsWith(config.corsOrigins[0]), 'the patient opens it in the web app');
    assert.match(new URL(billUrl).pathname, /^\/p\/b\/[A-Za-z0-9_-]{43}$/);
    assert.ok(Date.parse(created.json().expiresOn) > Date.now() + 29 * 86_400_000);
    const page = await app.inject({ method: 'GET', url: api('bill', billUrl) });
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(page.headers['cache-control'], 'no-store');
    const { kind, bill } = page.json();
    assert.equal(kind, 'bill');
    assert.equal(bill.patient.name, 'Synthetic Patient');
    assert.equal(bill.status, 'Part paid');
    assert.equal(bill.hospital.email, 'desk@example.org');
    assert.deepEqual(
      bill.lines.map((l: { description: string }) => l.description),
      ['Full blood count', 'Malaria parasite test', 'Patient card'],
    );

    // 5,000 + 2,500 (card exempt) − 500 waived − 3,000 paid = 4,000 due.
    assert.deepEqual(
      {
        due: bill.totals.dueMinor,
        paid: bill.totals.paidMinor,
        reduced: bill.totals.reducedMinor,
        exempt: bill.totals.exemptMinor,
      },
      { due: 4_000_00, paid: 3_000_00, reduced: 500_00, exempt: 1_000_00 },
    );

    assert.equal(bill.payable, false);
    const rows = await db.sql`SELECT token_hash FROM patient_document_links WHERE kind = 'bill'`;
    assert.equal(rows.length, 1);
    assert.ok(!String(rows[0].token_hash).includes(token(billUrl)), 'only the hash is stored');
  });

  it('serves the standard invoice PDF, whose QR code opens the web app page', async () => {
    const pdf = await app.inject({ method: 'GET', url: api('bill', billUrl, '/pdf') });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.match(pdf.headers['content-disposition'] as string, /Invoice-B-/);
    const doc = await PDFDocument.load(pdf.rawPayload);
    assert.equal(doc.getPageCount(), 1);
    assert.equal(doc.getPage(0).getWidth(), 595.28);
  });

  it('continues a long bill onto further pages', async () => {
    for (let i = 0; i < 70; i++) {
      await charge(
        `charge:long:${i}`,
        `Synthetic item ${i} with a long description that needs more than one line on the printed invoice`,
        100_00,
      );
    }

    const pdf = await app.inject({ method: 'GET', url: api('bill', billUrl, '/pdf') });
    assert.ok((await PDFDocument.load(pdf.rawPayload)).getPageCount() > 2);
  });

  it('gives a receipt for money received, never for a waiver', async () => {
    const created = await post('/billing/documents/link', {
      kind: 'receipt',
      paymentId: 'payment:part',
    });

    assert.equal(created.statusCode, 200, created.body);
    receiptUrl = created.json().url;

    const { receipt } = (
      await app.inject({ method: 'GET', url: api('receipt', receiptUrl) })
    ).json();

    assert.equal(receipt.amountMinor, 3_000_00);
    assert.equal(receipt.method, 'Cash');
    assert.equal(receipt.reversal, false);
    assert.ok(receipt.stillDue.length === 1 && receipt.stillDue[0].dueMinor > 0);
    const pdf = await app.inject({ method: 'GET', url: api('receipt', receiptUrl, '/pdf') });
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(
      (await post('/billing/documents/link', { kind: 'receipt', paymentId: 'payment:waiver' }))
        .statusCode,
      409,
    );
  });

  it('refuses unknown, mismatched and stopped links', async () => {
    assert.equal(
      (await app.inject({ method: 'GET', url: api('receipt', billUrl) })).statusCode,
      404,
      'a bill token is not a receipt token',
    );

    assert.equal(
      (await app.inject({ method: 'GET', url: '/public/documents/bill/not-a-token' })).statusCode,
      404,
    );

    assert.equal(
      (await app.inject({ method: 'GET', url: `/public/documents/statement/${token(billUrl)}` }))
        .statusCode,
      404,
    );

    assert.equal(
      (await app.inject({ method: 'GET', url: `/public/documents/bill/${'A'.repeat(43)}` }))
        .statusCode,
      404,
    );

    const stopped = await post('/billing/documents/stop', { kind: 'bill', billKey: key });
    assert.equal(stopped.json().stopped, 1);
    const page = await app.inject({ method: 'GET', url: api('bill', billUrl) });
    assert.equal(page.statusCode, 404);
    assert.equal(page.json().error, 'link_unavailable');
    assert.equal(
      (await app.inject({ method: 'GET', url: api('bill', billUrl, '/pdf') })).statusCode,
      404,
    );
  });

  it('lets the patient stop and restart SMS from their link', async () => {
    const choices = await app.inject({
      method: 'GET',
      url: api('receipt', receiptUrl, '/messages'),
    });

    assert.deepEqual(choices.json().sms, { to: '0803 *** 4567', stopped: false });

    const choose = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: api('receipt', receiptUrl, '/messages'),
        payload: payload as object,
      });

    const stopped = (await choose({ channel: 'sms', choice: 'stop' })).json();
    assert.deepEqual([stopped.changed, stopped.sms.stopped], [true, true]);

    const [row] =
      await db.sql`SELECT sms_stopped, source, created_by FROM patient_contacts WHERE patient_id = ${patient('000001')} ORDER BY created_on DESC LIMIT 1`;

    assert.deepEqual({ ...row }, { sms_stopped: true, source: 'patient', created_by: 'patient' });
    assert.equal((await choose({ channel: 'sms', choice: 'stop' })).json().changed, false);
    assert.equal((await choose({ channel: 'sms', choice: 'start' })).json().sms.stopped, false);
    assert.equal((await choose({ channel: 'fax', choice: 'stop' })).statusCode, 400);
  });

  it('only billing staff can make links', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/documents/link',
      headers: { authorization: `Bearer ${f.device.credential}` },
      payload: { kind: 'bill', billKey: key },
    });

    assert.equal(response.statusCode, 403);
  });
});
