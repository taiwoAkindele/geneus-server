import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { POLICY_VERSION, type FacilityRegistrationResult, type InpatientEvent, type Staff, type UploadMutation } from '#shared';
import { insertRecord } from '../src/db/records.ts';
import { addStaff, clientId, envelopeFor, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

describe('inpatient upload and real PostgreSQL concurrency', () => {
  let db: ScratchDatabase, app: FastifyInstance, facility: FacilityRegistrationResult, doctor: Staff, cashier: Staff;
  let sequence=0;
  const put = (table: UploadMutation['table'], id: string, data: Record<string,unknown>, actor?: Staff): UploadMutation => ({ clientId:clientId(),op:'put',table,id,data:{...envelopeFor(facility),createdBy:(actor??doctor).id,id,type:table,...data} });
  const send = (...mutations: UploadMutation[]) => upload(app,facility.device.credential,{ transactionId:1,inpatientWorkflowVersion:1,facilityContractVersion:1,schemaVersion:5,policyVersion:POLICY_VERSION,mutations });
  const event = (record: InpatientEvent, actor?: Staff) => put('inpatient_event',record.id,record,actor);
  const next = (previous: InpatientEvent, action: InpatientEvent['action'], extra: Partial<InpatientEvent> = {}): InpatientEvent => ({...previous,...envelopeFor(facility),createdBy:doctor.id,id:`inpatient:${++sequence}`,previousId:previous.id,action,...extra});
  const newCase = async () => {
    const suffix=String(++sequence).padStart(6,'0'), patientId=`${facility.facility.id}-${suffix}-K2`, encounterId=`encounter:${suffix}`, requestEntryId=`request:${suffix}`, id=`stay:${suffix}`;
    assert.deepEqual((await send(
      put('patient',patientId,{patientId,fullName:'Synthetic inpatient',address:'Test road',sex:'female',ageYears:30}),
      put('encounter',encounterId,{patientId,openedOn:new Date().toISOString()}),
      put('encounter_entry',requestEntryId,{patientId,encounterId,step:'admission',actorRole:'doctor',values:{ward:'Ward A'}}),
    )).rejected,[]);
    const confirm: InpatientEvent={...envelopeFor(facility),schemaVersion:5,createdBy:doctor.id,id,type:'inpatient_event',admissionId:id,patientId,encounterId,requestEntryId,action:'confirm',receivingUnitId:'unit:ward',actorRole:'doctor'};
    return confirm;
  };
  const newBed = async () => {
    const id=`bed:${++sequence}`;
    await insertRecord(db.sql,'location',{...envelopeFor(facility),id,type:'location',kind:'bed',parentId:'ward:a',name:id,active:true,revision:1});
    return id;
  };
  before(async () => {
    db=await scratchDatabase(); app=testApp(db.sql); facility=await registerScratchFacility(db.sql);
    doctor=await addStaff(db.sql,facility,{role:'doctor'}); cashier=await addStaff(db.sql,facility,{role:'cashier'});
    await insertRecord(db.sql,'unit',{...envelopeFor(facility),id:'unit:ward',type:'unit',unitId:'WARD',name:'Ward team',active:true});
    await insertRecord(db.sql,'location',{...envelopeFor(facility),id:'ward:a',type:'location',kind:'ward',name:'Ward A',active:true,revision:1});
  });
  after(async () => { if(app)await app.close(); if(db)await db.drop(); });

  it('persists confirmation, reservation, arrival, readiness, departure and bed cleaning without changing signed visits', async () => {
    const confirm=await newCase(), bedId=await newBed(), reserve=next(confirm,'reserve',{wardId:'ward:a',bedId}),arrive=next(reserve,'arrive'),ready=next(arrive,'ready_for_discharge'),departure=next(ready,'discharge');
    assert.deepEqual((await send(...[confirm,reserve,arrive,ready,departure].map((record)=>event(record)))).rejected,[]);
    assert.deepEqual((await send(put('bed_ready_event','clean:complete',{bedId,releaseEventId:departure.id,actorRole:'doctor'}))).rejected,[]);
    const [counts]=await db.sql`SELECT (SELECT count(*) FROM inpatient_events WHERE admission_id=${confirm.id}) AS events, (SELECT count(*) FROM encounter_entries WHERE encounter_id=${confirm.encounterId}) AS entries`;
    assert.equal(Number(counts.events),5); assert.equal(Number(counts.entries),1);
    await assert.rejects(db.sql`UPDATE inpatient_events SET note='rewrite' WHERE id=${confirm.id}`,/never changed/);
    await assert.rejects(db.sql`DELETE FROM inpatient_events WHERE id=${confirm.id}`,/never changed/);
    await assert.rejects(db.sql`DELETE FROM bed_ready_events WHERE id='clean:complete'`,/never changed/);
  });
  it('serializes two simultaneous reservations of the same bed; the losing change remains recoverable', async () => {
    const a=await newCase(), b=await newCase(), bedId=await newBed();
    assert.deepEqual((await send(event(a),event(b))).rejected,[]);
    const reservations=[next(a,'reserve',{wardId:'ward:a',bedId}),next(b,'reserve',{wardId:'ward:a',bedId})];
    const results=await Promise.all(reservations.map((record)=>send(event(record))));
    assert.equal(results.flatMap((response)=>response.rejected).length,1);
    const [count]=await db.sql`SELECT count(*) AS n FROM inpatient_events WHERE bed_id=${bedId}`; assert.equal(Number(count.n),1);
    const [rejection]=await db.sql`SELECT refused_record FROM sync_rejections WHERE entity_id = ANY(${reservations.map((record)=>record.id)})`;
    assert.ok(rejection.refused_record.bedId);
  });
  it('rejects competing successors instead of selecting by the device clock', async () => {
    const confirm=await newCase(); assert.deepEqual((await send(event(confirm))).rejected,[]);
    const a=next(confirm,'reserve',{wardId:'ward:a',bedId:await newBed()}), b=next(confirm,'cancel',{note:'Withdrawn'});
    const results=await Promise.all([send(event(a)),send(event(b))]); assert.equal(results.flatMap((response)=>response.rejected).length,1);
  });
  it('keeps ready-for-discharge beds occupied and vacated beds unavailable until cleaned', async () => {
    const a=await newCase(),b=await newCase(),bedId=await newBed(),reserve=next(a,'reserve',{wardId:'ward:a',bedId}),arrive=next(reserve,'arrive'),ready=next(arrive,'ready_for_discharge');
    assert.deepEqual((await send(...[a,b,reserve,arrive,ready].map((record)=>event(record)))).rejected,[]);
    assert.equal((await send(event(next(b,'reserve',{wardId:'ward:a',bedId})))).rejected.length,1);
    const departure=next(ready,'discharge'); assert.deepEqual((await send(event(departure))).rejected,[]);
    assert.equal((await send(event(next(b,'reserve',{wardId:'ward:a',bedId})))).rejected.length,1);
    assert.deepEqual((await send(put('bed_ready_event',`clean:${bedId}`,{bedId,releaseEventId:departure.id,actorRole:'doctor'}))).rejected,[]);
    assert.deepEqual((await send(event(next(b,'reserve',{wardId:'ward:a',bedId})))).rejected,[]);
  });
  it('refuses cashiers, false role attribution, wrong visit/patient links and invalid arrival', async () => {
    const confirm=await newCase();
    const cashierEvent={...confirm,createdBy:cashier.id,actorRole:cashier.role};
    assert.equal((await send(event(cashierEvent))).rejected[0]?.category,'authorization');
    assert.equal((await send(event({...confirm,actorRole:'nurse'}))).rejected[0]?.category,'authorization');
    assert.equal((await send(event({...confirm,encounterId:'missing'}))).rejected.length,1);
    assert.deepEqual((await send(event(confirm))).rejected,[]);
    assert.equal((await send(event(next(confirm,'arrive',{wardId:'ward:a',bedId:await newBed()})))).rejected.length,1);
  });
  it('gates new uploads and download claims while preserving older client token requests', async () => {
    const confirm=await newCase();
    const refused=await app.inject({method:'POST',url:'/sync/upload',headers:{authorization:`Bearer ${facility.device.credential}`},payload:{transactionId:1,mutations:[event(confirm)]}});
    assert.equal(refused.statusCode,400);
    const old=await app.inject({method:'POST',url:'/sync/token',headers:{authorization:`Bearer ${facility.device.credential}`},payload:{}}); assert.equal(old.statusCode,200);
    assert.equal(JSON.parse(Buffer.from(old.json().token.split('.')[1],'base64url').toString()).inpatient_workflow,undefined);
    const modern=await app.inject({method:'POST',url:'/sync/token',headers:{authorization:`Bearer ${facility.device.credential}`},payload:{inpatientWorkflowVersion:1,facilityContractVersion:1,schemaVersion:5,policyVersion:11}});
    assert.equal(modern.statusCode,200); assert.equal(modern.json().inpatientWorkflowVersion,1);
    assert.equal(JSON.parse(Buffer.from(modern.json().token.split('.')[1],'base64url').toString()).inpatient_workflow,1);
  });
  it('rejects a second active admission across server-confirmed linked patient IDs', async () => {
    const a=await newCase(),b=await newCase();
    await insertRecord(db.sql,'patient_identity_event',{...envelopeFor(facility),id:`identity:${++sequence}`,type:'patient_identity_event',patientId:a.patientId,otherPatientId:b.patientId,outcome:'linked',reason:'Synthetic same-person confirmation'});
    assert.deepEqual((await send(event(a))).rejected,[]);
    const response=await send(event(b)); assert.equal(response.rejected.length,1); assert.match(response.rejected[0].reason,/already has an active admission/);
  });
  it('transfers occupancy, protects occupied and unclean locations, and allows retirement after cleaning', async () => {
    const confirm=await newCase(),a=await newBed(),b=await newBed(),reserve=next(confirm,'reserve',{wardId:'ward:a',bedId:a}),arrive=next(reserve,'arrive'),transfer=next(arrive,'transfer',{bedId:b,note:'Synthetic completed move'});
    assert.deepEqual((await send(...[confirm,reserve,arrive,transfer].map((record)=>event(record)))).rejected,[]);
    const retire=():UploadMutation=>({clientId:clientId(),op:'patch',table:'location',id:a,expectedRevision:1,data:{active:false,revision:2,updatedBy:facility.admin.id,updatedOn:new Date().toISOString()}});
    assert.equal((await send(retire())).rejected.length,1);
    assert.equal((await send(put('bed_ready_event',`wrong-clean:${++sequence}`,{bedId:b,releaseEventId:transfer.id,actorRole:'doctor'}))).rejected.length,1);
    assert.deepEqual((await send(put('bed_ready_event',`clean-transfer:${++sequence}`,{bedId:a,releaseEventId:transfer.id,actorRole:'doctor'}))).rejected,[]);
    assert.deepEqual((await send(retire())).rejected,[]);
    const other=await newCase();assert.deepEqual((await send(event(other))).rejected,[]);
    assert.equal((await send(event(next(other,'reserve',{wardId:'ward:a',bedId:b})))).rejected.length,1);
  });
  it('supports an explicit admission duty grant through the migrated staff permission constraint', async () => {
    const coordinator=await addStaff(db.sql,facility,{role:'records_officer',additionalPermissions:['admission:manage']});
    const confirm=await newCase();
    assert.deepEqual((await send(event({...confirm,createdBy:coordinator.id,actorRole:coordinator.role}))).rejected,[]);
  });
});
