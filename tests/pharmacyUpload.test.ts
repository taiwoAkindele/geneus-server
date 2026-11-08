import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { POLICY_VERSION, EncounterEntry, dispensingSummary, pharmacyChargeId, pharmacyEffects, type FacilityRegistrationResult, type Staff, type UploadMutation, type DispensingDetails } from '#shared';
import { insertRecord, findRecord } from '../src/db/records.ts';
import { pharmacyRecords } from '../src/clinical/pharmacy.ts';
import { addStaff, clientId, envelopeFor, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

describe('atomic pharmacy supply uploads', () => {
  let db: ScratchDatabase, app: FastifyInstance, facility: FacilityRegistrationResult, doctor: Staff, pharmacist: Staff, cashier: Staff, sequence = 0;
  before(async () => { db = await scratchDatabase(); app = testApp(db.sql); facility = await registerScratchFacility(db.sql); doctor = await addStaff(db.sql, facility, { role: 'doctor' }); pharmacist = await addStaff(db.sql, facility, { role: 'pharmacy_staff' }); cashier = await addStaff(db.sql, facility, { role: 'cashier' }); });
  after(async () => { await app.close(); await db.drop(); });
  const send = (...mutations: UploadMutation[]) => upload(app, facility.device.credential, { pharmacyWorkflowVersion: 1, clinicalWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: POLICY_VERSION, transactionId: 1, mutations });
  const setup = async () => {
    const n = ++sequence, base = { ...envelopeFor(facility), schemaVersion: 5, createdBy: doctor.id }, patientId = `${facility.facility.id}-${String(n).padStart(6, '0')}-K2`, encounterId = `visit:pharmacy:${n}`, sourceId = `rx:pharmacy:${n}`, lineId = `line:${n}`, stockId = `stock:${n}`, feeId = `fee:${n}`;
    await insertRecord(db.sql, 'patient', { ...base, id: patientId, type: 'patient', patientId, fullName: 'Synthetic pharmacy patient', address: 'Synthetic address', sex: 'female', ageYears: 30 });
    await insertRecord(db.sql, 'encounter', { ...base, id: encounterId, type: 'encounter', patientId, openedOn: base.createdOn });
    const source = EncounterEntry.parse({ ...base, id: sourceId, type: 'encounter_entry', patientId, encounterId, actorRole: 'doctor', workflowVersion: 1, step: 'prescription', values: { decision: 'prescribed', prescription: [{ lineId, drug: 'Synthetic medicine', dose: 'Recorded instructions', quantity: 20, unitOfMeasure: 'tablets' }] } });
    await insertRecord(db.sql, 'encounter_entry', source);
    await insertRecord(db.sql, 'fee_item', { ...base, id: feeId, type: 'fee_item', name: 'Synthetic medicine', category: 'other', amountMinor: 100, currency: 'NGN', chargeWhen: 'when_ordered', active: true, exemptions: [] });
    await insertRecord(db.sql, 'stock_item', { ...base, id: stockId, type: 'stock_item', name: 'Synthetic medicine', category: 'drug', unitOfMeasure: 'tablets', quantityOnHand: 100, feeItemId: feeId });
    const d = (change: Partial<DispensingDetails> = {}): DispensingDetails => ({ prescriptionEntryId: sourceId, lineId, action: 'supply', complete: false, quantity: 5, unit: 'tablets', source: 'stock', stockItemId: stockId, billing: 'charge', feeItemId: feeId, unitPriceMinor: 100, currency: 'NGN', chargedMinor: 500, ...change });
    const entry = async (id: string, details = d(), actor = pharmacist) => {
      const data = await pharmacyRecords(db.sql as never, source);
      const record = EncounterEntry.parse({ ...base, id, createdBy: actor.id, createdOn: new Date().toISOString(), type: 'encounter_entry', patientId, encounterId, actorRole: actor.role, workflowVersion: 1, pharmacyVersion: 1, step: 'dispense', values: { supply: details, lines: [{ drug: 'Synthetic medicine', dispensed: false, reason: 'Pending' }] } });
      record.values.lines = dispensingSummary(source, data.entries, record);
      return { record, mutation: { clientId: clientId(), op: 'put', table: 'encounter_entry', id, data: record } as UploadMutation, data };
    };
    return { base, patientId, encounterId, source, stockId, feeId, d, entry };
  };
  it('accepts clinical supply, stock and billing together and deduplicates response-loss retries', async () => {
    const c = await setup(), first = await c.entry('pharmacy:first');
    const sent = await send(first.mutation); assert.deepEqual(sent.rejected, []);
    const legacy = { ...first.record, id: 'pharmacy:legacy-bypass', pharmacyVersion: undefined, values: { lines: [{ drug: 'Synthetic medicine', dispensed: true }] } };
    assert.equal((await send({ clientId: clientId(), op: 'put', table: 'encounter_entry', id: legacy.id, data: legacy })).rejected.length, 1);
    const [movement] = await db.sql`SELECT change,dispense_entry_id FROM stock_movements WHERE dispense_entry_id=${first.record.id}`;
    const charge = await findRecord(db.sql, 'charge', pharmacyChargeId(first.record.id));
    assert.equal(Number(movement.change), -5); assert.equal(charge?.type === 'charge' && charge.amountMinor, 500);
    assert.equal((await send(first.mutation)).duplicates, 1);
    assert.equal((await db.sql`SELECT id FROM stock_movements WHERE dispense_entry_id=${first.record.id}`).length, 1);
    const children = pharmacyEffects(first.record, first.data).map((record) => ({ clientId: clientId(), op: 'put', table: record.type, id: record.id, data: record }) as UploadMutation);
    assert.deepEqual((await send(...children)).rejected, []);
  });
  it('refuses stale competing updates without applying companion stock or bills', async () => {
    const c = await setup(), a = await c.entry('pharmacy:race:a'), b = await c.entry('pharmacy:race:b');
    const outcomes = await Promise.all([send(a.mutation), send(b.mutation)]);
    assert.equal(outcomes.reduce((n, r) => n + r.rejected.length, 0), 1);
    assert.equal((await db.sql`SELECT id FROM charges WHERE encounter_id=${c.encounterId}`).length, 1);
    assert.equal((await db.sql`SELECT id FROM stock_movements WHERE item_id=${c.stockId}`).length, 1);
  });
  it('rolls back the clinical parent if a companion cannot be inserted', async () => {
    const c = await setup(), first = await c.entry('pharmacy:collision');
    await insertRecord(db.sql, 'charge', { ...c.base, id: pharmacyChargeId(first.record.id), type: 'charge', patientId: c.patientId, feeItemId: c.feeId, description: 'Existing unrelated fee', category: 'other', listPriceMinor: 1, amountMinor: 1, currency: 'NGN' });
    assert.equal((await send(first.mutation)).rejected.length, 1);
    assert.equal(await findRecord(db.sql, 'encounter_entry', first.record.id), undefined);
    assert.equal((await db.sql`SELECT id FROM stock_movements WHERE item_id=${c.stockId}`).length, 0);
  });
  it('supports price follow-up and returns against the original billed supply', async () => {
    const c = await setup(), first = await c.entry('pharmacy:unpriced', c.d({ billing: 'unpriced', feeItemId: undefined, unitPriceMinor: undefined, currency: undefined, chargedMinor: undefined, reason: 'Price needs checking' }));
    assert.deepEqual((await send(first.mutation)).rejected, []);
    const priced = await c.entry('pharmacy:priced', { prescriptionEntryId: c.source.id, lineId: c.d().lineId, previousEntryId: first.record.id, action: 'price', priceFor: first.record.id, complete: false, quantity: 5, unit: 'tablets', billing: 'charge', feeItemId: c.feeId, unitPriceMinor: 100, currency: 'NGN', chargedMinor: 500 });
    assert.deepEqual((await send(priced.mutation)).rejected, []);
    const returned = await c.entry('pharmacy:return', { prescriptionEntryId: c.source.id, lineId: c.d().lineId, previousEntryId: priced.record.id, action: 'return', returnOf: first.record.id, complete: false, quantity: 2, unit: 'tablets', restock: true, creditMinor: 200, reason: 'Recorded medicine return' });
    assert.deepEqual((await send(returned.mutation)).rejected, []);
    const [credit] = await db.sql`SELECT amount_minor,charge_id FROM billing_adjustments WHERE dispense_entry_id=${returned.record.id}`;
    assert.equal(Number(credit.amount_minor), 200); assert.equal(credit.charge_id, pharmacyChargeId(priced.record.id));
    assert.equal((await db.sql`SELECT id FROM stock_movements WHERE item_id=${c.stockId}`).length, 2);
  });
  it('rejects foreign stock, forged child records and non-clinical actors', async () => {
    const c = await setup(), invalid = await c.entry('pharmacy:bad-stock', c.d({ stockItemId: 'stock:foreign' }));
    const oldClient = await app.inject({ method: 'POST', url: '/sync/upload', headers: { authorization: `Bearer ${facility.device.credential}` }, payload: { transactionId: 1, mutations: [invalid.mutation], clinicalWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: POLICY_VERSION } });
    assert.equal(oldClient.statusCode, 400);
    assert.equal((await send(invalid.mutation)).rejected.length, 1);
    const unauthorized = await c.entry('pharmacy:cashier', c.d(), cashier); assert.equal((await send(unauthorized.mutation)).rejected.length, 1);
    const first = await c.entry('pharmacy:valid'); assert.deepEqual((await send(first.mutation)).rejected, []);
    const child = pharmacyEffects(first.record, first.data).find((e) => e.type === 'charge')!;
    const forged = { ...child, amountMinor: 1, listPriceMinor: 1 };
    assert.equal((await send({ clientId: clientId(), op: 'put', table: 'charge', id: child.id, data: forged })).rejected.length, 1);
  });
});
