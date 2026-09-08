import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type nano from 'nano';
import {
  databaseNameFor,
  provisionFacility,
  syncDesignDocs,
  type SyncCredential,
} from '../src/couch/provision.ts';
import { buildDesignDoc } from '../src/couch/designDoc.ts';
import {
  envelopeFor,
  removeCredential,
  removeFacility,
  requireCouch,
  scratchFacilityCode,
} from './helpers.ts';

const DESIGN_ID = '_design/geneus';

/** What an out-of-date guard looks like: it lets through what the current one refuses. */
const PERMISSIVE_GUARD = 'function (newDoc, oldDoc) { return; }';

/**
 * The guard is written once, at provisioning, so a contract change would
 * otherwise reach only facilities registered after it. These tests are about
 * the consequence rather than the mechanism: after a sync, an out-of-date
 * database enforces the same rules as a new one.
 */
describe('syncDesignDocs', () => {
  const facilityCode = scratchFacilityCode();
  const orphanDatabase = `facility-orphan-${Date.now()}`;
  let couch: nano.ServerScope;
  let credential: SyncCredential;
  let database: nano.DocumentScope<Record<string, unknown>>;

  const outcomeFor = async (name: string): Promise<string | undefined> =>
    (await syncDesignDocs(couch)).find((result) => result.database === name)?.outcome;

  const writeAnotherFacilitysDocument = (id: string) =>
    database.insert({ ...envelopeFor('SOME-OTHER-PHC'), _id: id, type: 'staff' });

  const replaceGuard = async (validate_doc_update: string): Promise<void> => {
    const current = await database.get(DESIGN_ID);
    await database.insert({ _id: DESIGN_ID, _rev: current._rev, validate_doc_update } as never);
  };

  before(async () => {
    couch = await requireCouch();
    credential = await provisionFacility(couch, facilityCode);
    database = couch.use<Record<string, unknown>>(databaseNameFor(facilityCode));
    // Registration writes this document; provisioning alone does not, and it is
    // what tells the sync which facility a database belongs to.
    await database.insert({
      ...envelopeFor(facilityCode),
      _id: facilityCode,
      type: 'facility',
      code: facilityCode,
    });
  });

  after(async () => {
    await removeFacility(couch, facilityCode);
    await couch.db.destroy(orphanDatabase).catch(() => undefined);
    await removeCredential(couch, credential.username);
  });

  it('leaves a database that already has the current guard untouched', async () => {
    assert.equal(await outcomeFor(credential.database), 'unchanged');
  });

  it('replaces an out-of-date guard, and the restored rules bite immediately', async () => {
    await replaceGuard(PERMISSIVE_GUARD);
    const admittedWhileStale = await writeAnotherFacilitysDocument('stale-guard-let-this-in');
    assert.ok(admittedWhileStale.ok, 'expected the stale guard to admit a cross-facility write');

    assert.equal(await outcomeFor(credential.database), 'updated');

    const refused = await writeAnotherFacilitysDocument('current-guard-refuses-this').then(
      () => undefined,
      (cause: { statusCode?: number }) => cause,
    );
    assert.equal(refused?.statusCode, 403);
  });

  it('restores a guard that has been removed entirely', async () => {
    const current = await database.get(DESIGN_ID);
    await database.destroy(DESIGN_ID, current._rev);

    assert.equal(await outcomeFor(credential.database), 'created');

    const restored = await database.get(DESIGN_ID);
    assert.equal(restored.validate_doc_update, buildDesignDoc(facilityCode).validate_doc_update);
  });

  it('is idempotent, so a deploy can run it every time', async () => {
    await syncDesignDocs(couch);

    assert.equal(await outcomeFor(credential.database), 'unchanged');
  });

  /**
   * Guessing an id here would be worse than skipping: the guard embeds it, and a
   * wrong value would reject every write the facility makes.
   */
  it('reports a facility database it cannot identify rather than guessing', async () => {
    await couch.db.create(orphanDatabase);

    assert.equal(await outcomeFor(orphanDatabase), 'unresolved');
    assert.equal(await couch.use(orphanDatabase).get(DESIGN_ID).catch(() => undefined), undefined);
  });

  it('ignores databases that are not facilities', async () => {
    const results = await syncDesignDocs(couch);

    assert.equal(results.some((result) => result.database === '_users'), false);
    assert.equal(results.some((result) => result.database === 'geneus-invites'), false);
  });
});
