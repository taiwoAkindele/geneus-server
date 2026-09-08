import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type nano from 'nano';
import {
  databaseNameFor,
  facilityExists,
  provisionFacility,
  type SyncCredential,
} from '../src/couch/provision.ts';
import {
  deviceCouch,
  envelopeFor,
  removeCredential,
  removeFacility,
  requireCouch,
  scratchFacilityCode,
} from './helpers.ts';

/**
 * Per-facility isolation is the product's core privacy promise, and it rests
 * entirely on what provisioning sets up. These tests exercise the credential
 * the way a device would — over HTTP, not by inspecting the documents that
 * grant it.
 */
describe('facility provisioning', () => {
  const facilityCode = scratchFacilityCode();
  const neighbourCode = scratchFacilityCode();
  let couch: nano.ServerScope;
  let credential: SyncCredential;
  let neighbourCredential: SyncCredential;

  before(async () => {
    couch = await requireCouch();
    credential = await provisionFacility(couch, facilityCode);
    neighbourCredential = await provisionFacility(couch, neighbourCode);
  });

  after(async () => {
    await removeFacility(couch, facilityCode);
    await removeFacility(couch, neighbourCode);
    await removeCredential(couch, credential.username);
    await removeCredential(couch, neighbourCredential.username);
  });

  it('creates the facility database with a name derived from the code', async () => {
    assert.equal(credential.database, databaseNameFor(facilityCode));
    assert.ok(await facilityExists(couch, facilityCode));
  });

  it('reports an unregistered facility as absent', async () => {
    assert.equal(await facilityExists(couch, scratchFacilityCode()), false);
  });

  it('lets the credential replicate its own facility', async () => {
    const device = deviceCouch(credential.username, credential.password).use<Record<string, unknown>>(
      credential.database,
    );

    const written = await device.insert({
      ...envelopeFor(facilityCode),
      _id: 'staff:own-facility',
      type: 'staff',
      staffId: 'staff:own-facility',
    });

    assert.ok(written.ok);
  });

  it('refuses that same credential access to another facility', async () => {
    const device = deviceCouch(credential.username, credential.password).use(neighbourCredential.database);

    const outcome = await device
      .list()
      .then(() => undefined, (cause: { statusCode?: number }) => cause);

    assert.ok(outcome, 'expected the neighbouring facility to refuse this credential');
    assert.equal(outcome.statusCode, 403);
  });

  it('pushes the guard into the new database, so a bad write fails from the first day', async () => {
    const database = couch.use<Record<string, unknown>>(credential.database);

    const design = await database.get('_design/geneus');

    assert.ok('validate_doc_update' in design);
  });
});
