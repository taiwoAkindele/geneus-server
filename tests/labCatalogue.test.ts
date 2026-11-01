import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, ServiceDefinition, ServiceOffering, UploadMutation } from '#shared';
import { insertRecord } from '../src/db/records.ts';
import { recordsInFacility } from '../src/workforce/records.ts';
import { versions } from './workforceFixtures.ts';
import { addStaff, asDevice, clientId, envelopeFor, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

describe('server-owned laboratory catalogue', () => {
  let db: ScratchDatabase, app: FastifyInstance, facility: FacilityRegistrationResult, other: FacilityRegistrationResult;
  const placement = { unitId: 'unit:lab', locationId: 'location:lab' };
  const post = (path: string, body: Record<string, unknown>, f = facility) => app.inject({ method: 'POST', url: `/investigations/${path}`, headers: asDevice(f.device.credential), payload: { actorStaffId: f.admin.id, ...body } });
  const definitions = async (f = facility) => (await recordsInFacility(db.sql, f.facility.id, 'service_definition')).filter((d) => d.investigation);
  before(async () => {
    db = await scratchDatabase(); app = testApp(db.sql);
    [facility, other] = [await registerScratchFacility(db.sql), await registerScratchFacility(db.sql)];
    for (const f of [facility, other]) {
      await insertRecord(db.sql, 'unit', { ...envelopeFor(f), id: f === facility ? 'unit:lab' : 'unit:other-lab', unitId: 'unit:lab', type: 'unit', name: 'Main laboratory' });
      await insertRecord(db.sql, 'location', { ...envelopeFor(f), id: f === facility ? 'location:lab' : 'location:other-lab', type: 'location', name: 'Laboratory room', kind: 'room' });
    }
  });
  after(async () => { await app?.close(); await db?.drop(); });

  it('lists the standard tests and adopts chosen ones with the server copy of their names and codes', async () => {
    const list = await post('standard-tests', {});
    assert.equal(list.statusCode, 200);
    const tests = list.json().tests as { key: string; added: boolean; loinc?: string }[];
    assert.ok(tests.length >= 30 && tests.every((t) => !t.added && !('loinc' in t)));
    const adopt = await post('standard-tests/adopt', { ...placement, keys: ['fbc', 'widal'] });
    assert.equal(adopt.statusCode, 200);
    assert.deepEqual(adopt.json(), { added: ['Full blood count', 'Widal test'], skipped: [] });
    const saved = await definitions();
    assert.deepEqual(saved.find((d) => d.name === 'Full blood count')?.concept, { system: 'http://loinc.org', code: '58410-2', label: 'Full blood count' });
    assert.deepEqual(saved.find((d) => d.name === 'Widal test')?.concept, { system: 'urn:geneus:standard-test', code: 'widal', label: 'Widal test' });
    const offerings = await recordsInFacility(db.sql, facility.facility.id, 'service_offering');
    assert.ok(saved.every((d) => offerings.some((o: ServiceOffering) => o.serviceDefinitionId === d.id && o.unitId === 'unit:lab' && o.configuration === 'active')));
    assert.ok((await post('standard-tests', {})).json().tests.find((t: { key: string; added: boolean }) => t.key === 'fbc').added);
  });

  it('skips duplicates by name or other name, including within one request, and changes nothing existing', async () => {
    const before = await definitions();
    const result = await post('tests', { ...placement, tests: [
      { name: 'Complete blood count', specimen: 'Blood', classification: 'Haematology', aliases: [] },
      { name: 'Antenatal panel', specimen: 'Blood and urine', classification: 'Antenatal', aliases: ['ANC panel'] },
      { name: 'anc  PANEL', specimen: 'Blood', classification: 'Antenatal', aliases: [] },
    ] });
    assert.deepEqual(result.json(), { added: ['Antenatal panel'], skipped: ['Complete blood count', 'anc  PANEL'] });
    const after = await definitions();
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after.find((d) => d.name === 'Antenatal panel')?.concept.system, 'local');
    assert.deepEqual(after.find((d) => d.name === 'Full blood count'), before.find((d) => d.name === 'Full blood count'));
    assert.deepEqual((await post('standard-tests/adopt', { ...placement, keys: ['fbc'] })).json(), { added: [], skipped: ['Full blood count'] });
  });

  it('refuses unknown standard keys, another facility\'s unit and staff without service management', async () => {
    assert.equal((await post('standard-tests/adopt', { ...placement, keys: ['not-a-test'] })).statusCode, 400);
    const foreign = await post('tests', { unitId: 'unit:other-lab', locationId: 'location:other-lab', tests: [{ name: 'Foreign test', specimen: 'Serum', classification: 'Chemistry' }] });
    assert.equal(foreign.statusCode, 400);
    const nurse = await addStaff(db.sql, facility, { role: 'nurse', permission: 'read_write' });
    const denied = await app.inject({ method: 'POST', url: '/investigations/standard-tests/adopt', headers: asDevice(facility.device.credential), payload: { actorStaffId: nurse.id, ...placement, keys: ['esr'] } });
    assert.equal(denied.statusCode, 403);
    assert.ok(!(await definitions()).some((d) => d.name.startsWith('Foreign') || d.name === 'Erythrocyte sedimentation rate'));
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
});
