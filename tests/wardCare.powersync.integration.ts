/** Explicit local-stack check; not part of node --test's *.test.ts suite.
 * Uses only geneus_test_* databases and its own temporary PowerSync container.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { buildApp } from '../src/app.ts';
import { buildSyncConfig } from '../src/sync/syncConfig.ts';
import { writeFile } from 'node:fs/promises';
import { insertRecord } from '../src/db/records.ts';
import { POLICY_VERSION, UploadResponse, EncounterEntry, dispensingSummary, pharmacyChargeId, pharmacyMovementId, type UploadMutation } from '#shared';
import { pharmacyRecords } from '../src/clinical/pharmacy.ts';
import { config, signer, registerScratchFacility, scratchDatabase, envelopeFor, clientId } from './postgres.ts';
import { readFirstCheckpoint, waitForRow } from './powersyncClient.ts';

const exec = promisify(execFile);
test('two enrolled devices receive accepted ward care, legacy tokens exclude it, and a synthetic backup restores', { timeout: 180000 }, async (t) => {
  assert.equal(new URL(config.postgresUrl).hostname, '127.0.0.1', 'Use the local disposable PostgreSQL test service');
  const source = await scratchDatabase(), storage = await scratchDatabase(), restored = await scratchDatabase();
  const name = 'geneus-ward-sync-' + randomBytes(5).toString('hex'), dumpPath = '/tmp/' + name + '.dump';
  const sourceName = new URL(source.url).pathname.slice(1), restoredName = new URL(restored.url).pathname.slice(1);
  assert.ok([sourceName,restoredName].every((value) => /^geneus_test_[a-f0-9]+$/.test(value)));
  const endpoint = 'http://127.0.0.1:18090';
  const app = buildApp({ sql: source.sql, config: { ...config, powerSyncPublicUrl: endpoint, powerSyncInternalUrl: endpoint }, signer, mailer: { configured: false, send: async () => {} } }, { logger: false, rateLimit: false });
  let started = false, completed = false;
  t.after(async () => {
    if (started && !completed) {
      const logs = await exec('docker', ['logs','--tail','200',name], { windowsHide: true }).catch(() => ({ stdout: '', stderr: '' }));
      t.diagnostic((logs.stdout + logs.stderr).replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[scratch database]'));
    }
    if (started) await exec('docker', ['rm','-f',name], { windowsHide: true }).catch(() => {});
    if (/^\/tmp\/geneus-ward-sync-[a-f0-9]+\.dump$/.test(dumpPath)) await exec('docker', ['exec','geneus-postgres','rm','-f',dumpPath], { windowsHide: true }).catch(() => {});
    await app.close(); await source.drop(); await storage.drop(); await restored.drop();
  });
  await app.listen({ port: 18080, host: '0.0.0.0' });
  await writeFile(resolve('powersync/sync-config.yaml'), buildSyncConfig());
  const inside = (url: string) => { const value = new URL(url); value.hostname = 'host.docker.internal'; return value.toString(); };
  await exec('docker', ['run','--detach','--name',name,'--publish','127.0.0.1:18090:8080','--add-host','host.docker.internal:host-gateway',
    '--mount',`type=bind,source=${resolve('powersync')},target=/config,readonly`,
    '--env','POWERSYNC_CONFIG_PATH=/config/service.yaml','--env',`PS_SOURCE_URI=${inside(source.url)}`,'--env',`PS_STORAGE_URI=${inside(storage.url)}`,
    '--env','PS_SSLMODE=disable','--env','PS_JWKS_URI=http://host.docker.internal:18080/.well-known/jwks.json','--env','PS_JWT_AUDIENCE=powersync','--env','PS_PORT=8080',
    'journeyapps/powersync-service:1.26.0','start','-r','unified'], { windowsHide: true, timeout: 30000 }); started = true;
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    healthy = await fetch(endpoint + '/probes/readiness').then((r) => r.ok, () => false);
    if (healthy) break;
    await new Promise((done) => setTimeout(done,500));
  }
  assert.ok(healthy, 'The isolated PowerSync service must be ready');
  const a = await registerScratchFacility(source.sql), outsider = await registerScratchFacility(source.sql);
  const secondId = 'device-ward-' + randomBytes(5).toString('hex');
  const code = await app.inject({ method:'POST',url:'/devices/codes',headers:{authorization:`Bearer ${a.device.credential}`},payload:{issuedBy:a.admin.id} }); assert.equal(code.statusCode,201);
  const enrollment = await app.inject({method:'POST',url:'/devices',payload:{code:code.json().code,deviceId:secondId,deviceLabel:'Synthetic receiving device'}}); assert.equal(enrollment.statusCode,201);
  const second = enrollment.json() as { credential: string; deviceId: string };
  const versions = {pharmacyWorkflowVersion:1,wardCareVersion:1,inpatientWorkflowVersion:1,clinicalWorkflowVersion:1,facilityContractVersion:1,schemaVersion:5,policyVersion:POLICY_VERSION};
  const token = async (credential: string, modern = true) => {
    const response=await app.inject({method:'POST',url:'/sync/token',headers:{authorization:`Bearer ${credential}`},payload:modern?versions:{}}); assert.equal(response.statusCode,200); return response.json().token as string;
  };
  const put = (table: UploadMutation['table'], id: string, data: Record<string,unknown>, deviceId=a.device.deviceId): UploadMutation => ({clientId:clientId(),op:'put',table,id,data:{...envelopeFor(a),deviceId,id,type:table,...data}});
  const upload = async (credential: string, mutations: UploadMutation[]) => {
    const response=await fetch('http://127.0.0.1:18080/sync/upload',{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify({...versions,transactionId:1,mutations})});
    const body=UploadResponse.parse(await response.json()); assert.equal(response.status,200); assert.deepEqual(body.rejected,[]); return body;
  };
  const base=envelopeFor(a), patientId=`${a.facility.id}-000001-K2`, sourceId='visit:ward-source', requestId='entry:ward-request', admissionId='stay:ward-stack';
  await insertRecord(source.sql,'patient',{...base,id:patientId,type:'patient',patientId,fullName:'Synthetic ward patient',address:'Synthetic address',sex:'female',ageYears:30});
  await insertRecord(source.sql,'encounter',{...base,id:sourceId,type:'encounter',patientId,openedOn:base.createdOn});
  await insertRecord(source.sql,'encounter_entry',{...base,id:requestId,type:'encounter_entry',patientId,encounterId:sourceId,actorRole:'facility_admin',step:'admission',values:{ward:'Ward',note:'Synthetic request'}});
  await insertRecord(source.sql,'unit',{...base,id:'unit:ward',type:'unit',unitId:'WARD',name:'Ward'});
  await insertRecord(source.sql,'inpatient_event',{...base,id:admissionId,type:'inpatient_event',admissionId,patientId,encounterId:sourceId,requestEntryId:requestId,receivingUnitId:'unit:ward',action:'confirm',actorRole:'facility_admin'});
  const tokenB=await token(second.credential), legacy=await token(second.credential,false), external=await token(outsider.device.credential);
  const sessionId='visit:ward-first', noteId='entry:ward-first';
  const queue=[put('encounter',sessionId,{patientId,openedOn:new Date().toISOString(),workflowVersion:1,inpatientContext:{admissionId,purpose:'nursing'}}),put('encounter_entry',noteId,{patientId,encounterId:sessionId,admissionId,actorRole:'facility_admin',workflowVersion:1,step:'complaint',values:{note:'Recorded while disconnected; sent after reconnect'}})];
  // Router readiness precedes the first replication snapshot on a fresh service.
  let before = await readFirstCheckpoint(endpoint,tokenB);
  for (let i = 0; before.status >= 500 && i < 40; i++) {
    await new Promise((done) => setTimeout(done,500));
    before = await readFirstCheckpoint(endpoint,tokenB);
  }
  assert.equal(before.status,200); assert.equal(before.rows.some((r)=>r.id===noteId),false);
  const sent=await upload(a.device.credential,queue); assert.equal(sent.applied,2);
  const received=await waitForRow(endpoint,tokenB,(r)=>r.table==='encounter_entries'&&r.id===noteId); assert.ok(received.found,'The second enrolled device receives accepted ward care');
  const retried=await upload(a.device.credential,queue); assert.equal(retried.duplicates,2);
  const legacyRows=await readFirstCheckpoint(endpoint,legacy); assert.equal(legacyRows.rows.some((r)=>r.id===sessionId||r.id===noteId),false);
  const otherRows=await readFirstCheckpoint(endpoint,external); assert.equal(otherRows.rows.some((r)=>r.id===noteId),false);
  const bSession='visit:ward-second', bNote='entry:ward-second';
  await upload(second.credential,[put('encounter',bSession,{patientId,openedOn:new Date().toISOString(),workflowVersion:1,inpatientContext:{admissionId,purpose:'nursing'}},second.deviceId),put('encounter_entry',bNote,{patientId,encounterId:bSession,admissionId,actorRole:'facility_admin',workflowVersion:1,step:'complaint',values:{note:'Second worker device continues the same stay'}},second.deviceId)]);
  const receivedA=await waitForRow(endpoint,await token(a.device.credential),(r)=>r.id===bNote); assert.ok(receivedA.found,'Ward care returns to the first device');
  const eventId='ward:stack-complete';
  await upload(a.device.credential,[put('ward_care_event',eventId,{patientId,encounterId:sessionId,admissionId,occurredOn:new Date().toISOString(),values:{kind:'complete'}})]);
  assert.ok((await waitForRow(endpoint,tokenB,(r)=>r.table==='ward_care_events'&&r.id===eventId)).found,'New ward events cross the negotiated stream');
  // A quantity-based supply and its atomic companions must reach the other device together.
  await insertRecord(source.sql,'fee_item',{...base,id:'fee:stack-medicine',type:'fee_item',name:'Synthetic medicine',category:'other',amountMinor:100,currency:'NGN',chargeWhen:'when_ordered',active:true,exemptions:[]});
  await insertRecord(source.sql,'stock_item',{...base,id:'stock:stack-medicine',type:'stock_item',name:'Synthetic medicine',category:'drug',unitOfMeasure:'tablets',quantityOnHand:100});
  const prescription=EncounterEntry.parse({...base,id:'rx:stack-medicine',type:'encounter_entry',patientId,encounterId:sourceId,workflowVersion:1,actorRole:'facility_admin',step:'prescription',values:{decision:'prescribed',prescription:[{lineId:'line:stack-medicine',drug:'Synthetic medicine',dose:'Recorded instructions',quantity:20,unitOfMeasure:'tablets'}]}});
  await insertRecord(source.sql,'encounter_entry',prescription);
  const supply=EncounterEntry.parse({...base,id:'supply:stack-medicine',type:'encounter_entry',patientId,encounterId:sourceId,workflowVersion:1,pharmacyVersion:1,actorRole:'facility_admin',step:'dispense',values:{supply:{prescriptionEntryId:prescription.id,lineId:'line:stack-medicine',action:'supply',complete:false,quantity:5,unit:'tablets',source:'stock',stockItemId:'stock:stack-medicine',billing:'charge',feeItemId:'fee:stack-medicine',unitPriceMinor:100,currency:'NGN',chargedMinor:500},lines:[{drug:'Synthetic medicine',dispensed:false,reason:'Pending'}]}});
  const pharmacyData=await pharmacyRecords(source.sql as never,prescription);
  supply.values.lines=dispensingSummary(prescription,pharmacyData.entries,supply);
  const supplyMutation=put('encounter_entry',supply.id,supply);
  await upload(a.device.credential,[supplyMutation]);
  assert.ok((await waitForRow(endpoint,tokenB,(r)=>r.table==='encounter_entries'&&r.id===supply.id)).found,'The receiving device receives quantity-based dispensing');
  assert.ok((await waitForRow(endpoint,tokenB,(r)=>r.table==='charges'&&r.id===pharmacyChargeId(supply.id))).found,'The receiving device receives its exact quantity-based bill');
  assert.ok((await waitForRow(endpoint,tokenB,(r)=>r.table==='stock_movements'&&r.id===pharmacyMovementId(supply.id))).found,'The receiving device receives its one stock deduction');
  assert.equal((await upload(a.device.credential,[supplyMutation])).duplicates,1);
  assert.equal((await readFirstCheckpoint(endpoint,legacy)).rows.some((r)=>r.id===supply.id),false,'Legacy clients must not interpret partial supply as fully dispensed');
  assert.equal((await readFirstCheckpoint(endpoint,external)).rows.some((r)=>r.id===supply.id||r.id===pharmacyChargeId(supply.id)),false,'Pharmacy remains facility isolated');
  const tables=await source.sql<{tablename:string}[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const counts=async(sql: typeof source.sql)=>Object.fromEntries(await Promise.all(tables.map(async({tablename})=>{const [r]=await sql`SELECT count(*)::int AS n FROM ${sql(tablename)}`;return[tablename,r.n];})));
  await exec('docker',['exec','-e','PGPASSWORD=devpassword','geneus-postgres','pg_dump','-U','geneus','-d',sourceName,'-Fc','-f',dumpPath],{windowsHide:true,timeout:30000});
  await exec('docker',['exec','-e','PGPASSWORD=devpassword','geneus-postgres','pg_restore','-U','geneus','-d',restoredName,'--clean','--if-exists','--no-owner','--no-privileges',dumpPath],{windowsHide:true,timeout:30000});
  assert.deepEqual(await counts(restored.sql),await counts(source.sql),'Every source table restores with the same row count');
  const [restoredNote]=await restored.sql`SELECT "values" FROM encounter_entries WHERE id=${noteId}`;
  assert.equal(restoredNote.values.note,'Recorded while disconnected; sent after reconnect');
  completed = true;
});
