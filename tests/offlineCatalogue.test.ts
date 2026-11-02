import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { FacilityRegistrationResult, ResultTemplate, StandardTemplate, StandardTest, UploadMutation } from '#shared';
import { insertRecord, findRecord } from '../src/db/records.ts';
import { recordsInFacility } from '../src/workforce/records.ts';
import { ensureAllStandardCatalogues } from '../src/clinical/standardCatalogue.ts';
import { STANDARD_TESTS } from '../src/clinical/standardTests.ts';
import { STANDARD_TEMPLATES } from '../src/clinical/standardTemplates.ts';
import { asDevice, clientId, envelopeFor, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

const versions = { clinicalWorkflowVersion: 1, resultTemplateWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: 13 } as const;

describe('catalogue and templates edited offline, checked on sync', () => {
  let db: ScratchDatabase, app: FastifyInstance, facility: FacilityRegistrationResult;
  const env = () => ({ ...envelopeFor(facility), schemaVersion: 5 });
  const send = (...mutations: UploadMutation[]) => upload(app, facility.device.credential, { ...versions, transactionId: clientId(), mutations });
  const put = (table: UploadMutation['table'], data: Record<string, unknown>): UploadMutation => ({ clientId: clientId(), op: 'put', table, id: String(data.id), data: { ...env(), type: table, revision: 1, ...data } });
  const patch = (table: UploadMutation['table'], id: string, expectedRevision: number, data: Record<string, unknown>): UploadMutation =>
    ({ clientId: clientId(), op: 'patch', table, id, expectedRevision, data: { ...data, revision: expectedRevision + 1, updatedBy: facility.admin.id, updatedOn: new Date().toISOString() } });
  const fbc = STANDARD_TESTS.find((t) => t.key === 'fbc')!;
  const fbcDefinition = { id: 'service_definition:fbc', name: fbc.name, category: 'laboratory', concept: { system: 'http://loinc.org', code: fbc.loinc, label: fbc.name }, orderable: true, active: true, investigation: { specimen: fbc.specimen, department: fbc.classification, aliases: fbc.aliases } };
  const offering = (definitionId: string) => ({ id: `service_offering:${definitionId}`, serviceDefinitionId: definitionId, unitId: 'unit:lab', name: definitionId, locationIds: ['location:lab'], delivery: 'physical', requiredActions: ['perform_test', 'record_result'], intakePolicy: 'both', timeZone: 'Africa/Lagos', configuration: 'active', resourceReadiness: 'available' });

  before(async () => {
    db = await scratchDatabase(); app = testApp(db.sql);
    facility = await registerScratchFacility(db.sql);
    await insertRecord(db.sql, 'unit', { ...envelopeFor(facility), id: 'unit:lab', unitId: 'unit:lab', type: 'unit', name: 'Laboratory' });
    await insertRecord(db.sql, 'location', { ...envelopeFor(facility), id: 'location:lab', type: 'location', name: 'Laboratory', kind: 'room' });
  });
  after(async () => { await app?.close(); await db?.drop(); });

  it('copies the standard lists into a facility when its device first syncs templates, and keeps them current at start-up', async () => {
    assert.equal((await recordsInFacility(db.sql, facility.facility.id, 'standard_test')).length, 0);
    const token = await app.inject({ method: 'POST', url: '/sync/token', headers: asDevice(facility.device.credential), payload: versions });
    assert.equal(token.statusCode, 200, token.body);
    assert.equal((await recordsInFacility(db.sql, facility.facility.id, 'standard_test')).length, STANDARD_TESTS.length);
    assert.equal((await recordsInFacility(db.sql, facility.facility.id, 'standard_template')).length, STANDARD_TEMPLATES.length);
    const id = `standard_test:${facility.facility.id}:fbc`;
    await db.sql`UPDATE standard_tests SET name = 'Tampered' WHERE id = ${id}`;
    await ensureAllStandardCatalogues(db.sql);
    assert.equal((await findRecord<StandardTest>(db.sql, 'standard_test', id))?.name, fbc.name);
  });

  it('accepts a standard test added offline exactly as listed, and refuses an altered copy or a duplicate name', async () => {
    const adopted = await send(put('service_definition', fbcDefinition), put('service_offering', offering(fbcDefinition.id)));
    assert.deepEqual(adopted.rejected, []);
    const altered = await send(put('service_definition', { ...fbcDefinition, id: 'service_definition:fbc2', name: 'Full blood count (edited)' }));
    assert.match(altered.rejected[0].reason, /exactly as the standard list/);
    const duplicate = await send(put('service_definition', { ...fbcDefinition, id: 'service_definition:own', name: 'cbc', concept: { system: 'local', code: 'service_definition:own', label: 'cbc' }, investigation: { specimen: 'Blood', department: 'Haematology', aliases: [] } }));
    assert.match(duplicate.rejected[0].reason, /already called “cbc”/);
    const own = await send(put('service_definition', { ...fbcDefinition, id: 'service_definition:ferritin', name: 'Serum ferritin', concept: { system: 'local', code: 'service_definition:ferritin', label: 'Serum ferritin' }, investigation: { specimen: 'Serum', department: 'Chemistry', aliases: [] } }));
    assert.deepEqual(own.rejected, []);
  });

  it('accepts templates, parts and lists edited offline, revision after revision, and refuses clashes into review', async () => {
    const list = { id: 'answer_list:reactivity', name: 'Reactivity', answers: ['Non-reactive', 'Reactive'], active: true };
    const template = { id: 'result_template:ferritin', name: 'Ferritin', status: 'active', source: 'own', serviceDefinitionIds: ['service_definition:ferritin'], parts: [{ key: 'ferritin', label: 'Ferritin', kind: 'number', unit: 'µg/L', decimals: 0, required: true, ranges: [] }] };
    assert.deepEqual((await send(put('answer_list', list), put('result_template', template))).rejected, []);
    // Two edits made offline, one after the other, arrive in order.
    const edits = await send(patch('result_template', template.id, 1, { name: 'Serum ferritin' }), patch('result_template', template.id, 2, { status: 'active' }));
    assert.deepEqual(edits.rejected, []);
    assert.equal((await findRecord<ResultTemplate>(db.sql, 'result_template', template.id))?.revision, 3);
    const [history] = await db.sql`SELECT count(*)::int AS n FROM result_template_versions WHERE source_id = ${template.id}`;
    assert.equal(history.n, 3);
    const stale = await send(patch('result_template', template.id, 1, { name: 'Stale edit' }));
    assert.equal(stale.rejected.length, 1);
    const clash = await send(put('result_template', { ...template, id: 'result_template:other', name: 'Other' }));
    assert.match(clash.rejected[0].reason, /already uses the template “Serum ferritin”/);
  });

  it('accepts a standard template adopted offline exactly as listed, linked to the adopted test, and refuses an altered one', async () => {
    const standard = (await recordsInFacility(db.sql, facility.facility.id, 'standard_template')).find((t) => t.key === 'fbc') as StandardTemplate;
    const adopted = { id: 'result_template:fbc', name: standard.name, status: 'active', source: 'standard', standardKey: 'fbc', serviceDefinitionIds: [fbcDefinition.id], parts: standard.parts };
    const altered = await send(put('result_template', { ...adopted, id: 'result_template:fbc-altered', parts: standard.parts.slice(1) }));
    assert.match(altered.rejected[0].reason, /exactly as the standard list/);
    assert.deepEqual((await send(put('result_template', adopted))).rejected, []);
    const again = await send(put('result_template', { ...adopted, id: 'result_template:fbc-again', serviceDefinitionIds: [] }));
    assert.match(again.rejected[0].reason, /already added/);
  });
});
