import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, Patient, Staff, SyncRejection, UploadMutation } from '#shared';
import { findRecord } from '../src/db/records.ts';
import { enrollDevice, issueEnrollmentCode } from '../src/devices/enrollment.ts';
import {
  addStaff,
  clientId,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
  testApp,
  upload,
  type ScratchDatabase,
} from './postgres.ts';

/**
 * Encounters (SCHEMA.md §13) and the Patient ID clash (SCHEMA.md §7): a saved
 * step is never changed, a closed encounter takes only amendments, and nothing
 * a device recorded against a patient it lost to an ID clash attaches to the
 * other patient.
 */
describe('encounters and Patient ID clashes on upload', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let a: FacilityRegistrationResult;
  let second: { deviceId: string; credential: string };
  let nurse: Staff;
  let doctor: Staff;
  let records: Staff;
  let consultation: string;
  let injectionRoom: string;

  const patientId = (sequence: string) => `${a.facility.id}-${sequence}-K2`;

  /** Records as the given device; the first device unless told otherwise. */
  const envelope = (by: Staff, deviceId = a.device.deviceId) => ({ ...envelopeFor(a), createdBy: by.id, deviceId });

  const put = (table: UploadMutation['table'], id: string, data: Record<string, unknown>): UploadMutation => ({
    clientId: clientId(),
    op: 'put',
    table,
    id,
    data: { ...data, id, type: table },
  });

  const patientPut = (sequence: string, fullName: string, deviceId?: string) =>
    put('patient', patientId(sequence), {
      ...envelope(records, deviceId),
      patientId: patientId(sequence),
      fullName,
      address: 'Odo-Ona',
      sex: 'female',
      ageYears: 32,
    });

  const encounterPut = (id: string, patient: string, by: Staff, deviceId?: string) =>
    put('encounter', id, { ...envelope(by, deviceId), patientId: patient, openedOn: new Date().toISOString() });

  const entryPut = (
    id: string,
    encounterId: string,
    patient: string,
    by: Staff,
    step: string,
    values: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    put('encounter_entry', id, {
      ...envelope(by, extra.deviceId as string | undefined),
      encounterId,
      patientId: patient,
      step,
      actorRole: by.role,
      values,
      ...extra,
    });

  const send = (credential: string, ...mutations: UploadMutation[]) => upload(app, credential, { transactionId: 1, mutations });

  const rejectionFor = async (entityId: string) => {
    const [row] = await db.sql<{ category: string; reason: string; refused_record: SyncRejection['refusedRecord'] | null }[]>`
      SELECT category, reason, refused_record FROM sync_rejections WHERE entity_id = ${entityId} ORDER BY created_on DESC LIMIT 1`;
    return row;
  };

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    a = await registerScratchFacility(db.sql);
    [nurse, doctor, records] = await Promise.all([
      addStaff(db.sql, a, { role: 'nurse' }),
      addStaff(db.sql, a, { role: 'doctor' }),
      addStaff(db.sql, a, { role: 'records_officer' }),
    ]);
    const code = await issueEnrollmentCode(db.sql, a.facility.id, a.admin.id, a.device.deviceId);
    const enrolled = await enrollDevice(db.sql, { code: code.code, deviceId: 'device-encounter-second' }, 'http://sync');
    if (!enrolled.ok) throw new Error(enrolled.error);
    second = { deviceId: enrolled.device.id, credential: enrolled.credential.credential };

    consultation = 'unit:consultation';
    injectionRoom = 'unit:injection';
    const units = [consultation, injectionRoom].map((id) =>
      put('unit', id, { ...envelope(a.admin), unitId: id, name: id }),
    );
    const setup = await send(a.device.credential, ...units, patientPut('000001', 'Amaka Okoro'), patientPut('000002', 'Bisi Adeyemi'));
    assert.deepEqual(setup.rejected, []);
  });

  after(async () => {
    await app.close();
    await db.drop();
  });

  describe('recording an encounter', () => {
    it('applies a nurse opening an encounter and saving vitals', async () => {
      const response = await send(
        a.device.credential,
        encounterPut('encounter:1', patientId('000001'), nurse),
        entryPut('encounter_entry:1-vitals', 'encounter:1', patientId('000001'), nurse, 'vitals', { temperatureC: 38.9 }),
      );

      assert.deepEqual(response.rejected, []);
      const [row] = await db.sql<{ values: Record<string, unknown>; actor_role: string }[]>`
        SELECT "values", actor_role FROM encounter_entries WHERE id = 'encounter_entry:1-vitals'`;
      assert.deepEqual(row, { values: { temperatureC: 38.9 }, actor_role: 'nurse' });
    });

    it('refuses the front desk recording a clinical step', async () => {
      const response = await send(
        a.device.credential,
        entryPut('encounter_entry:1-front-desk', 'encounter:1', patientId('000001'), records, 'complaint', { complaints: ['Fever'] }),
      );

      assert.equal(response.rejected[0]?.category, 'authorization');
    });

    it('refuses a step stamped with a role the server does not know the person holds', async () => {
      const response = await send(
        a.device.credential,
        entryPut('encounter_entry:1-posing', 'encounter:1', patientId('000001'), nurse, 'diagnosis', { diagnosis: 'Malaria' }, { actorRole: 'doctor' }),
      );

      assert.equal(response.rejected[0]?.category, 'authorization');
      assert.match(response.rejected[0]?.reason ?? '', /saved as doctor/);
    });

    it('refuses any change to a saved step, at the door and in PostgreSQL itself', async () => {
      const response = await send(a.device.credential, {
        clientId: clientId(),
        op: 'patch',
        table: 'encounter_entry',
        id: 'encounter_entry:1-vitals',
        data: { values: { temperatureC: 37 }, updatedBy: nurse.id, updatedOn: new Date().toISOString() },
      });

      assert.equal(response.rejected[0]?.category, 'validation');
      await assert.rejects(db.sql`UPDATE encounter_entries SET "values" = '{}' WHERE id = 'encounter_entry:1-vitals'`, /never changed/);
      await assert.rejects(db.sql`DELETE FROM encounters WHERE id = 'encounter:1'`, /never changed/);
    });

    it('refuses an amendment of an entry that belongs to another encounter', async () => {
      await send(a.device.credential, encounterPut('encounter:2', patientId('000001'), nurse));

      const response = await send(
        a.device.credential,
        entryPut('encounter_entry:2-stray', 'encounter:2', patientId('000001'), nurse, 'amendment', { note: 'wrong chart' }, { amends: 'encounter_entry:1-vitals' }),
      );

      assert.equal(response.rejected[0]?.category, 'validation');
    });

    it('refuses an entry naming a different patient from its encounter', async () => {
      const response = await send(
        a.device.credential,
        entryPut('encounter_entry:1-other-patient', 'encounter:1', patientId('000002'), nurse, 'vitals', { pulseBpm: 80 }),
      );

      assert.equal(response.rejected[0]?.category, 'validation');
    });

    it('moves a patient between units within an encounter of that same patient only', async () => {
      const handoff = (id: string, patient: string) =>
        put('handoff', id, {
          ...envelope(doctor),
          patientId: patient,
          fromUnitId: consultation,
          toUnitId: injectionRoom,
          encounterId: 'encounter:1',
          instruction: 'Give tetanus toxoid injection',
        });

      const response = await send(a.device.credential, handoff('handoff:1', patientId('000001')), handoff('handoff:2', patientId('000002')));

      assert.equal(response.applied, 1);
      assert.equal(response.rejected[0]?.id, 'handoff:2');
    });
  });

  describe('closing an encounter', () => {
    it('takes only amendments once closed, keeping the late entry in the queue', async () => {
      await send(
        a.device.credential,
        encounterPut('encounter:3', patientId('000002'), doctor),
        entryPut('encounter_entry:3-diagnosis', 'encounter:3', patientId('000002'), doctor, 'diagnosis', { diagnosis: 'Malaria' }),
        entryPut('encounter_entry:3-close', 'encounter:3', patientId('000002'), doctor, 'follow_up', {}),
      );

      // Recorded on the second device while it had not yet heard of the close.
      const late = entryPut('encounter_entry:3-late', 'encounter:3', patientId('000002'), nurse, 'lab_results', { results: [{ test: 'Malaria RDT', result: 'Positive' }] }, { deviceId: second.deviceId });
      const amendment = entryPut('encounter_entry:3-amend', 'encounter:3', patientId('000002'), doctor, 'amendment', { note: 'Uncomplicated malaria' }, { amends: 'encounter_entry:3-diagnosis', deviceId: second.deviceId });
      const response = await send(second.credential, late, amendment);

      assert.equal(response.applied, 1);
      assert.equal(response.rejected[0]?.id, late.id);
      assert.equal(response.rejected[0]?.category, 'conflict');
      const queued = await rejectionFor(late.id);
      assert.deepEqual(queued?.refused_record?.values, { results: [{ test: 'Malaria RDT', result: 'Positive' }] });
    });
  });

  describe('a Patient ID taken by another device', () => {
    const clashing = () => patientId('000047');

    before(async () => {
      const first = await send(a.device.credential, patientPut('000047', 'First Device Patient'));
      assert.deepEqual(first.rejected, []);
    });

    it('keeps the refused registration whole in the reconcile queue', async () => {
      const response = await send(second.credential, patientPut('000047', 'Second Device Patient', second.deviceId));

      assert.equal(response.rejected[0]?.category, 'conflict');
      assert.equal((await findRecord<Patient>(db.sql, 'patient', clashing()))?.fullName, 'First Device Patient');
      const queued = await rejectionFor(clashing());
      assert.equal(queued?.refused_record?.fullName, 'Second Device Patient');
    });

    it("holds the device's later records for that patient instead of attaching them to the other one", async () => {
      const encounter = encounterPut('encounter:held', clashing(), nurse, second.deviceId);
      const edit: UploadMutation = {
        clientId: clientId(),
        op: 'patch',
        table: 'patient',
        id: clashing(),
        data: { phone: '0809', updatedBy: records.id, updatedOn: new Date().toISOString() },
      };

      const response = await send(second.credential, encounter, edit);

      assert.equal(response.applied, 0);
      assert.deepEqual(response.rejected.map((rejection) => rejection.category), ['conflict', 'conflict']);
      assert.match(response.rejected[0]?.reason ?? '', /^held:/);
      assert.equal(await findRecord(db.sql, 'encounter', encounter.id), undefined);
      assert.equal((await findRecord<Patient>(db.sql, 'patient', clashing()))?.phone, undefined);
      const [ledger] = await db.sql<{ outcome: string }[]>`
        SELECT outcome FROM applied_mutations WHERE device_id = ${second.deviceId} AND client_id = ${edit.clientId}`;
      assert.equal(ledger.outcome, 'rejected', 'a held patch applied nothing');
    });

    it('does not hold the device that registered the patient first', async () => {
      const response = await send(a.device.credential, encounterPut('encounter:first-device', clashing(), nurse));

      assert.deepEqual(response.rejected, []);
    });

    it('stops holding once a records officer has resolved the clash', async () => {
      await db.sql`
        UPDATE sync_rejections SET resolved_on = now(), resolved_by = ${records.id}, resolution = 're-registered'
        WHERE entity_id = ${clashing()} AND device_id = ${second.deviceId}`;

      const response = await send(second.credential, encounterPut('encounter:after-resolution', clashing(), nurse, second.deviceId));

      assert.deepEqual(response.rejected, []);
    });
  });
});
