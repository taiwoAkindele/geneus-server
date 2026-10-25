import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, Staff, UploadMutation } from '#shared';
import { findRecord } from '../src/db/records.ts';
import { addStaff, clientId, envelopeFor, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

describe('longitudinal clinical records and corrections on upload', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let facility: FacilityRegistrationResult;
  let doctor: Staff;
  let cashier: Staff;
  const patientId = (sequence = '000001') => `${facility.facility.id}-${sequence}-K2`;
  const put = (table: UploadMutation['table'], id: string, data: Record<string, unknown>, actor?: Staff): UploadMutation => ({
    clientId: clientId(), op: 'put', table, id, data: { ...envelopeFor(facility), createdBy: (actor ?? doctor).id, ...data, type: table, id },
  });
  const send = (...mutations: UploadMutation[]) => upload(app, facility.device.credential, { transactionId: 1, mutations });
  const problem = (id: string, extra: Record<string, unknown> = {}, actor?: Staff) => put('clinical_event', id, {
    patientId: patientId(), kind: 'problem', recordId: id, actorRole: (actor ?? doctor).role,
    values: { label: 'Hypertension', status: 'active', certainty: 'confirmed' }, ...extra,
  }, actor);
  const entry = (id: string, step: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}) => put('encounter_entry', id, {
    patientId: patientId(), encounterId: 'encounter:clinical', actorRole: 'doctor', step, values, ...extra,
  });
  before(async () => {
    db = await scratchDatabase(); app = testApp(db.sql); facility = await registerScratchFacility(db.sql);
    doctor = await addStaff(db.sql, facility, { role: 'doctor' });
    cashier = await addStaff(db.sql, facility, { role: 'cashier' });
    const response = await send(
      ...['000001', '000002'].map((sequence) => put('patient', patientId(sequence), { patientId: patientId(sequence), fullName: 'Clinical Patient', address: 'Test road', sex: 'female', ageYears: 30 })),
      put('encounter', 'encounter:clinical', { patientId: patientId(), openedOn: new Date().toISOString() }),
      entry('entry:vitals', 'vitals', { temperatureC: 39 }),
      entry('entry:diagnosis', 'diagnosis', { diagnosis: 'Initial diagnosis', prescription: [{ drug: 'Medicine', dose: '1 tablet' }], admit: false, giveInjection: false }),
    );
    assert.deepEqual(response.rejected, []);
  });
  after(async () => { if (app) await app.close(); if (db) await db.drop(); });

  it('accepts a problem and its revision, preserving the original', async () => {
    assert.deepEqual((await send(problem('clinical:problem'))).rejected, []);
    const revision = problem('clinical:revision', { recordId: 'clinical:problem', previousId: 'clinical:problem', values: { label: 'Hypertension', status: 'resolved', certainty: 'confirmed' } });
    assert.deepEqual((await send(revision)).rejected, []);
    const original = await db.sql`SELECT "values" FROM clinical_events WHERE id = 'clinical:problem'`;
    assert.equal(original[0].values.status, 'active');
    await assert.rejects(db.sql`UPDATE clinical_events SET "values" = '{}' WHERE id = 'clinical:problem'`, /never changed/);
    await assert.rejects(db.sql`DELETE FROM clinical_events WHERE id = 'clinical:problem'`, /never changed/);
  });
  it('keeps a stale competing revision in the reconciliation queue', async () => {
    const response = await send(problem('clinical:stale', { recordId: 'clinical:problem', previousId: 'clinical:problem' }));
    assert.equal(response.rejected[0]?.category, 'conflict');
    const [rejection] = await db.sql`SELECT refused_record FROM sync_rejections WHERE entity_id = 'clinical:stale'`;
    assert.equal(rejection.refused_record.values.label, 'Hypertension');
    assert.equal(await findRecord(db.sql, 'clinical_event', 'clinical:stale'), undefined);
  });
  it('refuses cashiers, false role attribution, malformed values and cross-patient revisions', async () => {
    assert.equal((await send(problem('clinical:cashier', {}, cashier))).rejected[0]?.category, 'authorization');
    assert.equal((await send(problem('clinical:false-role', { actorRole: 'nurse' }))).rejected[0]?.category, 'authorization');
    assert.equal((await send(problem('clinical:bad-values', { kind: 'allergy' }))).rejected[0]?.category, 'validation');
    assert.equal((await send(problem('clinical:other-patient', { recordId: 'clinical:problem', previousId: 'clinical:revision', patientId: patientId('000002') }))).rejected[0]?.category, 'validation');
  });
  it('requires encounter and problem links to belong to the same patient', async () => {
    const encounterMismatch = await send(problem('clinical:wrong-encounter', { encounterId: 'encounter:clinical', patientId: patientId('000002') }));
    assert.equal(encounterMismatch.rejected[0]?.category, 'validation');
    const wrongProblem = await send(problem('clinical:wrong-problem', { kind: 'care_plan', patientId: patientId('000002'), values: { title: 'Review', goal: 'Review progress', actions: 'Review observations', status: 'active', problemId: 'clinical:problem' } }));
    assert.equal(wrongProblem.rejected[0]?.category, 'validation');
  });
  it('serializes concurrent revisions so one is accepted and one is reconciled', async () => {
    await send(problem('clinical:concurrent-root'));
    const responses = await Promise.all([
      send(problem('clinical:concurrent-a', { recordId: 'clinical:concurrent-root', previousId: 'clinical:concurrent-root' })),
      send(problem('clinical:concurrent-b', { recordId: 'clinical:concurrent-root', previousId: 'clinical:concurrent-root' })),
    ]);
    assert.equal(responses.reduce((sum, response) => sum + response.applied, 0), 1);
    assert.equal(responses.flatMap((response) => response.rejected).length, 1);
  });
  it('accepts a structured correction, then refuses a stale or malformed correction', async () => {
    const first = await send(entry('entry:correction', 'amendment', { note: 'Correct reading', correctedValues: { temperatureC: 37 } }, { amends: 'entry:vitals' }));
    assert.deepEqual(first.rejected, []);
    const stale = await send(entry('entry:stale-correction', 'amendment', { note: 'Outdated reading', correctedValues: { temperatureC: 36 } }, { amends: 'entry:vitals' }));
    assert.equal(stale.rejected[0]?.category, 'conflict');
    const invalid = await send(entry('entry:invalid-correction', 'amendment', { note: 'Wrong fields', correctedValues: { diagnosis: 'Other' }, previousAmendmentId: 'entry:correction' }, { amends: 'entry:vitals' }));
    assert.equal(invalid.rejected[0]?.category, 'validation');
  });
  it('allows corrections to flow through a causal chain despite clock skew', async () => {
    const response = await send(entry('entry:second-correction', 'amendment', { note: 'Rechecked', correctedValues: { temperatureC: 36.5 }, previousAmendmentId: 'entry:correction' }, { amends: 'entry:vitals', createdOn: '2026-10-24T09:00:00Z' }));
    assert.deepEqual(response.rejected, []);
    const next = await send(entry('entry:third-correction', 'amendment', { note: 'Source verified', correctedValues: { temperatureC: 36.8 }, previousAmendmentId: 'entry:second-correction' }, { amends: 'entry:vitals' }));
    assert.deepEqual(next.rejected, []);
  });
  it('does not change disposition or rewrite already dispensed prescriptions through corrections', async () => {
    const disposition = await send(entry('entry:bad-disposition', 'amendment', { note: 'Change plan', correctedValues: { diagnosis: 'Other', admit: true } }, { amends: 'entry:diagnosis' }));
    assert.equal(disposition.rejected[0]?.category, 'validation');
    await send(entry('entry:dispense', 'dispense', { lines: [{ drug: 'Medicine', dispensed: true }] }));
    const medication = await send(entry('entry:bad-prescription', 'amendment', { note: 'Change medicine', correctedValues: { diagnosis: 'Other', prescription: [{ drug: 'Other medicine', dose: '1' }] } }, { amends: 'entry:diagnosis' }));
    assert.equal(medication.rejected[0]?.category, 'validation');
  });
  it('compares later corrections with the prescription actually dispensed after an earlier correction', async () => {
    const encounterId = 'encounter:corrected-prescription';
    const diagnosisId = 'entry:corrected-prescription';
    const prescription = [{ drug: 'Reviewed medicine', dose: '1 tablet' }];
    assert.deepEqual((await send(
      put('encounter', encounterId, { patientId: patientId(), openedOn: new Date().toISOString() }),
      entry(diagnosisId, 'diagnosis', { diagnosis: 'Initial', prescription: [] }, { encounterId }),
      entry('entry:rx-correction', 'amendment', { note: 'Before dispensing', correctedValues: { diagnosis: 'Reviewed', prescription } }, { encounterId, amends: diagnosisId }),
      entry('entry:reviewed-dispense', 'dispense', { lines: [{ drug: 'Reviewed medicine', dispensed: true }] }, { encounterId }),
    )).rejected, []);
    const response = await send(entry('entry:clarify-diagnosis', 'amendment', { note: 'Diagnosis clarification only', correctedValues: { diagnosis: 'Clarified', prescription }, previousAmendmentId: 'entry:rx-correction' }, { encounterId, amends: diagnosisId }));
    assert.deepEqual(response.rejected, []);
  });
  it('allows amendments after closure but refuses additional observations', async () => {
    await send(entry('entry:close', 'follow_up', {}));
    assert.equal((await send(entry('entry:late', 'vitals', { temperatureC: 38 }))).rejected[0]?.category, 'conflict');
    assert.deepEqual((await send(entry('entry:late-note', 'amendment', { note: 'Additional clarification' }, { amends: 'entry:vitals' }))).rejected, []);
  });
  it('does not bypass prescription correction controls by inserting a second diagnosis', async () => {
    const response = await send(entry('entry:second-diagnosis', 'diagnosis', { diagnosis: 'Second diagnosis' }, { encounterId: 'encounter:corrected-prescription' }));
    assert.equal(response.rejected[0]?.category, 'conflict');
    assert.match(response.rejected[0]?.reason ?? '', /already saved/);
  });
});
