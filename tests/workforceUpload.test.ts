import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createPublicKey, verify } from 'node:crypto';
import { AuthoritySnapshot, EncounterEntry, authoritySignaturePayload, type UploadMutation } from '#shared';
import { fromRow, findRecord, insertRecord } from '../src/db/records.ts';
import { applyGovernanceRecord, setWorkforcePolicy } from '../src/workforce/operations.ts';
import { workforceReadiness } from '../src/workforce/readiness.ts';
import { asDevice, clientId, refusal, registerScratchFacility, scratchDatabase, signer, type ScratchDatabase } from './postgres.ts';
import { setupWorkforce, put } from './workforceFixtures.ts';
describe('facility and workforce upload', { timeout: 120000 }, () => {
  let db: ScratchDatabase;
  before(async () => { db = await scratchDatabase(); });
  after(async () => {
    if (db)
      await db.drop();
  });
  it('accepts child-before-parent batches, preserves distinct legacy aliases and independently signed minimal authority', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const location = await findRecord(db.sql, 'location', f.location.id);
      assert.equal(location?.type === 'location' && location.unitId, f.unit.id);
      const [row] = await db.sql`SELECT * FROM authority_snapshots WHERE facility_id=${f.facility.facility.id} AND staff_id=${f.worker.id} AND is_current`;
      const snapshot = fromRow<AuthoritySnapshot>('authority_snapshot', row);
      assert.equal(verify(null, Buffer.from(authoritySignaturePayload(snapshot)), createPublicKey({ key: Buffer.from(signer.publicKeyBase64, 'base64'), format: 'der', type: 'spki' }), Buffer.from(snapshot.signature, 'base64')), true);
      assert.equal(JSON.stringify(snapshot).includes('evidenceReference'), false);
      assert.equal(snapshot.grants.length, 1);
      const replay = await applyGovernanceRecord(db.sql, signer, f.bootstrap, 'synthetic-test-operator');
      assert.equal(replay.duplicate, true);
    }
    finally {
      await f.app.close();
    }
  });
  it('retains missing-parent payloads in durable linked reconciliation and exact retries deduplicate', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const mutation = put({ ...f.offering, id: `missing:${randomUUID()}`, serviceDefinitionId: 'definition:missing' });
      const first = await f.send([mutation]), second = await f.send([mutation]);
      assert.equal(first.rejected[0]?.category, 'dependency');
      assert.equal(second.duplicates, 1);
      const [row] = await db.sql`SELECT * FROM sync_rejections WHERE entity_id=${mutation.id}`;
      assert.equal(row.refused_record.serviceDefinitionId, 'definition:missing');
      assert.ok(row.dependencies.length);
      assert.equal(await findRecord(db.sql, 'service_offering', mutation.id), undefined);
    }
    finally {
      await f.app.close();
    }
  });
  it('serializes competing bookings without losing the rejected proposal', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const a = f.booking(), b = f.booking();
      const results = await Promise.all([f.send([put(a)]), f.send([put(b)])]);
      assert.equal(results.reduce((n, r) => n + r.applied, 0), 1);
      assert.equal(results.flatMap((r) => r.rejected).length, 1);
      const reservations = await db.sql`SELECT * FROM appointment_reservations WHERE facility_id=${f.facility.facility.id}`;
      assert.equal(reservations.length, 1);
      assert.equal(reservations[0].status, 'accepted');
      const refused = await db.sql`SELECT refused_record FROM sync_rejections WHERE facility_id=${f.facility.facility.id} AND entity_type='appointment'`;
      assert.equal(refused.length, 1);
      assert.ok(refused[0].refused_record.allocation);
    }
    finally {
      await f.app.close();
    }
  });
  it('rejects stale hierarchy CAS, cycle creation and retirement with unfinished dependencies', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const change: UploadMutation = { clientId: clientId(), op: 'patch', table: 'unit', id: f.unit.id, expectedRevision: 1, data: { name: 'Outpatient revised', schemaVersion: 4, revision: 2, updatedBy: f.facility.admin.id, updatedOn: new Date().toISOString() } };
      assert.equal((await f.send([change])).applied, 1);
      assert.equal((await f.send([{ ...change, clientId: clientId(), data: { ...change.data, name: 'Stale edit' } }])).rejected[0]?.category, 'conflict');
      const retire = { ...change, clientId: clientId(), expectedRevision: 2, data: { ...change.data, revision: 3, active: false } };
      assert.ok((await f.send([retire])).rejected.length);
      const cycle = await refusal(db.sql`UPDATE units SET parent_id=id,revision=3 WHERE id=${f.unit.id}`);
      assert.equal(cycle.code, '23514');
    }
    finally {
      await f.app.close();
    }
  });
  it('uses exact accepted heads for revisions and blocks broad administrator self-approval', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const v2 = { ...f.assignment, id: `assignment:v2:${randomUUID()}`, version: 2, previousId: f.assignment.id, reason: 'Synthetic duty review' };
      const results = await Promise.all([f.send([put(v2, { expectedPreviousId: f.assignment.id })]), f.send([put({ ...v2, id: `assignment:fork:${randomUUID()}` }, { expectedPreviousId: f.assignment.id })])]);
      assert.equal(results.reduce((n, r) => n + r.applied, 0), 1);
      assert.equal(results.flatMap((r) => r.rejected).length, 1);
      const self = put({ ...f.decision, id: `self:${randomUUID()}`, capabilityId: `self:${randomUUID()}`, staffId: f.facility.admin.id }, { expectedPreviousId: null });
      assert.ok((await f.send([self])).rejected.length);
      const [rejection] = await db.sql`SELECT visibility,visible_to_staff_ids FROM sync_rejections WHERE entity_id=${self.id}`;
      assert.equal(rejection.visibility, 'restricted');
      assert.ok(rejection.visible_to_staff_ids.length);
    }
    finally {
      await f.app.close();
    }
  });
  it('enforces clinical scopes after explicit ready cutover and preserves old-client outboxes with HTTP 409', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      await f.app.inject({method:'POST',url:'/sync/token',headers:asDevice(f.facility.device.credential),payload:{facilityContractVersion:1,schemaVersion:4,policyVersion:10,pendingMutationCount:0}});
      await db.sql.unsafe(`CREATE FUNCTION assert_upload_pending() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM workforce_client_versions WHERE device_id=NEW.device_id AND pending_mutation_count>0) THEN
          RAISE EXCEPTION 'Readiness must see pending upload before its first business write'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER check_upload_pending BEFORE INSERT ON locations FOR EACH ROW EXECUTE FUNCTION assert_upload_pending();`).simple();
      assert.equal((await f.send([put({...f.location,id:`location:${randomUUID()}`,name:'Additional consultation room'})])).applied,1);
      await db.sql.unsafe('DROP TRIGGER check_upload_pending ON locations; DROP FUNCTION assert_upload_pending();').simple();
      const command = await f.enable();
      await setWorkforcePolicy(db.sql, signer, command, Date.now() + 1000);
      const legacy = await f.app.inject({ method: 'POST', url: '/sync/upload', headers: asDevice(f.facility.device.credential), payload: { transactionId: clientId(), mutations: [put({ ...f.unit, id: `legacy:${randomUUID()}` })] } });
      assert.equal(legacy.statusCode, 400); // New privileged fields also fail request negotiation before a ledger claim.
      const plain = await f.app.inject({ method: 'POST', url: '/sync/upload', headers: asDevice(f.facility.device.credential), payload: { transactionId: null, mutations: [{ clientId: clientId(), op: 'put', table: 'encounter', id: 'legacy:visit', data: {} }] } });
      assert.equal(plain.statusCode, 409);
      const now = new Date().toISOString(), encounterId = `encounter:${randomUUID()}`;
      await insertRecord(db.sql, 'encounter', { ...f.env, createdBy: f.worker.id, createdOn: now, type: 'encounter', id: encounterId, patientId: f.patientId, openedOn: now });
      const [proof] = await db.sql`SELECT id FROM authority_snapshots WHERE facility_id=${f.facility.facility.id} AND staff_id=${f.worker.id} AND is_current`;
      const entry = EncounterEntry.parse({ ...f.env, createdBy: f.worker.id, createdOn: now, type: 'encounter_entry', id: `entry:${randomUUID()}`, encounterId, patientId: f.patientId, step: 'vitals', actorRole: 'nurse', actorContext: { offeringId: f.offering.id, authoritySnapshotId: proof.id }, values: { pulseBpm: 80 } });
      assert.equal((await f.send([put(entry)])).applied, 1);
      const unauthorized = { ...entry, id: `entry:${randomUUID()}`, createdBy: f.facility.admin.id, actorRole: 'facility_admin', actorContext: { offeringId: f.offering.id, authoritySnapshotId: proof.id } };
      assert.equal((await f.send([put(unauthorized)])).rejected[0]?.category, 'authorization');
      assert.equal((await workforceReadiness(db.sql, f.facility.facility.id)).ready, false); // Uploads conservatively mark the outbox un-drained until a zero-count handshake.
      await setWorkforcePolicy(db.sql, signer, { ...command, policy: { ...command.policy, revision: 2, mode: 'preparation' } });
      const reviews = await db.sql`SELECT revision FROM workforce_migration_reviews WHERE facility_id=${f.facility.facility.id} ORDER BY revision`;
      assert.deepEqual(reviews.map((r) => r.revision), [1, 2]);
      assert.equal((await refusal(db.sql`DELETE FROM workforce_migration_reviews WHERE facility_id=${f.facility.facility.id}`)).code, '42501');
    }
    finally {
      await f.app.close();
    }
  });
  it('makes cross-facility nested resources impossible even through direct SQL', async () => {
    const f = await setupWorkforce(db.sql), other = await registerScratchFacility(db.sql);
    try {
      const cross = await refusal(db.sql`UPDATE service_offerings SET location_ids=${db.sql.json(['foreign:location'])},revision=2 WHERE id=${f.offering.id}`);
      assert.equal(cross.code, '23503');
      const foreign = await refusal(db.sql`INSERT INTO practitioner_profiles(id,facility_id,schema_version,created_by,created_on,device_id,staff_id,profession,specialties,active,revision)
        VALUES('cross:profile',${f.facility.facility.id},4,${f.facility.admin.id},now(),${f.facility.device.deviceId},${other.admin.id},'{}','[]',true,1)`);
      assert.equal(foreign.code, '23503');
    }
    finally {
      await f.app.close();
    }
  });
});
