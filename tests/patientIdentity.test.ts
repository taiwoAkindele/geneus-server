import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { canonicalPatientId, type FacilityRegistrationResult, type Patient, type Staff } from '#shared';
import { findRecord, insertRecord } from '../src/db/records.ts';
import { eventsForFacility } from '../src/patients/identity.ts';
import { addStaff, clientId, envelopeFor, registerScratchFacility, scratchDatabase, testApp, upload, refusal, type ScratchDatabase } from './postgres.ts';

describe('patient registration corrections and identity resolution', () => {
  let db: ScratchDatabase, app: FastifyInstance, facility: FacilityRegistrationResult, other: FacilityRegistrationResult;
  let records: Staff, nurse: Staff;
  const id = (n: number) => `${facility.facility.id}-${String(n).padStart(6, '0')}-K2`;
  const post = (path: string, body: Record<string, unknown>, credential = facility.device.credential) => app.inject({ method: 'POST', url: `/patients/identity/${path}`, headers: { authorization: `Bearer ${credential}` }, payload: body });
  const action = (a: number, b: number, outcome = 'linked') => ({ patientId: id(a), otherPatientId: id(b), outcome, actorStaffId: records.id });
  before(async () => {
    db = await scratchDatabase(); app = testApp(db.sql);
    facility = await registerScratchFacility(db.sql); other = await registerScratchFacility(db.sql);
    records = await addStaff(db.sql, facility, { role: 'records_officer' }); nurse = await addStaff(db.sql, facility, { role: 'nurse' });
    for (let n = 1; n <= 10; n++) await insertRecord(db.sql, 'patient', { ...envelopeFor(facility), createdBy: records.id, id: id(n), patientId: id(n), type: 'patient', fullName: 'Identity Test Patient', address: 'Test address', sex: 'female', ageYears: 30, phone: '08035550147', nin: '12345678901' });
    await insertRecord(db.sql, 'encounter', { ...envelopeFor(facility), id: 'encounter:alias-history', patientId: id(2), type: 'encounter', openedOn: new Date().toISOString() });
  });
  after(async () => { if (app) await app.close(); if (db) await db.drop(); });

  it('clears optional values through upload and accepts a null previous value', async () => {
    const update = async (data: Record<string, unknown>, previous: Record<string, unknown>) => upload(app, facility.device.credential, { transactionId: 1, mutations: [{ clientId: clientId(), op: 'patch', table: 'patient', id: id(1), data: { ...data, updatedBy: records.id, updatedOn: new Date().toISOString() }, previous }] });
    assert.equal((await update({ phone: null, nin: null }, { phone: '08035550147', nin: '12345678901' })).rejected.length, 0);
    const patient = await findRecord<Patient>(db.sql, 'patient', id(1)); assert.equal(patient?.phone, undefined); assert.equal(patient?.nin, undefined);
    assert.equal((await update({ phone: '08035550148' }, { phone: null })).rejected.length, 0);
    const conflict = await update({ phone: null }, { phone: 'outdated-phone' });
    assert.equal(conflict.rejected[0].category, 'conflict');
    assert.equal((await findRecord<Patient>(db.sql, 'patient', id(1)))?.phone, '08035550148');
  });

  it('accepts offline review requests but refuses forged confirmations and revisions', async () => {
    const event = { ...envelopeFor(facility), createdBy: records.id, patientId: id(1), otherPatientId: id(2), outcome: 'review_requested', reason: 'Same details registered on two offline devices' };
    const send = (data: object) => upload(app, facility.device.credential, { transactionId: 1, mutations: [{ clientId: clientId(), op: 'put', table: 'patient_identity_event', id: `identity:${randomUUID()}`, data: { ...event, ...data } }] });
    assert.equal((await send({})).rejected.length, 0);
    assert.equal((await send({ outcome: 'linked' })).rejected[0].category, 'authorization');
    assert.equal((await send({ revision: 9999 })).rejected[0].category, 'validation');
    assert.equal(canonicalPatientId(id(2), await eventsForFacility(db.sql, facility.facility.id)), id(2));
  });

  it('requires the records permission and enforces the device facility boundary', async () => {
    assert.equal((await post('preview', { ...action(1, 2), actorStaffId: nurse.id })).statusCode, 403);
    assert.equal((await post('preview', action(1, 2), other.device.credential)).statusCode, 403);
    const foreign = `${other.facility.id}-000001-K2`;
    await insertRecord(db.sql, 'patient', { ...envelopeFor(other), id: foreign, patientId: foreign, type: 'patient', fullName: 'Foreign', address: 'Test', sex: 'female', ageYears: 20 });
    assert.equal((await post('preview', { ...action(1, 2), otherPatientId: foreign })).statusCode, 409);
  });

  it('previews original activity and links once across retries without rewriting the encounter', async () => {
    const preview = await post('preview', action(1, 2)); assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().records.find((row: { patient: { id: string } }) => row.patient.id === id(2)).counts.encounters, 1);
    const body = { ...action(1, 2), revision: preview.json().revision, requestId: randomUUID(), reason: 'Confirmed in person with both cards and demographic history' };
    const responses = await Promise.all([post('confirm', body), post('confirm', body)]);
    for (const response of responses) assert.equal(response.statusCode, 200, response.body);
    assert.equal(responses[0].json().id, responses[1].json().id);
    assert.equal(canonicalPatientId(id(2), await eventsForFacility(db.sql, facility.facility.id)), id(1));
    const [encounter] = await db.sql`SELECT patient_id FROM encounters WHERE id = 'encounter:alias-history'`; assert.equal(encounter.patient_id, id(2));
    assert.equal((await post('confirm', { ...body, reason: 'Changed retry reason' })).statusCode, 409);
    const [audits] = await db.sql`SELECT count(*)::int AS n FROM audit_events WHERE entity_type = 'patient_identity_event' AND entity_id = ${responses[0].json().id}`; assert.equal(audits.n, 1);
  });

  it('refuses stale previews and serialises conflicting decisions', async () => {
    const a = await post('preview', action(3, 4)); const b = await post('preview', action(5, 4));
    const responses = await Promise.all([
      post('confirm', { ...action(3, 4), revision: a.json().revision, requestId: randomUUID(), reason: 'Confirmed first identity group' }),
      post('confirm', { ...action(5, 4), revision: b.json().revision, requestId: randomUUID(), reason: 'Conflicting identity group' }),
    ]);
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
    const preview = await post('preview', action(6, 7));
    await db.sql`UPDATE patients SET address = 'Changed after preview' WHERE id = ${id(7)}`;
    assert.equal((await post('confirm', { ...action(6, 7), revision: preview.json().revision, requestId: randomUUID(), reason: 'Must review changed demographics' })).statusCode, 409);
  });

  it('corrects a mistaken link and keeps every original record', async () => {
    const preview = await post('preview', action(1, 2, 'unlinked'));
    const response = await post('confirm', { ...action(1, 2, 'unlinked'), revision: preview.json().revision, requestId: randomUUID(), reason: 'Further evidence established these are different people' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(canonicalPatientId(id(2), await eventsForFacility(db.sql, facility.facility.id)), id(2));
    const [encounter] = await db.sql`SELECT patient_id FROM encounters WHERE id = 'encounter:alias-history'`; assert.equal(encounter.patient_id, id(2));
    const failure = await refusal(db.sql`UPDATE patient_identity_events SET reason = 'Overwrite' WHERE id = ${response.json().id}`);
    assert.equal(failure.code, '42501');
  });
});
