import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, FeeItem, Staff, UploadMutation } from '#shared';
import { findRecord } from '../src/db/records.ts';
import {
  addStaff,
  clientId,
  envelopeFor,
  refusal,
  registerScratchFacility,
  scratchDatabase,
  testApp,
  upload,
  type ScratchDatabase,
} from './postgres.ts';

/**
 * Billing on upload (SCHEMA.md §14, PRD §9.13): who may raise fees, take money,
 * waive and reverse; that charges and payments are never changed once saved;
 * and that a payment only ever settles its own patient's charges. Money that
 * changed hands is never refused for being too much — two cashiers offline can
 * both be paid for the same fee.
 */
describe('billing on upload', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let a: FacilityRegistrationResult;
  let nurse: Staff;
  let records: Staff;
  let cashier: Staff;
  let supervisor: Staff;

  const patientId = (sequence: string) => `${a.facility.id}-${sequence}-K2`;
  const receipt = (sequence: string) => `${a.facility.id}-R-${sequence}-K2`;

  const envelope = (by: Staff | FacilityRegistrationResult['admin']) => ({ ...envelopeFor(a), createdBy: by.id });

  const put = (table: UploadMutation['table'], id: string, data: Record<string, unknown>): UploadMutation => ({
    clientId: clientId(),
    op: 'put',
    table,
    id,
    data: { ...data, id, type: table },
  });

  const patch = (table: UploadMutation['table'], id: string, by: Staff | FacilityRegistrationResult['admin'], changes: Record<string, unknown>): UploadMutation => ({
    clientId: clientId(),
    op: 'patch',
    table,
    id,
    data: { ...changes, updatedBy: by.id, updatedOn: new Date().toISOString() },
  });

  const send = (...mutations: UploadMutation[]) => upload(app, a.device.credential, { transactionId: 1, mutations });

  const patientPut = (sequence: string, fullName: string) =>
    put('patient', patientId(sequence), {
      ...envelope(records),
      patientId: patientId(sequence),
      fullName,
      address: 'Odo-Ona',
      sex: 'female',
      ageYears: 28,
    });

  const chargePut = (id: string, patient: string, extra: Record<string, unknown> = {}) =>
    put('charge', id, {
      ...envelope(records),
      patientId: patient,
      feeItemId: 'fee_item:consultation',
      description: 'Consultation',
      category: 'consultation',
      listPriceMinor: 150000,
      amountMinor: 150000,
      currency: 'NGN',
      ...extra,
    });

  const paymentPut = (id: string, by: Staff, patient: string, allocations: { chargeId: string; amountMinor: number }[], extra: Record<string, unknown> = {}) =>
    put('payment', id, {
      ...envelope(by),
      patientId: patient,
      receiptNumber: receipt(id.replace(/\D/g, '').padStart(6, '0')),
      method: 'cash',
      amountMinor: allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0),
      currency: 'NGN',
      allocations,
      ...extra,
    });

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    a = await registerScratchFacility(db.sql);
    [nurse, records, cashier, supervisor] = await Promise.all([
      addStaff(db.sql, a, { role: 'nurse' }),
      addStaff(db.sql, a, { role: 'records_officer' }),
      addStaff(db.sql, a, { role: 'cashier' }),
      addStaff(db.sql, a, { role: 'supervisor' }),
    ]);

    const setup = await send(
      patientPut('000001', 'Amaka Okoro'),
      patientPut('000002', 'Bisi Adeyemi'),
      put('fee_item', 'fee_item:consultation', {
        ...envelope(a.admin),
        name: 'Consultation',
        category: 'consultation',
        amountMinor: 150000,
        currency: 'NGN',
        chargeWhen: 'every_visit',
        exemptions: [{ reason: 'Under-5 policy', ageUnderYears: 5 }],
      }),
      put('appointment', 'appointment:1', {
        ...envelope(records),
        patientId: patientId('000001'),
        reason: 'Antenatal booking',
        visitType: 'antenatal',
      }),
      put('appointment', 'appointment:2', {
        ...envelope(records),
        patientId: patientId('000002'),
        reason: 'Fever',
        visitType: 'general',
      }),
      chargePut('charge:1', patientId('000001'), { appointmentId: 'appointment:1' }),
      chargePut('charge:2', patientId('000002'), { appointmentId: 'appointment:2' }),
      chargePut('charge:3', patientId('000001')),
      chargePut('charge:usd', patientId('000001'), { currency: 'USD' }),
    );
    assert.deepEqual(setup.rejected, []);
  });

  after(async () => {
    await app.close();
    await db.drop();
  });

  describe('the fee schedule', () => {
    it('keeps a fee and its exemption rules as written', async () => {
      const fee = await findRecord<FeeItem>(db.sql, 'fee_item', 'fee_item:consultation');

      assert.equal(fee?.amountMinor, 150000);
      assert.deepEqual(fee?.exemptions, [{ reason: 'Under-5 policy', ageUnderYears: 5 }]);
    });

    it('lets the facility admin change a price', async () => {
      const response = await send(patch('fee_item', 'fee_item:consultation', a.admin, { amountMinor: 200000 }));

      assert.deepEqual(response.rejected, []);
      assert.equal((await findRecord<FeeItem>(db.sql, 'fee_item', 'fee_item:consultation'))?.amountMinor, 200000);
    });

    it('refuses a fee set up by anyone but the facility admin', async () => {
      const response = await send(
        put('fee_item', 'fee_item:card', {
          ...envelope(nurse),
          name: 'Patient card',
          category: 'card',
          amountMinor: 50000,
          currency: 'NGN',
          chargeWhen: 'first_visit',
        }),
      );

      assert.equal(response.rejected[0]?.category, 'authorization');
    });
  });

  describe('raising fees', () => {
    it('refuses a charge that owes less than its price without an exemption', async () => {
      const response = await send(chargePut('charge:discounted', patientId('000001'), { amountMinor: 100000 }));

      assert.equal(response.rejected[0]?.category, 'validation');
    });

    it('applies an exempt charge that owes nothing, keeping the price it would have been', async () => {
      const response = await send(chargePut('charge:exempt', patientId('000001'), { amountMinor: 0, exemptionReason: 'Under-5 policy' }));

      assert.deepEqual(response.rejected, []);
    });

    it("refuses a charge naming another patient's appointment", async () => {
      const response = await send(chargePut('charge:crossed', patientId('000001'), { appointmentId: 'appointment:2' }));

      assert.equal(response.rejected[0]?.category, 'validation');
    });

    it('refuses a fee raised by the cashier, who only takes money', async () => {
      const response = await send(put('charge', 'charge:by-cashier', { ...chargePut('x', patientId('000001')).data, createdBy: cashier.id }));

      assert.equal(response.rejected[0]?.category, 'authorization');
    });
  });

  describe('taking payments', () => {
    it("applies the cashier's payment against the patient's charge", async () => {
      const response = await send(paymentPut('payment:1', cashier, patientId('000001'), [{ chargeId: 'charge:1', amountMinor: 150000 }]));

      assert.deepEqual(response.rejected, []);
    });

    it('accepts a second payment for a fee already paid — the money changed hands', async () => {
      const response = await send(paymentPut('payment:2', cashier, patientId('000001'), [{ chargeId: 'charge:1', amountMinor: 150000 }]));

      assert.deepEqual(response.rejected, []);
    });

    it("refuses a payment allocated to another patient's charge", async () => {
      const response = await send(paymentPut('payment:3', cashier, patientId('000001'), [{ chargeId: 'charge:2', amountMinor: 150000 }]));

      assert.equal(response.rejected[0]?.category, 'validation');
      assert.match(response.rejected[0]?.reason ?? '', /another patient/);
    });

    it('refuses a payment for a charge that does not exist', async () => {
      const response = await send(paymentPut('payment:4', cashier, patientId('000001'), [{ chargeId: 'charge:missing', amountMinor: 150000 }]));

      assert.equal(response.rejected[0]?.category, 'validation');
    });

    it('refuses a payment in a different currency from the charge', async () => {
      const response = await send(paymentPut('payment:5', cashier, patientId('000001'), [{ chargeId: 'charge:usd', amountMinor: 150000 }]));

      assert.match(response.rejected[0]?.reason ?? '', /is in USD, not NGN/);
    });

    it('refuses a payment taken by a nurse', async () => {
      const response = await send(paymentPut('payment:6', nurse, patientId('000001'), [{ chargeId: 'charge:3', amountMinor: 150000 }]));

      assert.equal(response.rejected[0]?.category, 'authorization');
    });

    it('refuses a receipt number already used in the facility', async () => {
      const response = await send(
        paymentPut('payment:7', cashier, patientId('000001'), [{ chargeId: 'charge:3', amountMinor: 150000 }], {
          receiptNumber: receipt('000001'),
        }),
      );

      assert.equal(response.rejected[0]?.category, 'conflict');
    });
  });

  describe('waivers', () => {
    it('refuses a waiver from the cashier', async () => {
      const response = await send(
        paymentPut('payment:8', cashier, patientId('000002'), [{ chargeId: 'charge:2', amountMinor: 150000 }], {
          method: 'waiver',
          reason: 'Destitute',
        }),
      );

      assert.equal(response.rejected[0]?.category, 'authorization');
    });

    it("applies a supervisor's waiver with a reason", async () => {
      const response = await send(
        paymentPut('payment:9', supervisor, patientId('000002'), [{ chargeId: 'charge:2', amountMinor: 150000 }], {
          method: 'waiver',
          reason: 'Destitute',
        }),
      );

      assert.deepEqual(response.rejected, []);
    });
  });

  describe('reversals', () => {
    const reversalOf = (id: string, by: Staff, extra: Record<string, unknown> = {}) =>
      paymentPut(id, by, patientId('000001'), [{ chargeId: 'charge:1', amountMinor: 150000 }], {
        reverses: 'payment:2',
        reason: 'Paid twice',
        ...extra,
      });

    it('refuses a reversal from the cashier', async () => {
      const response = await send(reversalOf('payment:10', cashier));

      assert.equal(response.rejected[0]?.category, 'authorization');
    });

    it('refuses a reversal that does not repeat the original exactly', async () => {
      const response = await send(
        paymentPut('payment:11', supervisor, patientId('000001'), [{ chargeId: 'charge:3', amountMinor: 150000 }], {
          reverses: 'payment:2',
          reason: 'Paid twice',
        }),
      );

      assert.match(response.rejected[0]?.reason ?? '', /must repeat payment payment:2/);
    });

    it("applies a supervisor's reversal, and keeps the original", async () => {
      const response = await send(reversalOf('payment:12', supervisor));

      assert.deepEqual(response.rejected, []);
      assert.ok(await findRecord(db.sql, 'payment', 'payment:2'));
    });

    it('refuses reversing the same payment twice', async () => {
      const response = await send(reversalOf('payment:13', supervisor));

      assert.equal(response.rejected[0]?.category, 'conflict');
      assert.match(response.rejected[0]?.reason ?? '', /already reversed/);
    });

    it('refuses reversing a reversal', async () => {
      const response = await send(reversalOf('payment:14', supervisor, { reverses: 'payment:12' }));

      assert.match(response.rejected[0]?.reason ?? '', /itself a reversal/);
    });
  });

  describe('saved means saved', () => {
    it('refuses a change to a charge or a payment', async () => {
      const response = await send(
        patch('charge', 'charge:3', a.admin, { amountMinor: 1 }),
        patch('payment', 'payment:1', a.admin, { reference: 'edited' }),
      );

      assert.deepEqual(
        response.rejected.map((rejection) => rejection.reason),
        ['charge records are append-only', 'payment records are append-only'],
      );
    });

    it('holds the rule in PostgreSQL too', async () => {
      const error = await refusal(db.sql`UPDATE payments SET reference = 'edited' WHERE id = 'payment:1'`);

      assert.equal(error.code, '42501');
    });
  });

  describe('encounters booked as appointments', () => {
    it('opens an encounter linked to its appointment, recording why it went ahead unpaid', async () => {
      const response = await send(
        put('encounter', 'encounter:unpaid', {
          ...envelope(nurse),
          patientId: patientId('000001'),
          openedOn: new Date().toISOString(),
          appointmentId: 'appointment:1',
          collectLaterReason: 'Emergency',
        }),
      );

      assert.deepEqual(response.rejected, []);
    });

    it("refuses an encounter naming another patient's appointment", async () => {
      const response = await send(
        put('encounter', 'encounter:crossed', {
          ...envelope(nurse),
          patientId: patientId('000001'),
          openedOn: new Date().toISOString(),
          appointmentId: 'appointment:2',
        }),
      );

      assert.equal(response.rejected[0]?.category, 'validation');
    });

    it('refuses a care step saved by the cashier', async () => {
      const response = await send(
        put('encounter_entry', 'encounter_entry:by-cashier', {
          ...envelope(cashier),
          encounterId: 'encounter:unpaid',
          patientId: patientId('000001'),
          step: 'vitals',
          actorRole: 'cashier',
          values: { temperatureC: 37 },
        }),
      );

      assert.equal(response.rejected[0]?.category, 'authorization');
    });
  });
});
