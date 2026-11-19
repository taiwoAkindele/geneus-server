import {after,before,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EncounterEntry,ServiceChargeAllocation,type CoverageAllocation,type Charge} from '#shared';
import {insertRecord,findRecord} from '../src/db/records.ts';
import {buildPatientStatement} from '../src/billing/patientStatements.ts';
import {confirmAllocations} from '../src/insurance/allocations.ts';
import {seedInsuredStatement} from './integratedInsuranceFixture.ts';
import {addStaff,asDevice,clientId,envelopeFor,registerScratchFacility,scratchDatabase,staffSessionFor,testApp,upload} from './postgres.ts';

describe('verified insured returns reuse the original insurance rules without rewriting history',()=>{
 let db:Awaited<ReturnType<typeof scratchDatabase>>,f:Awaited<ReturnType<typeof registerScratchFacility>>,app:ReturnType<typeof testApp>,patientId:string,proof:string,officerProof:string;
 let originalAllocation:CoverageAllocation,originalCharge:Charge,originalDetails:Record<string,unknown>;
 const versions={integratedBillingVersion:1,billingCatalogueVersion:1,clinicalWorkflowVersion:1,pharmacyWorkflowVersion:1,facilityContractVersion:1,schemaVersion:7,policyVersion:17} as const;
 const headers=()=>({...asDevice(f.device.credential),'x-staff-session':proof,'x-billing-catalogue-version':'1','x-integrated-billing-version':'1'});
 const input=(quantity=1,returnEntryId='insured:return:one')=>({patientId,chargeId:'charge:integrated-insured',sourceKind:'pharmacy',sourceEntryId:'insured:supply',sourceItemId:'insured:supply',action:'release',quantity,unit:'tablets',reason:'Verified actual returned units against the original insured purchase',reversesId:'insured:association',returnEntryId,creditReturnedUnits:true});
 const post=(requestId:string,quantity=1,returnEntryId='insured:return:one')=>app.inject({method:'POST',url:'/billing/associations/insurance-return',headers:headers(),payload:{requestId,input:input(quantity,returnEntryId)}});
 const snapshot=()=>db.sql.begin(tx=>buildPatientStatement(tx as never,f.facility.id,patientId,'NGN',new Date().toISOString()));
 before(async()=>{
  db=await scratchDatabase();f=await registerScratchFacility(db.sql);app=testApp(db.sql);patientId=f.facility.id+'-000003-K2';await seedInsuredStatement(db.sql,f,patientId,f.admin.id,{pharmacy:true});
  await db.sql`UPDATE facilities SET billing_catalogue_version=1,integrated_billing_version=1 WHERE id=${f.facility.id}`;
  await db.sql`INSERT INTO insurance_billing_periods(id,facility_id,starts_on,ends_on,opened_by,closed_by) VALUES('period:historical',${f.facility.id},'2020-01-01',now(),${f.admin.id},${f.admin.id})`;
  const pharmacist=await addStaff(db.sql,f,{role:'pharmacy_staff'}),officer=await addStaff(db.sql,f,{role:'insurance_officer'}),base={...envelopeFor(f),schemaVersion:7};
  proof=(await staffSessionFor(app,f.device.credential,f.admin.id))!;officerProof=(await staffSessionFor(app,f.device.credential,officer.id))!;
  // Signing in as the officer ends the admin session on a shared device. Re-prove the actor per online action below.
  proof=(await staffSessionFor(app,f.device.credential,f.admin.id))!;
  await insertRecord(db.sql,'encounter',{...base,id:'insured:visit',type:'encounter',patientId,openedOn:base.createdOn});
  await insertRecord(db.sql,'encounter_entry',{...base,id:'insured:supply',type:'encounter_entry',createdBy:pharmacist.id,patientId,encounterId:'insured:visit',actorRole:'pharmacy_staff',step:'dispense',workflowVersion:1,pharmacyVersion:1,values:{lines:[{drug:'Synthetic insured medicine',dispensed:true}],supply:{prescriptionEntryId:'historical:rx',lineId:'historical:line',action:'supply',complete:true,quantity:3,unit:'tablets',source:'untracked',billing:'unpriced',reason:'Imported signed historical supply'}}});
  const a=ServiceChargeAllocation.parse({...base,id:'insured:association',type:'service_charge_allocation',patientId,chargeId:'charge:integrated-insured',sourceKind:'pharmacy',sourceEntryId:'insured:supply',sourceItemId:'insured:supply',action:'allocate',quantity:3,unit:'tablets',reason:'Reviewed exact historic purchase and actual supply'});
  const accepted=await upload(app,f.device.credential,{...versions,transactionId:null,mutations:[{clientId:clientId(),op:'put',table:a.type,id:a.id,data:a}]});assert.deepEqual(accepted.rejected,[]);
  await insertRecord(db.sql,'encounter_entry',{...base,id:'insured:return:one',type:'encounter_entry',createdBy:pharmacist.id,patientId,encounterId:'insured:visit',actorRole:'pharmacy_staff',step:'dispense',workflowVersion:1,pharmacyVersion:1,values:{lines:[{drug:'Synthetic insured medicine',dispensed:false,reason:'Pending'}],supply:{prescriptionEntryId:'historical:rx',lineId:'historical:line',previousEntryId:'insured:supply',action:'return',returnOf:'insured:supply',complete:false,quantity:1,unit:'tablets',restock:false,creditMinor:0,reason:'Patient returned one unit'}}});
  originalAllocation=(await findRecord<CoverageAllocation>(db.sql,'coverage_allocation','allocation:integrated-insured'))!;originalCharge=(await findRecord<Charge>(db.sql,'charge','charge:integrated-insured'))!;originalDetails=(await db.sql`SELECT * FROM coverage_allocation_details WHERE allocation_id=${originalAllocation.id}`)[0];
 });
 after(async()=>{await app?.close();await db?.drop();});
 it('requires verified insurance authority; an offline upload cannot alter a confirmed split',async()=>{
  const denied=await app.inject({method:'POST',url:'/billing/associations/insurance-return',headers:{...asDevice(f.device.credential),'x-actor-staff-id':f.admin.id},payload:{requestId:randomUUID(),input:input()}});assert.equal(denied.statusCode,403);
  const a=ServiceChargeAllocation.parse({...envelopeFor(f),schemaVersion:7,id:'insured:offline-credit',type:'service_charge_allocation',...input()});const result=await upload(app,f.device.credential,{...versions,transactionId:null,mutations:[{clientId:clientId(),op:'put',table:a.type,id:a.id,data:a}]});assert.equal(result.rejected.length,1);assert.ok(await findRecord(db.sql,'encounter_entry','insured:return:one'));assert.equal((await db.sql`SELECT id FROM coverage_allocations`).length,1);
 });
 it('appends one recalculated decision for two remaining units, with distinct return and contractual adjustments',async()=>{
  const requestId=randomUUID(),response=await post(requestId);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().record.creditMinor,40000);assert.equal(response.json().claimReviewRequired,true);const replay=await post(requestId);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().replayed,true,replay.body);
  const s=await snapshot();assert.equal(s.totals.originalMinor,1350000);assert.equal(s.totals.returnAdjustmentMinor,450000);assert.equal(s.totals.contractAdjustmentMinor,100000);assert.equal(s.totals.netMinor,800000);assert.equal(s.totals.patientMinor,80000);assert.equal(s.totals.payerMinor,720000);assert.equal(s.totals.patientCreditMinor,40000);assert.equal(s.totals.payerReceivedMinor,400000);assert.equal(s.totals.payerOutstandingMinor,320000);
  assert.deepEqual(await findRecord(db.sql,'charge',originalCharge.id),originalCharge);assert.deepEqual(await findRecord(db.sql,'coverage_allocation',originalAllocation.id),originalAllocation);assert.deepEqual((await db.sql`SELECT * FROM coverage_allocation_details WHERE allocation_id=${originalAllocation.id}`)[0],originalDetails);assert.equal((await db.sql`SELECT id FROM billing_adjustments`).length,0,'the new share is not reduced twice');
  const retry=await post(requestId,2);assert.equal(retry.statusCode,409);assert.equal((await post(randomUUID())).statusCode,409,'same returned quantity cannot be credited twice');
 });
 it('keeps ordinary reconfirmation from restoring quantities that were already credited and reuses claim revision',async()=>{
  const result=await db.sql.begin(tx=>confirmAllocations(tx as never,{facilityId:f.facility.id,deviceId:f.device.deviceId,staffId:f.admin.id,requestKey:randomUUID(),chargeIds:[originalCharge.id],basis:'exception',decision:'apply_cover',reason:'Do not restore returned quantity'}));assert.equal(result[0].outcome,'skipped');
  const revised=await app.inject({method:'POST',url:'/insurance/claims/claim:integrated/revise',headers:headers(),payload:{reason:'Returned unit approved; revise the remaining services',requestKey:randomUUID()}});assert.equal(revised.statusCode,200,revised.body);assert.equal(revised.json().lines,1);const s=await snapshot();assert.equal(s.claims[0].settlement.expectedMinor,720000);assert.equal(s.claims[0].settlement.paidMinor,400000);
 });
 it('fully credits remaining returned units without inventing payer refunds or rewriting earlier remittances',async()=>{
  const pharmacist=(await db.sql`SELECT id FROM staff WHERE facility_id=${f.facility.id} AND role='pharmacy_staff'`)[0];const base={...envelopeFor(f),schemaVersion:7};
  await insertRecord(db.sql,'encounter_entry',EncounterEntry.parse({...base,id:'insured:return:rest',type:'encounter_entry',createdBy:pharmacist.id,patientId,encounterId:'insured:visit',actorRole:'pharmacy_staff',step:'dispense',workflowVersion:1,pharmacyVersion:1,values:{lines:[{drug:'Synthetic insured medicine',dispensed:false,reason:'Pending'}],supply:{prescriptionEntryId:'historical:rx',lineId:'historical:line',previousEntryId:'insured:return:one',action:'return',returnOf:'insured:supply',complete:false,quantity:2,unit:'tablets',restock:false,creditMinor:0,reason:'Remaining units returned'}}}));
  const officer=(await db.sql`SELECT id FROM staff WHERE facility_id=${f.facility.id} AND role='insurance_officer'`)[0];officerProof=(await staffSessionFor(app,f.device.credential,officer.id))!;
  const response=await app.inject({method:'POST',url:'/billing/associations/insurance-return',headers:{...headers(),'x-staff-session':officerProof},payload:{requestId:randomUUID(),input:input(2,'insured:return:rest')}});assert.equal(response.statusCode,200,response.body);
  const s=await snapshot();assert.equal(s.totals.returnAdjustmentMinor,1350000);assert.equal(s.totals.netMinor,0);assert.equal(s.totals.payerMinor,0);assert.equal(s.totals.patientMinor,0);assert.equal(s.totals.payerCreditMinor,400000);assert.equal(s.totals.payerReceivedMinor,400000);assert.equal((await db.sql`SELECT id FROM insurance_remittances`).length,1);assert.equal((await db.sql`SELECT remittance_id FROM insurance_remittance_reversals`).length,0);
 });
});
