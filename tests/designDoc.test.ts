import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type nano from 'nano';
import { buildDesignDoc } from '../src/couch/designDoc.ts';
import { databaseNameFor } from '../src/couch/provision.ts';
import { envelopeFor, rejectionReason, removeFacility, requireCouch, scratchFacilityCode } from './helpers.ts';

/**
 * The generated guard is the only thing standing between a leaked device
 * credential and a cross-facility write, so it is tested through CouchDB rather
 * than by calling the function: what matters is what the database enforces.
 *
 * Documents here are built by hand instead of through the Zod contract, because
 * these tests deliberately write shapes the contract would refuse.
 */
describe('validate_doc_update', () => {
  const facilityCode = scratchFacilityCode();
  let couch: nano.ServerScope;
  let database: nano.DocumentScope<Record<string, unknown>>;

  before(async () => {
    couch = await requireCouch();
    await couch.db.create(databaseNameFor(facilityCode));
    database = couch.use(databaseNameFor(facilityCode));
    await database.insert(buildDesignDoc(facilityCode) as never);
  });

  after(async () => {
    await removeFacility(couch, facilityCode);
  });

  it('accepts a well-formed document for this facility', async () => {
    const response = await database.insert({
      ...envelopeFor(facilityCode),
      _id: 'staff:accepted',
      type: 'staff',
      staffId: 'staff:accepted',
    });

    assert.ok(response.ok);
  });

  it('rejects a type that is not in the contract', async () => {
    const reason = await rejectionReason(
      database.insert({ ...envelopeFor(facilityCode), _id: 'unknown-type', type: 'prescription' }),
    );

    assert.match(reason, /unknown document type/);
  });

  it('rejects a document belonging to another facility', async () => {
    const reason = await rejectionReason(
      database.insert({ ...envelopeFor('SOME-OTHER-PHC'), _id: 'wrong-facility', type: 'staff' }),
    );

    assert.match(reason, /belongs to another facility/);
  });

  it('rejects a document missing any envelope field', async () => {
    for (const field of ['createdBy', 'createdOn', 'deviceId', 'schemaVersion']) {
      const envelope: Record<string, unknown> = { ...envelopeFor(facilityCode) };
      delete envelope[field];

      const reason = await rejectionReason(
        database.insert({ ...envelope, _id: `missing-${field}`, type: 'staff' }),
      );

      assert.match(reason, new RegExp(`missing required field: ${field}`));
    }
  });

  it('rejects a change to an identity key that must never move', async () => {
    const patient = {
      ...envelopeFor(facilityCode),
      _id: 'OOE-PHC-000001-K2',
      type: 'patient',
      patientId: 'OOE-PHC-000001-K2',
    };
    const created = await database.insert(patient);

    const reason = await rejectionReason(
      database.insert({ ...patient, _rev: created.rev, patientId: 'OOE-PHC-000002-K3' }),
    );

    assert.match(reason, /cannot change patientId/);
  });

  /**
   * Clinical history is retired by flag, never destroyed — so a delete can only
   * be a mistake or an attacker holding a device credential.
   */
  it('rejects deletion outright', async () => {
    const created = await database.insert({
      ...envelopeFor(facilityCode),
      _id: 'staff:undeletable',
      type: 'staff',
      staffId: 'staff:undeletable',
    });

    const reason = await rejectionReason(database.destroy('staff:undeletable', created.rev));

    assert.match(reason, /documents cannot be deleted/);
  });
});
