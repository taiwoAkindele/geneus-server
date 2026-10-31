import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { patientIdentitySnapshot, provisionalPatientName, type FacilityRegistrationResult, type Patient, type Staff } from '#shared';
import { findRecord } from '../src/db/records.ts';
import { addStaff, clientId, envelopeFor, refusal, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

describe('provisional patient upload and immutable identification', () => {
  let db: ScratchDatabase, app: FastifyInstance, facility: FacilityRegistrationResult, doctor: Staff;
  before(async () => { db = await scratchDatabase(); app = testApp(db.sql); facility = await registerScratchFacility(db.sql); doctor = await addStaff(db.sql, facility, { role: 'doctor' }); });
  after(async () => { if (app) await app.close(); if (db) await db.drop(); });
  const id = (n: number) => `${facility.facility.id}-${String(n).padStart(6, '0')}-K2`;
  const create = async (n: number) => {
    const patientId = id(n);
    const result = await upload(app, facility.device.credential, { transactionId: null, mutations: [{ clientId: clientId(), op: 'put', table: 'patient', id: patientId, data: { ...envelopeFor(facility), schemaVersion: 5, createdBy: doctor.id, patientId, fullName: provisionalPatientName(patientId), identityStatus: 'provisional', provisionalReason: 'Synthetic unidentified arrival' } }] });
    assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
    return (await findRecord<Patient>(db.sql, 'patient', patientId))!;
  };
  const patch = (patient: Patient, changes: Record<string, unknown>) => upload(app, facility.device.credential, { transactionId: null, mutations: [{ clientId: clientId(), op: 'patch', table: 'patient', id: patient.id, data: { updatedBy: doctor.id, updatedOn: new Date().toISOString(), ...changes }, previous: Object.fromEntries(Object.keys(changes).map((key) => [key, (patient as Record<string, unknown>)[key] ?? null])) }] });
  const identification = (patient: Patient) => { const now = new Date().toISOString(); return { identityStatus: 'identified', fullName: 'Synthetic Identified Patient', sex: 'female', ageYears: 30, ageObservedOn: now.slice(0, 10), address: 'Synthetic address', identifiedBy: doctor.id, identifiedOn: now, updatedOn: now, identificationNote: 'Representative supplied identity information', identificationBase: patientIdentitySnapshot(patient) }; };

  it('accepts two genuinely unknown patients without invented demographics', async () => {
    const first = await create(101), second = await create(102);
    assert.notEqual(first.id, second.id); assert.notEqual(first.fullName, second.fullName);
    assert.equal(first.sex, undefined); assert.equal(first.ageYears, undefined); assert.equal(first.address, undefined);
  });
  it('retains clinical history and records an audited, attributed identification on the same patient ID', async () => {
    const patient = await create(103), encounterId = 'encounter:synthetic-provisional';
    const care = await upload(app, facility.device.credential, { transactionId: null, mutations: [{ clientId: clientId(), op: 'put', table: 'encounter', id: encounterId, data: { ...envelopeFor(facility), createdBy: doctor.id, patientId: patient.id, openedOn: new Date().toISOString() } }] });
    assert.equal(care.rejected.length, 0);
    assert.equal((await patch(patient, identification(patient))).rejected.length, 0);
    const saved = (await findRecord<Patient>(db.sql, 'patient', patient.id))!;
    assert.equal(saved.identityStatus, 'identified'); assert.equal(saved.provisionalReason, patient.provisionalReason); assert.equal(saved.identifiedBy, doctor.id);
    const [encounter] = await db.sql`SELECT patient_id FROM encounters WHERE id=${encounterId}`;
    assert.equal(encounter.patient_id, patient.id);
    const audits = await db.sql`SELECT id FROM audit_events WHERE entity_type='patient' AND entity_id=${patient.id} AND actor_staff_id=${doctor.id} AND action='update'`;
    assert.equal(audits.length, 1);
  });
  it('refuses incomplete or falsely attributed identification without changing the record', async () => {
    const patient = await create(104);
    assert.equal((await patch(patient, { identityStatus: 'identified', fullName: 'Name only' })).rejected.length, 1);
    assert.equal((await patch(patient, { ...identification(patient), identifiedBy: 'staff:forged' })).rejected.length, 1);
    assert.equal((await findRecord<Patient>(db.sql, 'patient', patient.id))?.identityStatus, 'provisional');
  });
  it('prevents direct SQL from rewriting the original circumstances or completed identity history', async () => {
    const patient = await create(105);
    assert.ok(await refusal(db.sql`UPDATE patients SET provisional_reason='Replace original history' WHERE id=${patient.id}`));
    assert.equal((await patch(patient, identification(patient))).rejected.length, 0);
    assert.ok(await refusal(db.sql`UPDATE patients SET identification_note='Replace identification history' WHERE id=${patient.id}`));
  });
  it('does not partially identify a patient after another device changed a demographic field', async () => {
    const patient = await create(106);
    await db.sql`UPDATE patients SET sex='male' WHERE id=${patient.id}`;
    assert.equal((await patch(patient, identification(patient))).rejected.length, 1);
    const saved = (await findRecord<Patient>(db.sql, 'patient', patient.id))!;
    assert.equal(saved.identityStatus, 'provisional'); assert.equal(saved.sex, 'male'); assert.equal(saved.identifiedBy, undefined);
  });
  it('refuses a changed identity detail even when that field was untouched in the identification patch', async () => {
    const patient = await create(107);
    await db.sql`UPDATE patients SET phone='08000000002' WHERE id=${patient.id}`;
    assert.equal((await patch(patient, identification(patient))).rejected.length, 1);
    const saved = (await findRecord<Patient>(db.sql, 'patient', patient.id))!;
    assert.equal(saved.identityStatus, 'provisional'); assert.equal(saved.phone, '08000000002'); assert.equal(saved.identifiedBy, undefined);
  });
});
