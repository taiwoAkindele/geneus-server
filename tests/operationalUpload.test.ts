import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, Staff, UploadMutation } from '#shared';
import { addStaff, clientId, envelopeFor, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

describe('stock ledger and versioned register uploads', () => {
  let db: ScratchDatabase, app: FastifyInstance, facility: FacilityRegistrationResult, other: FacilityRegistrationResult, nurse: Staff, readOnly: Staff;
  const put = (table: UploadMutation['table'], id: string, fields: Record<string, unknown>, actor?: Staff): UploadMutation => ({ clientId: clientId(), op: 'put', table, id, data: { ...envelopeFor(facility), createdBy: actor?.id ?? facility.admin.id, ...fields, id, type: table } });
  const send = (...mutations: UploadMutation[]) => upload(app, facility.device.credential, { transactionId: 1, mutations });
  const movement = (id: string, change: number, reason = 'received', extra: Record<string, unknown> = {}, actor?: Staff) => put('stock_movement', id, { itemId: 'stock:item', change, reason, movedOn: new Date().toISOString(), ...extra }, actor);
  const entry = (id: string, values: Record<string, unknown>, registerVersion = 1) => put('register_entry', id, { registerId: 'register:daily', registerVersion, entryDate: '2026-10-26', values });
  const patch = (fields: Record<string, unknown>): UploadMutation => ({ clientId: clientId(), op: 'patch', table: 'stock_item', id: 'stock:item', data: { ...fields, updatedBy: facility.admin.id, updatedOn: new Date().toISOString() } });
  before(async () => {
    db = await scratchDatabase(); app = testApp(db.sql);
    facility = await registerScratchFacility(db.sql); other = await registerScratchFacility(db.sql);
    nurse = await addStaff(db.sql, facility, { role: 'nurse' });
    readOnly = await addStaff(db.sql, facility, { role: 'nurse', permission: 'read_only' });
    const response = await send(
      put('stock_item', 'stock:item', { name: 'Test supplies', category: 'consumable', unitOfMeasure: 'boxes', quantityOnHand: 10 }),
      put('register_definition', 'register:daily:v1', { registerId: 'register:daily', version: 1, name: 'Daily register', category: 'General', status: 'published', fields: [{ id: 'name', type: 'text', label: 'Name', required: true }, { id: 'result', type: 'select', label: 'Result', required: true, options: ['Positive', 'Negative'] }] }),
      put('register_definition', 'register:daily:v2', { registerId: 'register:daily', version: 2, name: 'Draft revision', category: 'General', status: 'draft', fields: [] }),
    );
    assert.deepEqual(response.rejected, []);
  });
  after(async () => { if (app) await app.close(); if (db) await db.drop(); });
  it('preserves an attributed movement ledger and acknowledges retries without applying twice', async () => {
    const received = movement('stock:received', 5, 'received', {}, nurse);
    assert.deepEqual((await send(received, movement('stock:used', -3, 'dispensed', {}, nurse))).rejected, []);
    assert.deepEqual((await send(received)).rejected, []);
    const [row] = await db.sql`SELECT count(*)::int AS n, sum(change) AS change FROM stock_movements WHERE item_id = 'stock:item'`;
    assert.equal(row.n, 2); assert.equal(Number(row.change), 2);
    const [item] = await db.sql`SELECT quantity_on_hand FROM stock_items WHERE id = 'stock:item'`;
    assert.equal(Number(item.quantity_on_hand), 10);
  });
  it('rejects zero movements, reversed signs and unexplained count adjustments', async () => {
    const response = await send(movement('stock:zero', 0), movement('stock:negative-receipt', -1), movement('stock:positive-dispense', 1, 'dispensed'), movement('stock:unexplained', 2, 'adjustment'));
    assert.equal(response.rejected.length, 4);
    assert.ok(response.rejected.every((rejection) => rejection.category === 'validation'));
  });
  it('preserves an offline-reported usage discrepancy rather than silently losing physical movements', async () => {
    assert.deepEqual((await send(movement('stock:offline-usage', -50, 'dispensed', {}, nurse))).rejected, []);
    const [row] = await db.sql`SELECT sum(change) AS change FROM stock_movements WHERE item_id = 'stock:item'`;
    assert.equal(10 + Number(row.change), -38);
  });
  it('prevents editing opening balances and changing measurement units after movements', async () => {
    assert.match((await send(patch({ quantityOnHand: 999 }))).rejected[0]?.reason ?? '', /opening stock balance/);
    assert.match((await send(patch({ unitOfMeasure: 'tablets' }))).rejected[0]?.reason ?? '', /unit of measure/);
    assert.deepEqual((await send(patch({ name: 'Renamed supplies' }))).rejected, []);
  });
  it('enforces staff permissions and facility ownership', async () => {
    assert.equal((await send(movement('stock:readonly', 1, 'received', {}, readOnly))).rejected[0]?.category, 'authorization');
    assert.deepEqual((await upload(app, other.device.credential, { transactionId: 1, mutations: [{ clientId: clientId(), op: 'put', table: 'stock_item', id: 'stock:foreign', data: { ...envelopeFor(other), type: 'stock_item', id: 'stock:foreign', name: 'Other supplies' } }] })).rejected, []);
    assert.equal((await send(movement('stock:cross-facility', 1, 'received', { itemId: 'stock:foreign' }))).rejected[0]?.category, 'validation');
  });
  it('validates actual required fields and options against the saved published register version', async () => {
    const response = await send(entry('entry:missing', {}), entry('entry:bad-option', { name: 'Test', result: 'Unknown' }), entry('entry:extra', { name: 'Test', result: 'Negative', outside: 'not defined' }), entry('entry:draft', {}, 2));
    assert.equal(response.rejected.length, 4);
    assert.ok(response.rejected.every((rejection) => rejection.category === 'validation'));
    assert.deepEqual((await send(entry('entry:valid', { name: 'Test', result: 'Negative' }))).rejected, []);
  });
  it('retains refused values for review and accepts old-version entries after a new publication', async () => {
    const [rejection] = await db.sql`SELECT refused_record FROM sync_rejections WHERE entity_id = 'entry:bad-option'`;
    assert.equal(rejection.refused_record.values.result, 'Unknown');
    assert.deepEqual((await send(put('register_definition', 'register:daily:v3', { registerId: 'register:daily', version: 3, name: 'New version', category: 'General', status: 'published', fields: [{ id: 'new', type: 'number', label: 'New field', required: true }] }), entry('entry:old-version', { name: 'Older device entry', result: 'Positive' }))).rejected, []);
  });
  it('keeps handoffs attached to the correct visit and prevents reopening completed work', async () => {
    const patientId = `${facility.facility.id}-000001-K2`;
    const otherPatientId = `${facility.facility.id}-000002-K2`;
    assert.deepEqual((await send(
      put('patient', patientId, { patientId, fullName: 'Queue Patient', address: 'Test road', sex: 'female', ageYears: 30 }),
      put('patient', otherPatientId, { patientId: otherPatientId, fullName: 'Other Queue Patient', address: 'Test road', sex: 'male', ageYears: 35 }),
      put('unit', 'unit:from', { unitId: 'unit:from', name: 'Consultation' }),
      put('unit', 'unit:to', { unitId: 'unit:to', name: 'Laboratory' }),
      put('encounter', 'encounter:handoff', { patientId, openedOn: new Date().toISOString() }),
    )).rejected, []);
    const handoff = { patientId, encounterId: 'encounter:handoff', fromUnitId: 'unit:from', toUnitId: 'unit:to', instruction: 'Carry out the requested work' };
    assert.equal((await send(put('handoff', 'handoff:wrong-patient', { ...handoff, patientId: otherPatientId }, nurse))).rejected[0]?.category, 'validation');
    assert.deepEqual((await send(put('handoff', 'handoff:valid', handoff, nurse))).rejected, []);
    const update = (data: Record<string, unknown>, id = 'handoff:valid'): UploadMutation => ({ clientId: clientId(), op: 'patch', table: 'handoff', id, previous: { status: 'pending' }, data: { ...data, updatedBy: nurse.id, updatedOn: new Date().toISOString() } });
    assert.deepEqual((await send(update({ status: 'done' }))).rejected, []);
    assert.equal((await send(update({ status: 'received' }))).rejected[0]?.category, 'conflict');
    assert.equal((await send(update({ instruction: 'Changed silently' }))).rejected[0]?.category, 'authorization');
    const [row] = await db.sql`SELECT status, instruction FROM handoffs WHERE id = 'handoff:valid'`;
    assert.equal(row.status, 'done'); assert.equal(row.instruction, handoff.instruction);
    assert.deepEqual((await send(put('handoff', 'handoff:race', handoff, nurse))).rejected, []);
    await Promise.all([send(update({ status: 'done' }, 'handoff:race')), send(update({ status: 'received' }, 'handoff:race'))]);
    const [raced] = await db.sql`SELECT status FROM handoffs WHERE id = 'handoff:race'`;
    assert.equal(raced.status, 'done');
  });
});
