import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RemittanceInput } from '#shared';
import { recordRemittance, reverseRemittance } from '../src/insurance/settlement.ts';
import { reserveSource, sourceCapacity } from '../src/billing/sourceCapacity.ts';
import { insertRecord } from '../src/db/records.ts';
import type { Tx } from '../src/db/client.ts';
import {
  asDevice,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
  staffSessionFor,
  testApp,
} from './postgres.ts';

describe('one verified receipt across patient and payer recognition', () => {
  let db: Awaited<ReturnType<typeof scratchDatabase>>;
  let f: Awaited<ReturnType<typeof registerScratchFacility>>;
  let app: ReturnType<typeof testApp>;
  let patientId: string;

  const receipt = async (id: string) =>
    insertRecord(db.sql, 'incoming_transfer', {
      ...envelopeFor(f),
      id,
      type: 'incoming_transfer',
      provider: 'paystack',
      providerReference: id,
      mode: 'live',
      amountMinor: 10000,
      currency: 'NGN',
      receivedOn: new Date().toISOString(),
    });

  const remit = (id: string, amountMinor: number) =>
    RemittanceInput.parse({
      payerId: 'payer:test',
      receivedOn: '2026-11-18',
      reference: id,
      amountMinor,
      currency: 'NGN',
      method: 'transfer',
      incomingTransferId: id,
      allocations: [],
      requestKey: 'request:' + id,
    });

  const payment = async (tx: Tx, id: string, sourceId: string, amountMinor: number) => {
    await tx`SELECT id FROM facilities WHERE id=${f.facility.id} FOR UPDATE`;
    await reserveSource(tx as never, f.facility.id, sourceId, amountMinor, 'NGN');
    await insertRecord(tx as never, 'payment', {
      ...envelopeFor(f),
      id,
      type: 'payment',
      patientId,
      receiptNumber: f.facility.id + '-R-' + (id.endsWith('race') ? '000002' : '000001') + '-Q2',
      method: 'transfer',
      incomingTransferId: sourceId,
      amountMinor,
      currency: 'NGN',
      allocations: [{ chargeId: 'charge:test', amountMinor }],
    });
  };

  before(async () => {
    db = await scratchDatabase();
    f = await registerScratchFacility(db.sql);
    app = testApp(db.sql);
    patientId = f.facility.id + '-000001-K2';
    await insertRecord(db.sql, 'payer', {
      ...envelopeFor(f),
      id: 'payer:test',
      type: 'payer',
      name: 'Synthetic payer',
      code: 'SYN',
      kind: 'hmo',
      active: true,
    });

    await insertRecord(db.sql, 'patient', {
      ...envelopeFor(f),
      id: patientId,
      type: 'patient',
      patientId,
      fullName: 'Synthetic',
      address: 'Synthetic',
      sex: 'female',
      ageYears: 30,
    });

    await insertRecord(db.sql, 'fee_item', {
      ...envelopeFor(f),
      id: 'fee:test',
      type: 'fee_item',
      name: 'Synthetic fee',
      category: 'other',
      amountMinor: 5000,
      currency: 'NGN',
      chargeWhen: 'when_ordered',
    });

    await insertRecord(db.sql, 'charge', {
      ...envelopeFor(f),
      id: 'charge:test',
      type: 'charge',
      patientId,
      feeItemId: 'fee:test',
      category: 'other',
      description: 'Synthetic fee',
      listPriceMinor: 5000,
      amountMinor: 5000,
      currency: 'NGN',
    });
  });

  after(async () => {
    await app?.close();
    await db?.drop();
  });

  it('shares capacity, reserves unallocated remittance money, and releases only reversed recognition', async () => {
    await receipt('receipt:shared');
    await db.sql.begin((tx) => payment(tx, 'payment:one', 'receipt:shared', 6000));
    await assert.rejects(
      db.sql.begin((tx) =>
        recordRemittance(tx as never, f.facility.id, f.admin.id, remit('receipt:shared', 5000)),
      ),
      /insufficient/,
    );

    const r = await db.sql.begin((tx) =>
      recordRemittance(tx as never, f.facility.id, f.admin.id, remit('receipt:shared', 4000)),
    );

    const capacity = await db.sql.begin((tx) =>
      sourceCapacity(tx as never, f.facility.id, 'receipt:shared'),
    );

    assert.equal(capacity.availableMinor, 0);
    assert.equal(capacity.patientMinor, 6000);
    assert.equal(capacity.payerMinor, 4000);
    await db.sql.begin((tx) =>
      reverseRemittance(tx as never, f.facility.id, f.admin.id, {
        remittanceId: r.remittanceId,
        reason: 'Synthetic correction',
        requestKey: 'reverse:synthetic',
      }),
    );

    assert.equal(
      (await db.sql.begin((tx) => sourceCapacity(tx as never, f.facility.id, 'receipt:shared')))
        .availableMinor,
      4000,
    );
  });

  it('allows a legitimate self-pay refund with insurance off but never replenishes the incoming receipt', async () => {
    await db.sql`UPDATE facilities SET integrated_billing_version=1 WHERE id=${f.facility.id}`;
    const proof = await staffSessionFor(app, f.device.credential, f.admin.id);
    assert.ok(proof);

    const response = await app.inject({
      method: 'POST',
      url: '/billing/refunds',
      headers: {
        ...asDevice(f.device.credential),
        'x-staff-session': proof,
        'x-billing-catalogue-version': '1',
        'x-integrated-billing-version': '1',
      },
      payload: {
        id: 'refund:selfpay123',
        patientId,
        method: 'cash',
        currency: 'NGN',
        allocations: [{ chargeId: 'charge:test', amountMinor: 500 }],
        reason: 'Return an existing patient credit',
      },
    });

    assert.equal(response.statusCode, 201, response.body);
    assert.equal(
      (await db.sql.begin((tx) => sourceCapacity(tx as never, f.facility.id, 'receipt:shared')))
        .availableMinor,
      4000,
    );
  });

  it('serializes a patient collection racing an insurer recognition of the same receipt', async () => {
    await receipt('receipt:race');

    const outcomes = await Promise.allSettled([
      db.sql.begin((tx) => payment(tx, 'payment:race', 'receipt:race', 6000)),
      db.sql.begin((tx) =>
        recordRemittance(tx as never, f.facility.id, f.admin.id, remit('receipt:race', 6000)),
      ),
    ]);

    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    assert.equal(
      (await db.sql.begin((tx) => sourceCapacity(tx as never, f.facility.id, 'receipt:race')))
        .availableMinor,
      4000,
    );
  });

  it('reserves exact legacy references across both workflows and recognizes a reversal without requiring a rewritten source link', async () => {
    await receipt('receipt:legacy');

    const original = {
      ...envelopeFor(f),
      id: 'payment:legacy',
      type: 'payment',
      patientId,
      receiptNumber: f.facility.id + '-R-000003-Q2',
      method: 'transfer',
      reference: ' RECEIPT:LEGACY ',
      amountMinor: 4000,
      currency: 'NGN',
      allocations: [{ chargeId: 'charge:test', amountMinor: 4000 }],
    };

    await insertRecord(db.sql, 'payment', original);
    await db.sql`INSERT INTO insurance_remittances(id,facility_id,payer_id,received_on,reference,amount_minor,currency,method,recorded_by) VALUES('remittance:legacy',${f.facility.id},'payer:test','2026-11-18','receipt:legacy',3000,'NGN','transfer',${f.admin.id})`;

    const before = await db.sql.begin((tx) =>
      sourceCapacity(tx as never, f.facility.id, 'receipt:legacy'),
    );

    assert.equal(before.patientMinor, 4000);
    assert.equal(before.payerMinor, 3000);
    assert.equal(before.availableMinor, 3000);
    await assert.rejects(
      db.sql.begin((tx) =>
        reserveSource(tx as never, f.facility.id, 'receipt:legacy', 4000, 'NGN'),
      ),
      /insufficient/,
    );

    await insertRecord(db.sql, 'payment', {
      ...original,
      id: 'payment:legacy-reversal',
      receiptNumber: f.facility.id + '-R-000004-Q2',
      reference: undefined,
      reverses: original.id,
      reason: 'Correct a legacy recognition; source is retained on the original',
    });

    assert.equal(
      (await db.sql.begin((tx) => sourceCapacity(tx as never, f.facility.id, 'receipt:legacy')))
        .availableMinor,
      7000,
    );
  });
});
