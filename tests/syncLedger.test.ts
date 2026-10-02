import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Patient, type FacilityRegistrationResult, type SyncRejection } from '#shared';
import { findRecord, insertRecord } from '../src/db/records.ts';
import { claimMutation, recordRejection, wasApplied } from '../src/sync/ledger.ts';
import { envelopeFor, registerScratchFacility, scratchDatabase, type ScratchDatabase } from './postgres.ts';

/**
 * The ledger is what makes a retried upload harmless. The shape of the test is
 * the shape of the upload handler: claim the mutation and apply the write in
 * one transaction, and see what a second attempt does.
 */
describe('sync ledger', () => {
  let db: ScratchDatabase;
  let facility: FacilityRegistrationResult;

  const patient = (sequence: string) =>
    Patient.parse({
      ...envelopeFor(facility),
      id: `TEST-LEDGER-${sequence}-K2`,
      type: 'patient',
      patientId: `TEST-LEDGER-${sequence}-K2`,
      fullName: 'Amaka Okoro',
      address: 'Odo-Ona',
      sex: 'female',
      ageYears: 32,
    });

  /** What the upload handler does per mutation: claim, then write, atomically. */
  const applyOnce = (clientId: number, sequence: string) =>
    db.sql.begin(async (tx) => {
      const identity = { deviceId: facility.device.deviceId, clientId, transactionId: 1 };
      if (!(await claimMutation(tx, identity, 'patient', `TEST-LEDGER-${sequence}-K2`, 'applied'))) return 'duplicate';
      await insertRecord(tx, 'patient', patient(sequence));
      return 'applied';
    });

  before(async () => {
    db = await scratchDatabase();
    facility = await registerScratchFacility(db.sql);
  });

  after(async () => {
    await db.drop();
  });

  it('applies a mutation once and acknowledges every retry without writing again', async () => {
    const outcomes = [await applyOnce(1, '000001'), await applyOnce(1, '000001'), await applyOnce(1, '000001')];

    assert.deepEqual(outcomes, ['applied', 'duplicate', 'duplicate']);
    const rows = await db.sql`SELECT id FROM patients WHERE id = 'TEST-LEDGER-000001-K2'`;
    assert.equal(rows.length, 1);
    assert.equal(await wasApplied(db.sql, { deviceId: facility.device.deviceId, clientId: 1 }), true);
  });

  it('forgets the claim when the write it guarded rolls back, so the retry is a first attempt', async () => {
    await db.sql
      .begin(async (tx) => {
        await claimMutation(tx, { deviceId: facility.device.deviceId, clientId: 2, transactionId: 1 }, 'patient', 'x', 'applied');
        throw new Error('the write failed');
      })
      .catch(() => undefined);

    assert.equal(await wasApplied(db.sql, { deviceId: facility.device.deviceId, clientId: 2 }), false);
    assert.equal(await applyOnce(2, '000002'), 'applied');
  });

  it('keeps ledgers per device, so two devices may both use client id 1', async () => {
    const other = await registerScratchFacility(db.sql);

    const claimed = await db.sql.begin((tx) =>
      claimMutation(tx, { deviceId: other.device.deviceId, clientId: 1, transactionId: null }, 'patient', 'y', 'rejected'),
    );

    assert.equal(claimed, true);
  });

  it('files a rejection the facility can read back, with both sides of a conflict', async () => {
    const rejection = await recordRejection(db.sql, {
      facilityId: facility.facility.id,
      deviceId: facility.device.deviceId,
      entityType: 'patient',
      entityId: 'TEST-LEDGER-000001-K2',
      operation: 'patch',
      category: 'conflict',
      reason: 'phone changed on two devices',
      attributedTo: facility.admin.id,
      occurredOn: '2026-09-12T09:30:00Z',
      conflicts: [{ column: 'phone', deviceValue: '0801', serverValue: '0802' }],
    });

    const stored = await findRecord<SyncRejection>(db.sql, 'sync_rejection', rejection.id);

    assert.equal(stored?.category, 'conflict');
    assert.deepEqual(stored?.conflicts, [{ column: 'phone', deviceValue: '0801', serverValue: '0802' }]);
    assert.equal(stored?.resolvedOn, undefined);
    assert.equal(stored?.createdBy, 'system');
  });
});
