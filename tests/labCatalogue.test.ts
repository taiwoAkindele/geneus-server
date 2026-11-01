import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Patient, type FacilityRegistrationResult, type ServiceDefinition, type UploadMutation } from '#shared';
import { insertRecord } from '../src/db/records.ts';
import { recordsInFacility } from '../src/workforce/records.ts';
import { versions } from './workforceFixtures.ts';
import { addStaff, asDevice, clientId, envelopeFor, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

describe('server-owned laboratory catalogue', () => {
  let db: ScratchDatabase, app: FastifyInstance, facility: FacilityRegistrationResult, other: FacilityRegistrationResult;
  const post = (path: string, body: Record<string, unknown>, f = facility) => app.inject({ method: 'POST', url: `/investigations/${path}`, headers: asDevice(f.device.credential), payload: { actorStaffId: f.admin.id, ...body } });
  const definitions = async (f = facility) => (await recordsInFacility(db.sql, f.facility.id, 'service_definition')).filter((d) => d.investigation);
  before(async () => {
    db = await scratchDatabase(); app = testApp(db.sql);
    [facility, other] = [await registerScratchFacility(db.sql), await registerScratchFacility(db.sql)];
    // The first facility already set up its Laboratory; the other has none yet.
    await insertRecord(db.sql, 'unit', { ...envelopeFor(facility), id: 'unit:lab', unitId: 'unit:lab', type: 'unit', name: 'Laboratory' });
    await insertRecord(db.sql, 'location', { ...envelopeFor(facility), id: 'location:lab', type: 'location', name: 'laboratory', kind: 'room' });
  });
  after(async () => { await app?.close(); await db?.drop(); });

  it('lists the standard tests and adopts chosen ones with the server copy of their names and codes, under the existing Laboratory', async () => {
    const list = await post('standard-tests', {});
    assert.equal(list.statusCode, 200);
    const tests = list.json().tests as { key: string; added: boolean }[];
    assert.ok(tests.length >= 30 && tests.every((t) => !t.added && !('loinc' in t)));
    const adopt = await post('standard-tests/adopt', { keys: ['fbc', 'widal'] });
    assert.equal(adopt.statusCode, 200, adopt.body);
    assert.deepEqual(adopt.json(), { added: ['Full blood count', 'Widal test'], skipped: [] });
    const saved = await definitions();
    assert.deepEqual(saved.find((d) => d.name === 'Full blood count')?.concept, { system: 'http://loinc.org', code: '58410-2', label: 'Full blood count' });
    assert.deepEqual(saved.find((d) => d.name === 'Widal test')?.concept, { system: 'urn:geneus:standard-test', code: 'widal', label: 'Widal test' });
    const offerings = await recordsInFacility(db.sql, facility.facility.id, 'service_offering');
    assert.ok(saved.every((d) => offerings.some((o) => o.serviceDefinitionId === d.id && o.unitId === 'unit:lab' && o.locationIds[0] === 'location:lab' && o.configuration === 'active' && o.resourceReadiness === 'available')));
    assert.equal((await recordsInFacility(db.sql, facility.facility.id, 'unit')).filter((u) => u.name.toLowerCase() === 'laboratory').length, 1);
    assert.ok((await post('standard-tests', {})).json().tests.find((t: { key: string; added: boolean }) => t.key === 'fbc').added);
  });

  it('creates one Laboratory unit and location for a facility that has none, and reuses them afterwards', async () => {
    const first = await post('tests', { tests: [{ name: 'Malaria smear', specimen: 'Blood', classification: 'Haematology' }] }, other);
    assert.deepEqual(first.json(), { added: ['Malaria smear'], skipped: [] });
    await post('standard-tests/adopt', { keys: ['esr'] }, other);
    const units = (await recordsInFacility(db.sql, other.facility.id, 'unit')).filter((u) => u.name === 'Laboratory');
    const locations = (await recordsInFacility(db.sql, other.facility.id, 'location')).filter((l) => l.name === 'Laboratory');
    assert.equal(units.length, 1); assert.equal(locations.length, 1);
    assert.equal(locations[0].unitId, units[0].id);
    const offerings = await recordsInFacility(db.sql, other.facility.id, 'service_offering');
    assert.equal(offerings.length, 2);
    assert.ok(offerings.every((o) => o.unitId === units[0].id && o.locationIds[0] === locations[0].id));
  });

  it('skips duplicates by name or other name, including within one request, and changes nothing existing', async () => {
    const before = await definitions();
    const result = await post('tests', { tests: [
      { name: 'Complete blood count', specimen: 'Blood', classification: 'Haematology', aliases: [] },
      { name: 'Antenatal panel', specimen: 'Blood and urine', classification: 'Antenatal', aliases: ['ANC panel'] },
      { name: 'anc  PANEL', specimen: 'Blood', classification: 'Antenatal', aliases: [] },
    ] });
    assert.deepEqual(result.json(), { added: ['Antenatal panel'], skipped: ['Complete blood count', 'anc  PANEL'] });
    const after = await definitions();
    assert.equal(after.length, before.length + 1);
    assert.equal(after.find((d) => d.name === 'Antenatal panel')?.concept.system, 'local');
    assert.deepEqual(after.find((d) => d.name === 'Full blood count'), before.find((d) => d.name === 'Full blood count'));
    assert.deepEqual((await post('standard-tests/adopt', { keys: ['fbc'] })).json(), { added: [], skipped: ['Full blood count'] });
  });

  it('refuses unknown standard keys and staff without service management', async () => {
    assert.equal((await post('standard-tests/adopt', { keys: ['not-a-test'] })).statusCode, 400);
    const nurse = await addStaff(db.sql, facility, { role: 'nurse', permission: 'read_write' });
    const denied = await app.inject({ method: 'POST', url: '/investigations/standard-tests/adopt', headers: asDevice(facility.device.credential), payload: { actorStaffId: nurse.id, keys: ['hba1c'] } });
    assert.equal(denied.statusCode, 403);
    assert.ok(!(await definitions()).some((d) => d.name === 'HbA1c'));
  });

  it('refuses a lab test created or recoded on a device, while ordinary edits still sync', async () => {
    const put = (id: string, data: Record<string, unknown>): UploadMutation => ({ clientId: clientId(), op: 'put', table: 'service_definition', id, data: { ...envelopeFor(facility), ...data, id, type: 'service_definition' } });
    const forged = await upload(app, facility.device.credential, { ...versions, transactionId: clientId(), mutations: [put('service_definition:forged', { name: 'Forged standard test', category: 'laboratory', concept: { system: 'http://loinc.org', code: '718-7', label: 'Forged' }, orderable: true, active: true, revision: 1, investigation: { specimen: 'Blood', department: 'Haematology', aliases: [] } })] });
    assert.equal(forged.applied, 0);
    assert.match(forged.rejected[0].reason, /investigation catalogue while connected/);
    const existing = (await definitions()).find((d) => d.name === 'Widal test') as ServiceDefinition;
    const patch = (data: Record<string, unknown>): UploadMutation => ({ clientId: clientId(), op: 'patch', table: 'service_definition', id: existing.id, expectedRevision: existing.revision, data: { ...data, revision: existing.revision + 1, updatedBy: facility.admin.id, updatedOn: new Date().toISOString() } });
    const recoded = await upload(app, facility.device.credential, { ...versions, transactionId: clientId(), mutations: [patch({ concept: { ...existing.concept, code: 'other' } })] });
    assert.equal(recoded.applied, 0);
    assert.match(recoded.rejected[0].reason, /keeps its original code/);
    const renamed = await upload(app, facility.device.credential, { ...versions, transactionId: clientId(), mutations: [patch({ name: 'Widal (febrile antigens)' })] });
    assert.equal(renamed.applied, 1, JSON.stringify(renamed.rejected));
  });

  it('accepts a requested test that is not in the catalogue, without a catalogue price', async () => {
    const env = envelopeFor(facility), patientId = `${facility.facility.code}-000001-K2`, encounterId = 'encounter:unlisted';
    const entry = (id: string, step: string, values: Record<string, unknown>) => ({ ...env, id, type: 'encounter_entry', workflowVersion: 1, patientId, encounterId, actorRole: facility.admin.role, step, values });
    const item = { id: 'order_item:unlisted', name: 'Serum ferritin', custom: true, priority: 'routine' };
    const records = [
      Patient.parse({ ...env, id: patientId, type: 'patient', patientId, fullName: 'Synthetic patient', address: 'Synthetic address', sex: 'female', ageYears: 30 }),
      { ...env, id: encounterId, type: 'encounter', patientId, workflowVersion: 1, openedOn: env.createdOn },
      entry('entry:vitals', 'vitals', { temperatureC: 38 }),
      entry('entry:complaint', 'complaint', { complaints: ['Tiredness'] }),
      entry('entry:order', 'lab_order', { tests: [item.name], items: [item] }),
      entry('entry:decision', 'investigation_review', { decision: 'ordered', orderEntryId: 'entry:order' }),
    ];
    const send = (all: Record<string, unknown>[]) => upload(app, facility.device.credential, { clinicalWorkflowVersion: 1, ...versions, transactionId: clientId(), mutations: all.map((record): UploadMutation => ({ clientId: clientId(), op: 'put', table: record.type as UploadMutation['table'], id: String(record.id), data: record })) });
    const accepted = await send(records);
    assert.deepEqual(accepted.rejected, []);
    const priced = await send([entry('entry:priced-order', 'lab_order', { tests: ['Serum zinc'], items: [{ ...item, id: 'order_item:priced', name: 'Serum zinc', priceMinor: 100, currency: 'NGN' }] })]);
    assert.match(priced.rejected[0].reason, /cannot invent a catalogue price/);
  });
});
