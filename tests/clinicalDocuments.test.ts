import { before,after,describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { LibraryDocument,VisitDocument,type DocumentFile,type FacilityRegistrationResult,type Staff,type UploadMutation } from '#shared';
import { insertRecord,findRecord } from '../src/db/records.ts';
import { addStaff,clientId,envelopeFor,registerScratchFacility,scratchDatabase,testApp,upload,type ScratchDatabase } from './postgres.ts';
describe('clinical documents and immutable file storage',()=>{
  let db:ScratchDatabase,app:FastifyInstance,facility:FacilityRegistrationResult,other:FacilityRegistrationResult,doctor:Staff,cashier:Staff,readonly:Staff,otherDoctor:Staff;
  let sequence=0;
  const bytes=(text='Synthetic hospital form')=>Buffer.from(`%PDF-1.4\n${text}\n%%EOF`);
  const descriptor=(id:string,body=bytes()):DocumentFile=>({id,fileName:'Form.pdf',mimeType:'application/pdf',byteSize:body.length,sha256:createHash('sha256').update(body).digest('hex')});
  const postFile=(file:DocumentFile,body=bytes(),actor=doctor,owner=facility)=>app.inject({method:'POST',url:`/documents/files/${encodeURIComponent(file.id)}`,headers:{authorization:`Bearer ${owner.device.credential}`,'x-actor-staff-id':actor.id,'content-type':'application/octet-stream','x-file-mime':file.mimeType,'x-file-sha256':file.sha256},payload:body});
  const getFile=(id:string,actor=doctor,owner=facility)=>app.inject({method:'GET',url:`/documents/files/${encodeURIComponent(id)}`,headers:{authorization:`Bearer ${owner.device.credential}`,'x-actor-staff-id':actor.id}});
  const put=(record:LibraryDocument|VisitDocument):UploadMutation=>({clientId:clientId(),op:'put',table:record.type,id:record.id,data:record});
  const send=(...mutations:UploadMutation[])=>upload(app,facility.device.credential,{transactionId:1,documentWorkflowVersion:1,inpatientWorkflowVersion:1,facilityContractVersion:1,schemaVersion:5,policyVersion:11,mutations});
  const env=()=>({...envelopeFor(facility),schemaVersion:5,createdBy:doctor.id,actorRole:doctor.role});
  const library=(file:DocumentFile,id=`library:${++sequence}`)=>LibraryDocument.parse({...env(),id,type:'library_document',documentId:id,version:1,title:'Hospital form',file,action:'upload',archived:false});
  const inpatient=async()=>{
    const suffix=String(++sequence).padStart(6,'0'),patientId=`${facility.facility.id}-${suffix}-K2`,encounterId=`visit:${suffix}`,requestId=`request:${suffix}`,admissionId=`stay:${suffix}`;
    await insertRecord(db.sql,'patient',{...env(),id:patientId,type:'patient',patientId,fullName:'Synthetic Document Patient',address:'Test road',sex:'female',ageYears:30});
    await insertRecord(db.sql,'encounter',{...env(),id:encounterId,type:'encounter',patientId,openedOn:new Date().toISOString()});
    await insertRecord(db.sql,'encounter_entry',{...env(),id:requestId,type:'encounter_entry',patientId,encounterId,step:'admission',values:{ward:'Ward'},actorRole:'doctor'});
    await insertRecord(db.sql,'inpatient_event',{...env(),id:admissionId,type:'inpatient_event',admissionId,patientId,encounterId,requestEntryId:requestId,action:'confirm',receivingUnitId:'unit:ward',actorRole:'doctor'});
    return {patientId,encounterId,admissionId,admissionEventId:admissionId};
  };
  before(async()=>{
    db=await scratchDatabase();app=testApp(db.sql);facility=await registerScratchFacility(db.sql);other=await registerScratchFacility(db.sql);
    doctor=await addStaff(db.sql,facility,{role:'doctor'});cashier=await addStaff(db.sql,facility,{role:'cashier'});readonly=await addStaff(db.sql,facility,{role:'nurse',permission:'read_only'});otherDoctor=await addStaff(db.sql,other,{role:'doctor'});
    await insertRecord(db.sql,'unit',{...envelopeFor(facility),id:'unit:ward',type:'unit',unitId:'WARD',name:'Ward team',active:true});
  });
  after(async()=>{if(app)await app.close();if(db)await db.drop();});
  it('stores and downloads exact bytes only within the enrolled hospital and current clinical access',async()=>{
    const file=descriptor('file:exact');assert.equal((await postFile(file)).statusCode,201);
    const record=library(file);assert.deepEqual((await send(put(record))).rejected,[]);
    const result=await getFile(file.id);assert.equal(result.statusCode,200);assert.deepEqual(result.rawPayload,bytes());assert.match(result.headers['content-type']!,/application\/pdf/);assert.equal(result.headers['cache-control'],'no-store');
    assert.equal((await getFile(file.id,cashier)).statusCode,403);
    assert.equal((await getFile(file.id,otherDoctor,other)).statusCode,404);
    assert.equal((await getFile(file.id,readonly)).statusCode,200);
    assert.equal((await postFile(descriptor('file:readonly'),bytes(),readonly)).statusCode,403);
  });
  it('requires device authentication and refuses disguised, corrupt and oversized files',async()=>{
    assert.equal((await app.inject({method:'GET',url:'/documents/files/unknown'})).statusCode,401);
    const html=Buffer.from('<html>not a PDF</html>');assert.equal((await postFile(descriptor('file:html',html),html)).statusCode,400);
    assert.equal((await postFile({...descriptor('file:bad-hash'),sha256:'b'.repeat(64)})).statusCode,400);
    const huge=Buffer.alloc(10*1024*1024+1);assert.equal((await postFile(descriptor('file:large',huge),huge)).statusCode,413);
    assert.equal((await postFile(descriptor('file:cashier'),bytes(),cashier)).statusCode,403);
  });
  it('is idempotent and never overwrites a stored file identity',async()=>{
    const file=descriptor('file:retry');assert.equal((await postFile(file)).statusCode,201);assert.equal((await postFile(file)).statusCode,200);
    const changed=bytes('A different file');assert.equal((await postFile(descriptor(file.id,changed),changed)).statusCode,409);
    assert.deepEqual((await getFile(file.id)).rawPayload,bytes());
    await assert.rejects(db.sql`UPDATE document_files SET content=${changed} WHERE facility_id=${facility.facility.id} AND id=${file.id}`,/never changed/);
  });
  it('preserves library originals and issued visit copies when replacing and archiving',async()=>{
    const a=descriptor('file:original'),b=descriptor('file:replacement',bytes('Replacement'));await postFile(a);await postFile(b,bytes('Replacement'));
    const original=library(a),stay=await inpatient(),id=`visit-document:${++sequence}`;
    assert.deepEqual((await send(put(original))).rejected,[]);
    const copy=VisitDocument.parse({...env(),...stay,id,type:'visit_document',documentId:id,version:1,title:original.title,file:a,templateVersionId:original.id,action:'attach',signatureStatus:'unsigned'});
    assert.deepEqual((await send(put(copy))).rejected,[]);
    const replacement=LibraryDocument.parse({...original,...env(),id:`library:${++sequence}`,previousId:original.id,version:2,action:'replace',file:b});assert.deepEqual((await send(put(replacement))).rejected,[]);
    const archive=LibraryDocument.parse({...replacement,...env(),id:`library:${++sequence}`,previousId:replacement.id,version:3,action:'archive',archived:true});assert.deepEqual((await send(put(archive))).rejected,[]);
    assert.equal((await findRecord<VisitDocument>(db.sql,'visit_document',copy.id))?.file.id,a.id);
    assert.equal((await findRecord<LibraryDocument>(db.sql,'library_document',original.id))?.file.id,a.id);
    assert.equal((await getFile(a.id)).statusCode,200);
    await assert.rejects(db.sql`DELETE FROM visit_documents WHERE id=${copy.id}`,/never changed/);
  });
  it('holds metadata whose binary is missing without losing its recovery payload',async()=>{
    const record=library(descriptor('file:missing'));const response=await send(put(record));assert.equal(response.rejected.length,1);
    const [rejected]=await db.sql`SELECT refused_record FROM sync_rejections WHERE entity_id=${record.id}`;assert.equal(rejected.refused_record.file.id,'file:missing');
    assert.equal(await findRecord(db.sql,'library_document',record.id),undefined);
  });
  it('requires inpatient visits and refuses changes after departure/cancellation',async()=>{
    const file=descriptor('file:inpatient');await postFile(file);const stay=await inpatient(),id=`visit-document:${++sequence}`;
    const record=VisitDocument.parse({...env(),...stay,id,type:'visit_document',documentId:id,version:1,title:'Patient form',file,action:'attach',signatureStatus:'unsigned'});
    assert.deepEqual((await send(put(record))).rejected,[]);
    const [admission]=await db.sql`SELECT * FROM inpatient_events WHERE id=${stay.admissionId}`;
    await insertRecord(db.sql,'inpatient_event',{...env(),id:`cancel:${++sequence}`,type:'inpatient_event',...stay,requestEntryId:admission.request_entry_id,previousId:stay.admissionId,action:'cancel',receivingUnitId:'unit:ward',actorRole:'doctor',note:'Synthetic withdrawal'});
    const update=VisitDocument.parse({...record,...env(),id:`visit-document:${++sequence}`,previousId:record.id,version:2,action:'status',signatureStatus:'awaiting_signed_copy'});
    assert.equal((await send(put(update))).rejected.length,1);
    const outpatient={...record,id:`visit-document:${++sequence}`,documentId:`invalid:${sequence}`,admissionId:'missing'};
    assert.equal((await send(put(outpatient))).rejected.length,1);
  });
  it('serializes concurrent library revisions instead of selecting one by device time',async()=>{
    const file=descriptor('file:revision');await postFile(file);const original=library(file);assert.deepEqual((await send(put(original))).rejected,[]);
    const revisions=['A','B'].map(title=>LibraryDocument.parse({...original,...env(),id:`library:${++sequence}`,previousId:original.id,version:2,action:'rename',title}));
    const outcomes=await Promise.all(revisions.map(record=>send(put(record))));assert.equal(outcomes.flatMap(result=>result.rejected).length,1);
  });
  it('requires explicit signature evidence and retains a signed copy and reviewer attribution',async()=>{
    const originalFile=descriptor('file:unsigned'),signedFile=descriptor('file:signed',bytes('Patient signed scan'));await postFile(originalFile);await postFile(signedFile,bytes('Patient signed scan'));
    const stay=await inpatient(),id=`visit-document:${++sequence}`;
    const original=VisitDocument.parse({...env(),...stay,id,type:'visit_document',documentId:id,version:1,title:'Consent',file:originalFile,action:'attach',signatureStatus:'unsigned'});assert.deepEqual((await send(put(original))).rejected,[]);
    const signed=VisitDocument.parse({...original,...env(),id:`visit-document:${++sequence}`,previousId:original.id,version:2,action:'signed_copy',file:signedFile,signatureStatus:'signed',signatureReview:{signerName:'Synthetic Guardian',signerKind:'representative',relationship:'Parent',authorityBasis:'Hospital representative checks recorded'}});
    assert.deepEqual((await send(put(signed))).rejected,[]);
    assert.equal((await findRecord<VisitDocument>(db.sql,'visit_document',original.id))?.signatureStatus,'unsigned');
    assert.equal((await findRecord<VisitDocument>(db.sql,'visit_document',signed.id))?.createdBy,doctor.id);
  });
  it('negotiates document support and CORS without publishing file contents into sync streams',async()=>{
    const result=await app.inject({method:'POST',url:'/sync/token',headers:{authorization:`Bearer ${facility.device.credential}`},payload:{documentWorkflowVersion:1,facilityContractVersion:1,schemaVersion:5,policyVersion:11}});
    assert.equal(result.statusCode,200);assert.equal(result.json().documentWorkflowVersion,1);assert.equal(JSON.parse(Buffer.from(result.json().token.split('.')[1],'base64url').toString()).document_workflow,1);
    const options=await app.inject({method:'OPTIONS',url:'/documents/files/file',headers:{origin:'http://localhost:5173','access-control-request-method':'POST','access-control-request-headers':'x-actor-staff-id,x-file-mime,x-file-sha256'}});assert.match(options.headers['access-control-allow-headers']!,/x-file-sha256/);
    const [publication]=await db.sql`SELECT count(*) AS n FROM pg_publication_tables WHERE pubname='powersync' AND tablename='document_files'`;assert.equal(Number(publication.n),0);
  });
});
