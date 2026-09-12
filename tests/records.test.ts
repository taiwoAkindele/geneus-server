import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Patient,
  RegisterDefinition,
  StockItem,
  type FacilityRegistrationResult,
  type RegisterDefinition as RegisterDefinitionRecord,
  type Patient as PatientRecord,
  type StockItem as StockItemRecord,
} from '#shared';
import { camelCase, findRecord, insertRecord, snakeCase } from '../src/db/records.ts';
import { envelopeFor, registerScratchFacility, scratchDatabase, type ScratchDatabase } from './postgres.ts';

/**
 * The camelCase ↔ snake_case boundary is mechanical, which is exactly why it is
 * tested by round trip: whatever the contract says goes in must come back out
 * identical, arrays, JSON, dates and numbers included.
 */
describe('records', () => {
  let db: ScratchDatabase;
  let facility: FacilityRegistrationResult;

  before(async () => {
    db = await scratchDatabase();
    facility = await registerScratchFacility(db.sql);
  });

  after(async () => {
    await db.drop();
  });

  it('renames keys both ways without losing anything', () => {
    for (const key of ['facilityId', 'dateOfBirth', 'legacyPaperRef', 'notYetArrivedFlagged', 'tier1', 'id']) {
      assert.equal(camelCase(snakeCase(key)), key, key);
    }
  });

  it('round-trips a patient: text array, date, optional fields, UTC-normalised times', async () => {
    const written = Patient.parse({
      ...envelopeFor(facility, '2026-09-12T09:30:00+01:00'),
      id: 'ROUND-TRIP-000001-K2',
      type: 'patient',
      patientId: 'ROUND-TRIP-000001-K2',
      fullName: 'Amaka Okoro',
      address: 'Odo-Ona',
      sex: 'female',
      dateOfBirth: '1994-03-08',
      allergies: ['penicillin', 'sulfa'],
      phone: '08012345678',
    });
    await insertRecord(db.sql, 'patient', written);

    const read = await findRecord<PatientRecord>(db.sql, 'patient', written.id);

    assert.deepEqual(read, { ...written, createdOn: '2026-09-12T08:30:00.000Z' });
    assert.equal(read?.occupation, undefined);
  });

  it('round-trips a register definition with its JSONB fields intact', async () => {
    const written = RegisterDefinition.parse({
      ...envelopeFor(facility),
      id: 'register:opd:v1',
      type: 'register_definition',
      registerId: 'register:opd',
      version: 1,
      name: 'OPD',
      category: 'General',
      status: 'published',
      fields: [
        { id: 'f1', type: 'text', label: 'Complaint', required: true },
        { id: 'f2', type: 'select', label: 'Outcome', options: ['Treated', 'Referred'] },
      ],
    });
    await insertRecord(db.sql, 'register_definition', written);

    const read = await findRecord<RegisterDefinitionRecord>(db.sql, 'register_definition', written.id);

    assert.deepEqual(read?.fields, written.fields);
  });

  it('reads numeric columns back as numbers', async () => {
    const written = StockItem.parse({
      ...envelopeFor(facility),
      id: 'stock_item:act',
      type: 'stock_item',
      name: 'Artemether-Lumefantrine',
      category: 'drug',
      quantityOnHand: 120.5,
      reorderLevel: 30,
    });
    await insertRecord(db.sql, 'stock_item', written);

    const read = await findRecord<StockItemRecord>(db.sql, 'stock_item', written.id);

    assert.equal(read?.quantityOnHand, 120.5);
    assert.equal(read?.reorderLevel, 30);
  });

  it('returns undefined for a record that does not exist', async () => {
    assert.equal(await findRecord(db.sql, 'patient', 'NOPE-000000-XX'), undefined);
  });
});
