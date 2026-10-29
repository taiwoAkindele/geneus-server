import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuthoritySnapshot, EncounterEntry, type SyncRejection, authoritySignaturePayload } from '#shared';
import { findRecord, fromRow, insertRecord, toRow } from '../src/db/records.ts';
import { applyGovernanceRecord, provisionWorkforceContact } from '../src/workforce/operations.ts';
import { workforcePayloadHash } from '../src/workforce/digests.ts';
import { addStaff, asDevice, lastCodeSentTo, registerScratchFacility, scratchDatabase, signer, type ScratchDatabase } from './postgres.ts';
import { put, setupWorkforce } from './workforceFixtures.ts';
const privateLogin = async (f: Awaited<ReturnType<typeof setupWorkforce>>, staffId = f.facility.admin.id, email = 'admin@example.org') => {
  const code = await f.app.inject({ method: 'POST', url: '/workforce/access/code', headers: asDevice(f.facility.device.credential), payload: { staffId } });
  assert.equal(code.statusCode, 202);
  const verified = await f.app.inject({ method: 'POST', url: '/workforce/access/verify', headers: asDevice(f.facility.device.credential), payload: { staffId, code: lastCodeSentTo(email) } });
  assert.equal(verified.statusCode, 200);
  return verified.json().token as string;
};
it('binds reviews to literal clinical content while normalizing envelope instants and object order', () => {
  const record = { createdOn: '2026-10-29T11:00:00+01:00', values: { note: '2026-10-29T11:00:00+01:00', symptom: 'Pain' } };
  const equivalent = { values: { symptom: 'Pain', note: record.values.note }, createdOn: '2026-10-29T10:00:00.000Z' };
  assert.equal(workforcePayloadHash(record), workforcePayloadHash(equivalent));
  assert.notEqual(workforcePayloadHash(record), workforcePayloadHash({ ...record, values: { ...record.values, note: '2026-10-29T10:00:00.000Z' } }));
});
describe('workforce evidence and clinical security', { timeout: 120000 }, () => {
  let db: ScratchDatabase;
  before(async () => { db = await scratchDatabase(); });
  after(async () => {
    if (db)
      await db.drop();
  });
  it('requires independent staff verification for evidence, binds access to the device and revokes it on logout', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const url = `/workforce/evidence?type=credential&staffId=${f.worker.id}`;
      const denied = await f.app.inject({ method: 'GET', url, headers: asDevice(f.facility.device.credential) });
      assert.equal(denied.statusCode, 403);
      const token = await privateLogin(f), headers = { ...asDevice(f.facility.device.credential), 'x-workforce-access': token };
      const evidence = await f.app.inject({ method: 'GET', url, headers });
      assert.equal(evidence.statusCode, 200);
      assert.equal(evidence.json().records[0].evidenceReference, 'synthetic:evidence');
      assert.equal(evidence.headers['cache-control'], 'no-store');
      const other = await registerScratchFacility(db.sql);
      const cross = await f.app.inject({ method: 'GET', url, headers: { ...asDevice(other.device.credential), 'x-workforce-access': token } });
      assert.equal(cross.statusCode, 403);
      await f.app.inject({ method: 'POST', url: '/workforce/access/end', headers });
      assert.equal((await f.app.inject({ method: 'GET', url, headers })).statusCode, 403);
    }
    finally {
      await f.app.close();
    }
  });
  it('lets the verified owner read their evidence without granting access to colleagues or their approvals', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const email = 'synthetic-worker@example.org';
      await provisionWorkforceContact(db.sql, { facilityId: f.facility.facility.id, deviceId: f.facility.device.deviceId, staffId: f.worker.id, email, operator: 'synthetic-operator', governanceReference: 'synthetic:verified-identity' });
      const token = await privateLogin(f, f.worker.id, email), headers = { ...asDevice(f.facility.device.credential), 'x-workforce-access': token };
      const own = await f.app.inject({ method: 'GET', url: '/workforce/evidence?type=credential', headers });
      assert.equal(own.json().records.length, 1);
      const other = await f.app.inject({ method: 'GET', url: `/workforce/evidence?type=credential&staffId=${f.facility.admin.id}`, headers });
      assert.equal(other.statusCode, 403);
      await db.sql`UPDATE workforce_private_sessions SET expires_on=now()-interval '1 second' WHERE staff_id=${f.worker.id}`;
      assert.equal((await f.app.inject({ method: 'GET', url: '/workforce/evidence?type=credential', headers })).statusCode, 403);
    }
    finally {
      await f.app.close();
    }
  });
  it('keeps an unapproved administrator from resetting an approved clinical account after cutover', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const admin = await addStaff(db.sql, f.facility, { role: 'facility_admin' });
      await f.enable();
      const denied = await f.app.inject({ method: 'POST', url: `/staff/${f.worker.id}/pin-codes`, headers: asDevice(f.facility.device.credential), payload: { issuedBy: admin.id } });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error, 'clinical_review_required');
      const allowed = await f.app.inject({ method: 'POST', url: `/staff/${f.worker.id}/pin-codes`, headers: asDevice(f.facility.device.credential), payload: { issuedBy: f.facility.admin.id } });
      assert.equal(allowed.statusCode, 201);
    }
    finally {
      await f.app.close();
    }
  });
  it('supports real external verification and refuses a verifier linked to the target person', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const external = { ...f.env, type: 'external_clinical_reviewer', id: `external:${randomUUID()}`, createdBy: 'system', externalSubjectReference: 'synthetic:external-person', displayName: 'Synthetic authorized verifier', governanceReference: 'synthetic:external-governance', authorizedBy: 'synthetic:operator', scopes: f.bootstrap.scopes, startsAt: f.bootstrap.startsAt, endsAt: f.bootstrap.endsAt, active: true, revision: 1 };
      await applyGovernanceRecord(db.sql, signer, external, 'synthetic-operator');
      const evidence = { ...f.credential, id: `credential:${randomUUID()}:v1`, credentialId: `credential:${randomUUID()}`, createdBy: 'system', checkedBy: 'system', externalReviewerId: external.id };
      assert.equal((await applyGovernanceRecord(db.sql, signer, evidence, 'synthetic-operator')).duplicate, false);
      const self = { ...external, id: `external:${randomUUID()}`, externalSubjectReference: 'synthetic:linked-local-person', linkedStaffId: f.worker.id };
      await applyGovernanceRecord(db.sql, signer, self, 'synthetic-operator');
      await assert.rejects(applyGovernanceRecord(db.sql, signer, { ...evidence, id: `credential:${randomUUID()}:v1`, credentialId: `credential:${randomUUID()}`, externalReviewerId: self.id }, 'synthetic-operator'), /independent/);
    }
    finally {
      await f.app.close();
    }
  });
  it('requires a payload-bound qualified supervisor acknowledgement and accepts the exact independently witnessed entry', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const worker = await addStaff(db.sql, f.facility, { role: 'nurse' }), uid = randomUUID();
      const profile = { ...f.env, type: 'practitioner_profile', id: `profile:${uid}`, staffId: worker.id, profession: { system: 'urn:synthetic', code: 'nurse', label: 'Synthetic nurse' }, specialties: [], active: true, revision: 1 };
      const credential = { ...f.credential, id: `credential:${uid}:v1`, credentialId: `credential:${uid}`, staffId: worker.id };
      const decision = { ...f.decision, id: `capability:${uid}:v1`, capabilityId: `capability:${uid}`, staffId: worker.id, credentialRevisionIds: [credential.id], scope: { kind: 'offerings', offeringIds: [f.offering.id], actions: ['assess'] }, supervisorId: f.worker.id, independentCheck: true };
      const prepared = await f.send([put(profile), put(credential, { expectedPreviousId: null }), put(decision, { expectedPreviousId: null })]);
      assert.equal(prepared.rejected.length, 0);
      const secondOffering = { ...f.offering, id: `offering:${uid}:other`, name: 'Other consultation service' };
      const broadWitness = { ...f.decision, id: `${f.decision.capabilityId}:v2`, version: 2, previousId: f.decision.id, scope: { kind: 'facility', actions: ['assess'] } };
      assert.equal((await f.send([put(secondOffering), put(broadWitness, { expectedPreviousId: f.decision.id })])).rejected.length, 0);
      await f.enable();
      const at = new Date().toISOString(), encounterId = `encounter:${randomUUID()}`;
      await insertRecord(db.sql, 'encounter', { ...f.env, id: encounterId, type: 'encounter', patientId: f.patientId, openedOn: at });
      const proofs = await db.sql`SELECT * FROM authority_snapshots WHERE facility_id=${f.facility.facility.id} AND is_current`;
      const performer = proofs.find((r) => r.staff_id === worker.id)!, witness = proofs.find((r) => r.staff_id === f.worker.id)!;
      const entry = EncounterEntry.parse({ ...f.env, id: `entry:${uid}`, type: 'encounter_entry', createdBy: worker.id, createdOn: at, encounterId, patientId: f.patientId, step: 'vitals', actorRole: 'nurse', values: { pulseBpm: 80 }, actorContext: { offeringId: f.offering.id, authoritySnapshotId: performer.id } });
      assert.ok((await f.send([put(entry)])).rejected.length);
      const acknowledgement = {
        ...f.env, id: `audit:${uid}`, type: 'audit_event', createdBy: f.worker.id, createdOn: at, actorStaffId: f.worker.id, occurredOn: at, action: 'update', entityType: 'encounter_entry', entityId: entry.id,
        metadata: { kind: 'workforce_attestation', recordId: entry.id, payloadHash: workforcePayloadHash(entry), offeringId: f.offering.id, action: 'assess', attestationKind: 'supervisor', authoritySnapshotId: witness.id }
      };
      const wrongService = { ...acknowledgement, id: `audit:${uid}:wrong-service`, metadata: { ...acknowledgement.metadata, offeringId: secondOffering.id } };
      const unrelated = await f.send([put(entry), put(wrongService)]);
      assert.equal(unrelated.applied, 1);
      assert.equal(unrelated.rejected[0]?.id, entry.id);
      const accepted = await f.send([put(entry), put(acknowledgement)]);
      assert.equal(accepted.rejected.length, 0, JSON.stringify(accepted.rejected));
      assert.equal(accepted.applied, 2);
    }
    finally {
      await f.app.close();
    }
  });
  it('does not let a restored current approval authorize care performed during a revocation gap', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      await f.enable();
      const [row] = await db.sql`SELECT * FROM authority_snapshots WHERE facility_id=${f.facility.facility.id} AND staff_id=${f.worker.id} AND is_current`;
      const current = fromRow<AuthoritySnapshot>('authority_snapshot', row), issued = new Date(f.now - 15 * 60000).toISOString();
      const prior = AuthoritySnapshot.parse({ ...current, id: `authority:prior:${randomUUID()}`, revision: current.revision + 100, createdOn: issued, issuedOn: issued, expiresOn: new Date(f.now + 3600000).toISOString() });
      prior.signature = signer.signBytes(Buffer.from(authoritySignaturePayload(prior))).toString('base64');
      await db.sql`INSERT INTO authority_snapshots ${db.sql({ ...toRow(db.sql, 'authority_snapshot', prior), is_current: false })}`;
      const revoked = { ...f.decision, id: `${f.decision.capabilityId}:v2`, version: 2, previousId: f.decision.id, decision: 'revoke', startsAt: new Date(f.now - 10 * 60000).toISOString() };
      const restored = { ...f.decision, id: `${f.decision.capabilityId}:v3`, version: 3, previousId: revoked.id, startsAt: new Date(f.now - 5 * 60000).toISOString() };
      const changed = await f.send([put(restored, { expectedPreviousId: revoked.id }), put(revoked, { expectedPreviousId: f.decision.id })]);
      assert.equal(changed.rejected.length, 0, JSON.stringify(changed.rejected));
      const [acceptedNow] = await db.sql`SELECT grants FROM authority_snapshots WHERE facility_id=${f.facility.facility.id} AND staff_id=${f.worker.id} AND is_current`;
      assert.ok(acceptedNow.grants.length);
      const performed = new Date(f.now - 7 * 60000).toISOString(), encounterId = `encounter:${randomUUID()}`;
      await insertRecord(db.sql, 'encounter', { ...f.env, id: encounterId, type: 'encounter', createdOn: performed, patientId: f.patientId, openedOn: performed });
      const entry = EncounterEntry.parse({ ...f.env, id: `entry:${randomUUID()}`, type: 'encounter_entry', createdBy: f.worker.id, createdOn: performed, encounterId, patientId: f.patientId, step: 'vitals', actorRole: 'nurse', values: { pulseBpm: 80 }, actorContext: { offeringId: f.offering.id, authoritySnapshotId: prior.id } });
      assert.equal((await f.send([put(entry)])).rejected[0]?.category, 'authorization');
      assert.equal(await findRecord(db.sql, 'encounter_entry', entry.id), undefined);
    }
    finally {
      await f.app.close();
    }
  });
  it('retains expired reported care for independent review, binds approval to its exact content and resubmits through the single write door', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      await f.enable();
      const [currentRow] = await db.sql`SELECT * FROM authority_snapshots WHERE facility_id=${f.facility.facility.id} AND staff_id=${f.worker.id} AND is_current`;
      const current = fromRow<AuthoritySnapshot>('authority_snapshot', currentRow), issued = new Date(f.now - 50 * 60000).toISOString(), performed = new Date(f.now - 30 * 60000).toISOString();
      // Synthetic immutable prior proof; current production proof remains untouched.
      const historical = AuthoritySnapshot.parse({ ...current, id: `authority:historical:${randomUUID()}`, revision: current.revision + 100, createdOn: issued, issuedOn: issued, expiresOn: new Date(f.now - 20 * 60000).toISOString() });
      historical.signature = signer.signBytes(Buffer.from(authoritySignaturePayload(historical))).toString('base64');
      const row = { ...toRow(db.sql, 'authority_snapshot', historical), is_current: false };
      await db.sql`INSERT INTO authority_snapshots ${db.sql(row)}`;
      const encounterId = `encounter:${randomUUID()}`;
      await insertRecord(db.sql, 'encounter', { ...f.env, id: encounterId, type: 'encounter', createdOn: performed, patientId: f.patientId, openedOn: performed });
      const entry = EncounterEntry.parse({ ...f.env, id: `entry:${randomUUID()}`, type: 'encounter_entry', createdBy: f.worker.id, createdOn: performed, encounterId, patientId: f.patientId, step: 'vitals', actorRole: 'nurse', values: { pulseBpm: 80 }, actorContext: { offeringId: f.offering.id, authoritySnapshotId: historical.id } });
      assert.ok((await f.send([put(entry)])).rejected.length);
      const [rejected] = await db.sql`SELECT id FROM sync_rejections WHERE entity_id=${entry.id}`;
      const token = await privateLogin(f), headers = { ...asDevice(f.facility.device.credential), 'x-workforce-access': token };
      const approval = await f.app.inject({ method: 'POST', url: `/workforce/rejections/${rejected.id}/review`, headers, payload: { reason: 'Independently reviewed synthetic timing and original clinical evidence' } });
      assert.equal(approval.statusCode, 201, approval.body);
      assert.ok((await f.send([put({ ...entry, values: { pulseBpm: 99 } })])).rejected.length);
      const accepted = await f.send([put(entry)]);
      assert.equal(accepted.applied, 1, JSON.stringify(accepted.rejected));
      const resolution = await findRecord<SyncRejection>(db.sql, 'sync_rejection', rejected.id as string);
      assert.equal(resolution?.resolvedBy, f.facility.admin.id);
      assert.equal((await findRecord(db.sql, 'encounter_entry', entry.id))?.createdBy, f.worker.id);
    }
    finally {
      await f.app.close();
    }
  });
  it('returns original per-device outcomes after a lost response and never reveals another device ledger',async()=>{
    const f=await setupWorkforce(db.sql);try{
      const valid=put({...f.unit,id:'unit:'+randomUUID(),unitId:'unit:'+randomUUID(),name:'Receipt test team'});
      const invalid=put({...f.credential,id:'credential:'+randomUUID(),credentialId:'credential:'+randomUUID(),staffId:f.facility.admin.id},{expectedPreviousId:null});
      const result=await f.send([valid,invalid]);assert.equal(result.applied,1);assert.equal(result.rejected.length,1);
      const replay=await f.send([valid,invalid]);assert.equal(replay.duplicates,2);
      const body={clientIds:[valid.clientId,invalid.clientId]},headers=asDevice(f.facility.device.credential);
      const receipt=await f.app.inject({method:'POST',url:'/sync/receipts',headers,payload:body});assert.equal(receipt.statusCode,200);assert.deepEqual(receipt.json(),{applied:[valid.clientId],rejected:[invalid.clientId]});assert.equal(receipt.headers['cache-control'],'no-store');
      const other=await registerScratchFacility(db.sql);const cross=await f.app.inject({method:'POST',url:'/sync/receipts',headers:asDevice(other.device.credential),payload:body});assert.deepEqual(cross.json(),{applied:[],rejected:[]});
    }finally{await f.app.close();}
  });
  it('keeps restricted refused evidence private when a verified manager records its review outcome',async()=>{
    const f=await setupWorkforce(db.sql);try{
      const invalid={...f.credential,id:'credential:'+randomUUID(),credentialId:'credential:'+randomUUID(),staffId:f.facility.admin.id};assert.equal((await f.send([put(invalid,{expectedPreviousId:null})])).rejected.length,1);
      const [row]=await db.sql`SELECT id FROM sync_rejections WHERE entity_id=${invalid.id}`;
      const url='/workforce/rejections/'+String(row.id)+'/resolve',payload={resolution:'Withdrawn after independent review; original evidence retained'};
      assert.equal((await f.app.inject({method:'POST',url,headers:asDevice(f.facility.device.credential),payload})).statusCode,403);
      const token=await privateLogin(f),headers={...asDevice(f.facility.device.credential),'x-workforce-access':token};
      assert.equal((await f.app.inject({method:'POST',url,headers,payload})).statusCode,204);
      assert.equal((await f.app.inject({method:'POST',url,headers,payload})).statusCode,204);
      assert.equal((await f.app.inject({method:'POST',url,headers,payload:{resolution:'Changed outcome'}})).statusCode,409);
      const saved=await findRecord<SyncRejection>(db.sql,'sync_rejection',String(row.id));assert.equal(saved?.visibility,'restricted');assert.equal(saved?.resolvedBy,f.facility.admin.id);assert.deepEqual(saved?.refusedRecord,invalid);
    }finally{await f.app.close();}
  });
  it('reviews a retained clinical draft before first upload without creating care through the private endpoint',async()=>{
    const f=await setupWorkforce(db.sql);try{
      await f.enable();const [currentRow]=await db.sql`SELECT * FROM authority_snapshots WHERE facility_id=${f.facility.facility.id} AND staff_id=${f.worker.id} AND is_current`;
      const current=fromRow<AuthoritySnapshot>('authority_snapshot',currentRow),issued=new Date(f.now-50*60000).toISOString(),performed=new Date(f.now-30*60000).toISOString();
      const historical=AuthoritySnapshot.parse({...current,id:'authority:historical:'+randomUUID(),revision:current.revision+100,createdOn:issued,issuedOn:issued,expiresOn:new Date(f.now-20*60000).toISOString()});historical.signature=signer.signBytes(Buffer.from(authoritySignaturePayload(historical))).toString('base64');
      await db.sql`INSERT INTO authority_snapshots ${db.sql({...toRow(db.sql,'authority_snapshot',historical),is_current:false})}`;
      const encounterId='encounter:'+randomUUID();await insertRecord(db.sql,'encounter',{...f.env,id:encounterId,type:'encounter',createdOn:performed,patientId:f.patientId,openedOn:performed});
      const record=EncounterEntry.parse({...f.env,id:'entry:'+randomUUID(),type:'encounter_entry',createdBy:f.worker.id,createdOn:performed,encounterId,patientId:f.patientId,step:'vitals',actorRole:'nurse',values:{pulseBpm:80},actorContext:{offeringId:f.offering.id,authoritySnapshotId:historical.id}});
      const token=await privateLogin(f),headers={...asDevice(f.facility.device.credential),'x-workforce-access':token};
      const response=await f.app.inject({method:'POST',url:'/workforce/clinical-drafts/review',headers,payload:{record,reason:'Independent review of retained original clinical report'}});assert.equal(response.statusCode,201,response.body);assert.equal(await findRecord(db.sql,'encounter_entry',record.id),undefined);
      assert.ok((await f.send([put({...record,values:{pulseBpm:90}})])).rejected.length);assert.equal((await f.send([put(record)])).applied,1);const accepted=await findRecord<EncounterEntry>(db.sql,'encounter_entry',record.id);assert.equal(accepted?.createdBy,f.worker.id);assert.equal(Date.parse(accepted!.createdOn),Date.parse(performed));
    }finally{await f.app.close();}
  });

});
