import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EncounterEntry, WardCareEvent, dispensingSummary, prescriptionLines, pharmacyChargeId } from '#shared';
import type { FastifyInstance } from 'fastify';
import { POLICY_VERSION, type FacilityRegistrationResult, type Staff, type UploadMutation, type InpatientEvent } from '#shared';
import { insertRecord } from '../src/db/records.ts';
import { addStaff, clientId, envelopeFor, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

describe('continuing inpatient care upload and PostgreSQL invariants', () => {
  let db: ScratchDatabase, app: FastifyInstance, facility: FacilityRegistrationResult, doctor: Staff, cashier: Staff, pharmacist: Staff;
  let sequence = 0;
  const put = (table: UploadMutation['table'], id: string, data: Record<string, unknown>, actor = doctor): UploadMutation => ({ clientId: clientId(), op: 'put', table, id, data: { ...envelopeFor(facility), createdBy: actor.id, id, type: table, ...data } });
  const send = (...mutations: UploadMutation[]) => upload(app, facility.device.credential, { pharmacyWorkflowVersion: 1, wardCareVersion: 1, inpatientWorkflowVersion: 1, clinicalWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: POLICY_VERSION, transactionId: 1, mutations });
  before(async () => {
    db = await scratchDatabase(); app = testApp(db.sql); facility = await registerScratchFacility(db.sql); doctor = await addStaff(db.sql, facility, { role: 'doctor' }); cashier = await addStaff(db.sql, facility, { role: 'cashier' });
    await insertRecord(db.sql, 'unit', { ...envelopeFor(facility), id: 'unit:ward', type: 'unit', unitId: 'WARD', name: 'Ward team' });
    await insertRecord(db.sql, 'location', { ...envelopeFor(facility), id: 'ward:one', type: 'location', name: 'Ward 1', kind: 'ward', active: true, revision: 1 });
  });
  after(async () => { if (app) await app.close(); if (db) await db.drop(); });
  const newStay = async () => {
    const n = ++sequence, patientId = `${facility.facility.id}-${String(n).padStart(6,'0')}-K2`, sourceId = `visit:source-${n}`, admissionId = `stay:${n}`, sessionId = `visit:review-${n}`, requestId = `request:${n}`;
    const base = { ...envelopeFor(facility), createdBy: doctor.id };
    await insertRecord(db.sql, 'patient', { ...base, id: patientId, type: 'patient', patientId, fullName: 'Synthetic inpatient', address: 'Synthetic road', sex: 'female', ageYears: 30 });
    await insertRecord(db.sql, 'encounter', { ...base, id: sourceId, type: 'encounter', patientId, openedOn: base.createdOn });
    await insertRecord(db.sql, 'encounter_entry', { ...base, id: requestId, type: 'encounter_entry', encounterId: sourceId, patientId, actorRole: 'doctor', step: 'admission', values: { ward: 'Ward 1', note: 'Recorded admission reason' } });
    const confirm: InpatientEvent = { ...base, schemaVersion: 5, type: 'inpatient_event', id: admissionId, admissionId, patientId, encounterId: sourceId, requestEntryId: requestId, action: 'confirm', receivingUnitId: 'unit:ward', actorRole: 'doctor' };
    await insertRecord(db.sql, 'inpatient_event', confirm);
    await insertRecord(db.sql, 'location', { ...base, id: `bed:${n}`, type: 'location', name: 'Bed ' + n, kind: 'bed', parentId: 'ward:one', active: true, revision: 1 });
    const reserved = { ...confirm, id: `${admissionId}:reserve`, previousId: admissionId, action: 'reserve' as const, wardId: 'ward:one', bedId: `bed:${n}` };
    await insertRecord(db.sql, 'inpatient_event', reserved);
    const arrived = { ...reserved, id: `${admissionId}:arrive`, previousId: reserved.id, action: 'arrive' as const };
    await insertRecord(db.sql, 'inpatient_event', arrived);
    const session = put('encounter', sessionId, { patientId, openedOn: new Date().toISOString(), workflowVersion: 1, inpatientContext: { admissionId, purpose: 'review' } });
    const entry = (id: string, step: string, values: Record<string, unknown>, actor = doctor) => put('encounter_entry', id, { patientId, encounterId: sessionId, admissionId, actorRole: actor.role, step, workflowVersion: 1, values }, actor);
    const event = (id: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}, actor = doctor) => put('ward_care_event', id, { patientId, encounterId: sessionId, admissionId, occurredOn: new Date().toISOString(), values, ...extra }, actor);
    const noteId = `note:${n}`, rxId = `rx:${n}`, orderId = `order:${n}`;
    return { n, base, confirm, arrived, patientId, sourceId, sessionId, requestId, admissionId, session, entry, event, noteId, rxId, orderId };
  };
  it('lets a pharmacist supply signed discharge medicines after departure without creating another visit', async () => {
    pharmacist = await addStaff(db.sql, facility, { role: 'pharmacy_staff' });
    const c = await newStay();
    c.session.data.inpatientContext = { admissionId: c.admissionId, purpose: 'discharge' };
    assert.deepEqual((await send(c.session)).rejected, []);
    const summaryMutation = c.event(`summary:pharmacy:${c.n}`, { kind: 'discharge', admissionReason: 'Recorded reason', diagnoses: 'Recorded diagnosis', course: 'Recorded care', instructions: 'Reviewed instructions', takeHome: [{ drug: 'Synthetic take-home medicine', dose: 'Recorded instructions', quantity: 20, unitOfMeasure: 'tablets' }], sourceEntryIds: [c.requestId], sourceWardEventIds: [], patientName: 'Synthetic inpatient', patientIdentifier: c.patientId, admittedOn: c.confirm.createdOn });
    assert.deepEqual((await send(summaryMutation, c.event(`complete:pharmacy:${c.n}`, { kind: 'complete' }))).rejected, []);
    const summary = WardCareEvent.parse(summaryMutation.data);
    assert.deepEqual((await send(put('inpatient_event', `${c.admissionId}:left`, { ...c.arrived, id: `${c.admissionId}:left`, previousId: c.arrived.id, action: 'discharge', departureException: 'Actual departure recorded' }))).rejected, []);
    const feeId = `fee:take-home:${c.n}`;
    await insertRecord(db.sql, 'fee_item', { ...c.base, id: feeId, type: 'fee_item', name: 'Synthetic take-home medicine', category: 'other', amountMinor: 100, currency: 'NGN', chargeWhen: 'when_ordered', active: true });
    const record = EncounterEntry.parse({ ...c.base, createdBy: pharmacist.id, createdOn: new Date().toISOString(), schemaVersion: 5, id: `supply:take-home:${c.n}`, type: 'encounter_entry', actorRole: 'pharmacy_staff', workflowVersion: 1, pharmacyVersion: 1, patientId: c.patientId, encounterId: c.sessionId, admissionId: c.admissionId, step: 'dispense', values: { lines: [{ drug: 'Synthetic take-home medicine', dispensed: false, reason: 'Pending' }], supply: { prescriptionEntryId: summary.id, lineId: prescriptionLines(summary)[0].lineId, action: 'supply', complete: false, quantity: 5, unit: 'tablets', source: 'untracked', billing: 'charge', feeItemId: feeId, unitPriceMinor: 100, currency: 'NGN', chargedMinor: 500 } } });
    record.values.lines = dispensingSummary(summary, [], record);
    assert.deepEqual((await send({ clientId: clientId(), op: 'put', table: 'encounter_entry', id: record.id, data: record })).rejected, []);
    const [charge] = await db.sql`SELECT amount_minor FROM charges WHERE id=${pharmacyChargeId(record.id)}`;
    assert.equal(Number(charge.amount_minor), 500);
    assert.equal((await db.sql`SELECT id FROM encounters WHERE patient_id=${c.patientId}`).length, 2);
  });
  const withOrder = async () => {
    const c = await newStay();
    const order = c.event(c.orderId, { kind: 'medication', orderId: c.orderId, action: 'start', sourceEntryId: c.rxId, lineId: 'line:one' });
    assert.deepEqual((await send(c.session, c.entry(c.noteId, 'complaint', { note: 'Ward assessment' }), c.entry(c.rxId, 'prescription', { decision: 'prescribed', prescription: [{ lineId: 'line:one', drug: 'Synthetic medicine', dose: 'Recorded dose', route: 'Oral' }] }), order)).rejected, []);
    return { ...c, order };
  };
  it('preserves the signed source and rejects wrong-patient, outpatient-disposition and cashier writes', async () => {
    const c = await newStay();
    assert.deepEqual((await send(c.session, c.entry(c.noteId, 'complaint', { note: 'Nursing note without repeated OPD vitals' }))).rejected, []);
    assert.equal((await send(c.entry('bad:ward-disposition', 'disposition', { kind: 'home_care', note: 'Incorrect session closure' }))).rejected.length, 1);
    assert.equal((await send(c.event('bad:cashier', { kind: 'complete' }, {}, cashier))).rejected.length, 1);
    const [row] = await db.sql`SELECT count(*)::int AS n FROM encounter_entries WHERE encounter_id=${c.sourceId}`; assert.equal(row.n, 1);
    await assert.rejects(insertRecord(db.sql, 'encounter', { ...c.base, type: 'encounter', id: 'bad:patient-context', patientId: `${facility.facility.id}-999999-K2`, openedOn: c.base.createdOn, inpatientContext: { admissionId: c.admissionId, purpose: 'review' } }), /foreign key|violates/i);
  });
  it('serializes competing order changes instead of choosing a device timestamp', async () => {
    const c = await withOrder();
    const change = (suffix: string) => c.event(c.orderId + suffix, { kind: 'medication', orderId: c.orderId, previousId: c.orderId, action: 'continue', sourceEntryId: c.rxId, lineId: 'line:one' });
    const outcomes = await Promise.all([send(change(':a')), send(change(':b'))]);
    assert.equal(outcomes.reduce((n, result) => n + result.rejected.length, 0), 1);
    await assert.rejects(db.sql`UPDATE ward_care_events SET late_reason='rewrite' WHERE id=${c.orderId}`, /never changed/);
  });
  it('deduplicates actual doses, preserves corrections and refuses administration after an order stops', async () => {
    const c = await withOrder(), at = new Date().toISOString();
    const first = c.event(`dose:${c.n}`, { kind: 'administration', orderEventId: c.orderId, dose: 'Actual dose', outcome: 'given' }, { occurredOn: at });
    assert.deepEqual((await send(first)).rejected, []); assert.deepEqual((await send(first)).rejected, []);
    assert.equal((await send(c.event(`dose:${c.n}:duplicate`, { kind: 'administration', orderEventId: c.orderId, dose: 'Actual dose', outcome: 'given' }, { occurredOn: at }))).rejected.length, 1);
    const correction = await send(c.event(`dose:${c.n}:correction`, { kind: 'administration', orderEventId: c.orderId, dose: 'Actual dose', outcome: 'not_given', reason: 'Reviewed correction', previousId: first.id }, { occurredOn: at }));
    assert.deepEqual(correction.rejected, []);
    const stop = await send(c.event(c.orderId + ':stop', { kind: 'medication', orderId: c.orderId, previousId: c.orderId, action: 'stop', sourceEntryId: c.rxId, lineId: 'line:one' }));
    assert.deepEqual(stop.rejected, []);
    const stoppedDose = await send(c.event(`dose:${c.n}:stopped`, { kind: 'administration', orderEventId: c.orderId, dose: 'Actual dose', outcome: 'given' }));
    assert.equal(stoppedDose.rejected.length, 1);
  });
  it('keeps completion distinct from departure and accepts a pending result after departure', async () => {
    const c = await newStay(), orderId = `test:${c.n}`;
    assert.deepEqual((await send(c.session, c.entry(c.noteId,'complaint',{note:'Ward review'}),c.entry(orderId,'lab_order',{tests:['Synthetic test'],items:[{id:`item:${c.n}`,name:'Synthetic test',custom:true,priority:'routine'}]}),c.event(`complete:${c.n}`,{kind:'complete'}))).rejected,[]);
    const ready = put('inpatient_event', `${c.admissionId}:ready`, { ...c.arrived, id: `${c.admissionId}:ready`, previousId: c.arrived.id, action: 'ready_for_discharge' });
    assert.equal((await send(ready)).rejected.length, 1);
    assert.deepEqual((await send(put('inpatient_event',`${c.admissionId}:departure`,{...c.arrived,id:`${c.admissionId}:departure`,previousId:c.arrived.id,action:'discharge',departureException:'Actual departure before paperwork'}))).rejected,[]);
    assert.deepEqual((await send(c.entry(`late-result:${c.n}`,'lab_results',{results:[{test:'Synthetic test',orderItemId:`item:${c.n}`,result:'Recorded finding'}]}))).rejected,[]);
    assert.equal((await send(c.entry(`late-note:${c.n}`,'complaint',{note:'Unreviewed late work'}))).rejected.length,1);
  });
  it('gates new clients and returns the negotiated ward capability', async () => {
    const response = await app.inject({ method:'POST',url:'/sync/token',headers:{authorization:`Bearer ${facility.device.credential}`},payload:{wardCareVersion:1,inpatientWorkflowVersion:1,clinicalWorkflowVersion:1,facilityContractVersion:1,schemaVersion:5,policyVersion:POLICY_VERSION} });
    assert.equal(response.statusCode,200); assert.equal(response.json().wardCareVersion,1);
    const payload=JSON.parse(Buffer.from(response.json().token.split('.')[1],'base64url').toString()); assert.equal(payload.ward_care,1);
    const c=await newStay();
    const unnegotiated=await app.inject({method:'POST',url:'/sync/upload',headers:{authorization:`Bearer ${facility.device.credential}`},payload:{transactionId:1,mutations:[c.session],inpatientWorkflowVersion:1,clinicalWorkflowVersion:1,facilityContractVersion:1,schemaVersion:5,policyVersion:POLICY_VERSION}});
    assert.equal(unnegotiated.statusCode,400);
  });
  it('reuses an admission prescription by reference without rewriting its original line', async () => {
    const c = await newStay(), sourceId = `rx:admission-${c.n}`, id = `order:admission-${c.n}`;
    await insertRecord(db.sql, 'encounter_entry', { ...c.base, id: sourceId, type: 'encounter_entry', encounterId: c.sourceId, patientId: c.patientId, actorRole: 'doctor', step: 'prescription', values: { decision: 'prescribed', prescription: [{ drug: 'Original medicine', dose: 'Original instructions' }] } });
    assert.deepEqual((await send(c.session, c.event(id, { kind: 'medication', orderId: id, action: 'start', sourceEntryId: sourceId, lineId: `${sourceId}:line:0`, note: 'Reviewed for ward use' }))).rejected, []);
    const [source] = await db.sql`SELECT "values" FROM encounter_entries WHERE id=${sourceId}`;
    assert.equal(source.values.prescription[0].lineId, undefined);
  });
});
