import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  Patient, labItemSummary, labPatientFacts, rangeFor, type FacilityRegistrationResult, type LabReport, type NumberPart, type ResultPart,
  type ResultTemplate, type UploadMutation,
} from '#shared';
import { recordsInFacility } from '../src/workforce/records.ts';
import { findRecord } from '../src/db/records.ts';
import { addStaff, asDevice, clientId, envelopeFor, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

const templateVersions = { clinicalWorkflowVersion: 1, resultTemplateWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: 13 } as const;

describe('server-owned result templates', () => {
  let db: ScratchDatabase, app: FastifyInstance, facility: FacilityRegistrationResult;
  const post = (path: string, body: Record<string, unknown>, actorStaffId = facility.admin.id) =>
    app.inject({ method: 'POST', url: path, headers: asDevice(facility.device.credential), payload: { actorStaffId, ...body } });
  const templates = () => recordsInFacility(db.sql, facility.facility.id, 'result_template');
  const testId = async (name: string) => (await recordsInFacility(db.sql, facility.facility.id, 'service_definition')).find((d) => d.name === name)!.id;
  const draft = (name: string, parts: unknown[], serviceDefinitionIds: string[] = [], status = 'active') => ({ name, status, parts, serviceDefinitionIds });
  const choice = { key: 'result', label: 'Result', kind: 'choice', answers: ['Negative', 'Positive'], required: true };

  before(async () => {
    db = await scratchDatabase(); app = testApp(db.sql);
    facility = await registerScratchFacility(db.sql);
    const tests = await post('/investigations/standard-tests/adopt', { keys: ['fbc', 'hiv-rapid', 'hbsag', 'widal'] });
    assert.equal(tests.statusCode, 200, tests.body);
  });
  after(async () => { await app?.close(); await db?.drop(); });

  it('adopts standard templates linked to the facility’s matching tests, and skips ones already adopted', async () => {
    const list = await post('/result-templates/standard', {});
    assert.equal(list.statusCode, 200, list.body);
    assert.ok(list.json().templates.every((t: { added: boolean }) => !t.added));
    const adopted = await post('/result-templates/standard/adopt', { keys: ['fbc', 'rapid-reactive', 'imaging'] });
    assert.deepEqual(adopted.json(), { added: ['Full blood count', 'Rapid test: Reactive / Non-reactive', 'Imaging report'], skipped: [] });
    const saved = await templates();
    assert.deepEqual(saved.find((t) => t.standardKey === 'fbc')?.serviceDefinitionIds, [await testId('Full blood count')]);
    assert.deepEqual(saved.find((t) => t.standardKey === 'rapid-reactive')?.serviceDefinitionIds.sort(), [await testId('HIV 1 and 2 rapid antibody test'), await testId('Hepatitis B surface antigen')].sort());
    assert.deepEqual(saved.find((t) => t.standardKey === 'imaging')?.serviceDefinitionIds, []);
    const [history] = await db.sql`SELECT count(*)::int AS n FROM result_template_versions WHERE facility_id = ${facility.facility.id}`;
    assert.equal(history.n, 3);
    assert.deepEqual((await post('/result-templates/standard/adopt', { keys: ['fbc'] })).json(), { added: [], skipped: ['Full blood count'] });
    assert.equal((await post('/result-templates/standard/adopt', { keys: ['not-a-template'] })).statusCode, 400);
  });

  it('saves each edit as a new revision, refuses a stale edit, and keeps a test on one template', async () => {
    const widal = await testId('Widal test');
    const created = await post('/result-templates', { template: draft('Febrile antigens', [choice], [widal]) });
    assert.equal(created.statusCode, 200, created.body);
    const { id } = created.json();
    const edited = await post(`/result-templates/${id}`, { expectedRevision: 1, template: draft('Febrile antigens (Widal)', [choice], [widal]) });
    assert.deepEqual(edited.json(), { id, revision: 2 });
    assert.equal((await post(`/result-templates/${id}`, { expectedRevision: 1, template: draft('Stale', [choice], [widal]) })).statusCode, 409);
    const clash = await post('/result-templates', { template: draft('Another Widal', [choice], [widal]) });
    assert.equal(clash.statusCode, 409);
    assert.match(clash.json().message, /already uses the template/);
    const draftWithTests = await post('/result-templates', { template: draft('Draft', [choice], [widal], 'draft') });
    assert.equal(draftWithTests.statusCode, 400);
    const [kept] = await db.sql`SELECT snapshot->>'name' AS name FROM result_template_versions WHERE source_id = ${id} AND revision = 1`;
    assert.equal(kept.name, 'Febrile antigens');
  });

  it('lets administrators and lab staff granted the permission manage templates, and no one else', async () => {
    const lab = await addStaff(db.sql, facility, { role: 'laboratory_staff', permission: 'read_write' });
    const manager = await addStaff(db.sql, facility, { role: 'laboratory_staff', permission: 'read_write', additionalPermissions: ['result_template:manage'] });
    assert.equal((await post('/result-templates', { template: draft('Lab draft', [choice], [], 'draft') }, lab.id)).statusCode, 403);
    assert.equal((await post('/result-templates', { template: draft('Lab draft', [choice], [], 'draft') }, manager.id)).statusCode, 200);
  });

  it('updates every template that uses a shared part or answer list, each as a new revision', async () => {
    const list = await post('/answer-lists', { list: { name: 'Reactivity', answers: ['Non-reactive', 'Reactive'] } });
    const listId = list.json().id;
    const part = await post('/result-parts', { part: { part: { key: 'reactivity', label: 'Reactivity', kind: 'choice', answers: ['Non-reactive', 'Reactive'], answerListId: listId } } });
    assert.equal(part.statusCode, 200, part.body);
    const glucose = await post('/result-parts', { part: { part: { key: 'glucose', label: 'Glucose', kind: 'number', unit: 'mmol/L', decimals: 1, ranges: [{ ageFrom: { value: 18, unit: 'years' }, low: 3.9, high: 5.5 }] } } });
    const made = await post('/result-templates', { template: draft('Screen', [
      { key: 'screen', label: 'ignored', kind: 'text', required: true, libraryPartId: part.json().id },
      { key: 'sugar', label: 'ignored', kind: 'text', libraryPartId: glucose.json().id },
    ]) });
    assert.equal(made.statusCode, 200, made.body);
    const saved = (await findRecord<ResultTemplate>(db.sql, 'result_template', made.json().id))!;
    assert.deepEqual(saved.parts.map((p) => [p.key, p.label, p.kind, p.required]), [['screen', 'Reactivity', 'choice', true], ['sugar', 'Glucose', 'number', false]]);
    await post(`/result-parts/${glucose.json().id}`, { expectedRevision: 1, part: { part: { key: 'glucose', label: 'Glucose', kind: 'number', unit: 'mmol/L', decimals: 1, ranges: [{ ageFrom: { value: 18, unit: 'years' }, low: 4, high: 5.6 }] } } });
    await post(`/answer-lists/${listId}`, { expectedRevision: 1, list: { name: 'Reactivity', answers: ['Non-reactive', 'Reactive', 'Indeterminate'] } });
    const after = (await findRecord<ResultTemplate>(db.sql, 'result_template', made.json().id))!;
    assert.equal(after.revision, 3);
    assert.deepEqual((after.parts[0] as Extract<ResultPart, { kind: 'choice' }>).answers, ['Non-reactive', 'Reactive', 'Indeterminate']);
    assert.equal((after.parts[1] as NumberPart).ranges[0].low, 4);
  });

  it('signs the result template claim only for clients on the current clinical workflow and policy', async () => {
    const token = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/sync/token', headers: asDevice(facility.device.credential), payload });
    assert.equal((await token({ resultTemplateWorkflowVersion: 1, clinicalWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: 12 })).statusCode, 409);
    const modern = await token(templateVersions);
    assert.equal(modern.statusCode, 200, modern.body);
    assert.equal(modern.json().resultTemplateWorkflowVersion, 1);
    assert.equal(JSON.parse(Buffer.from(modern.json().token.split('.')[1], 'base64url').toString()).result_template_workflow, 1);
  });

  it('accepts a structured result entered against its template for this patient, and refuses one that is not', async () => {
    const env = envelopeFor(facility), patientId = `${facility.facility.code}-000001-K2`, encounterId = 'encounter:fbc';
    const patient = Patient.parse({ ...env, id: patientId, type: 'patient', patientId, fullName: 'Synthetic patient', address: 'Synthetic address', sex: 'female', dateOfBirth: '1992-05-10' });
    const definition = (await recordsInFacility(db.sql, facility.facility.id, 'service_definition')).find((d) => d.name === 'Full blood count')!;
    const offering = (await recordsInFacility(db.sql, facility.facility.id, 'service_offering')).find((o) => o.serviceDefinitionId === definition.id)!;
    const item = { id: 'order_item:fbc', name: offering.name, serviceDefinitionId: definition.id, offeringId: offering.id, catalogueRevision: offering.revision, definitionRevision: definition.revision, priority: 'routine' };
    const entry = (id: string, step: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ ...env, id, type: 'encounter_entry', workflowVersion: 1, patientId, encounterId, actorRole: facility.admin.role, step, values, ...extra });
    const send = (all: Record<string, unknown>[]) => upload(app, facility.device.credential, { ...templateVersions, transactionId: clientId(), mutations: all.map((record): UploadMutation => ({ clientId: clientId(), op: 'put', table: record.type as UploadMutation['table'], id: String(record.id), data: record })) });
    const opened = await send([
      patient, { ...env, id: encounterId, type: 'encounter', patientId, workflowVersion: 1, openedOn: env.createdOn },
      entry('entry:vitals', 'vitals', { temperatureC: 37 }), entry('entry:complaint', 'complaint', { complaints: ['Tiredness'] }),
      entry('entry:order', 'lab_order', { tests: [item.name], items: [item] }), entry('entry:decision', 'investigation_review', { decision: 'ordered', orderEntryId: 'entry:order' }),
    ]);
    assert.deepEqual(opened.rejected, []);

    const template = (await templates()).find((t) => t.standardKey === 'fbc')!;
    const facts = labPatientFacts(patient, env.createdOn);
    const number = (key: string, value: number, flag?: string) => {
      const part = template.parts.find((p) => p.key === key) as NumberPart;
      return { kind: 'number' as const, key, value, ...(rangeFor(part, facts) ? { range: rangeFor(part, facts) } : {}), ...(flag ? { flag: flag as 'low' } : {}) };
    };
    const report = (values: LabReport['items'][number]['values']): LabReport => ({ patient: facts, items: [{ test: item.name, orderItemId: item.id, template: { id: template.id, revision: template.revision }, values }] });
    const results = (r: LabReport) => ({ results: r.items.map((i) => ({ test: i.test, orderItemId: i.orderItemId, result: labItemSummary(i, template.parts) })) });
    const good = report([number('haemoglobin', 10.8, 'low'), number('pcv', 33), number('wbc', 7.2), number('platelets', 98, 'low')]);

    const wrongRange = report([{ ...number('haemoglobin', 10.8), range: { sex: 'male', ageFrom: { value: 18, unit: 'years' }, low: 13, high: 17 } }, number('pcv', 33), number('wbc', 7.2), number('platelets', 98)]);
    const refused = await send([entry('entry:wrong', 'lab_results', results(wrongRange), { labReport: wrongRange })]);
    assert.match(refused.rejected[0]?.reason ?? '', /normal range shown does not match/);

    const accepted = await send([entry('entry:results', 'lab_results', results(good), { labReport: good })]);
    assert.deepEqual(accepted.rejected, []);
    const stored = (await findRecord<{ labReport?: LabReport }>(db.sql, 'encounter_entry', 'entry:results'))!;
    assert.equal(stored.labReport?.items[0].values[0].kind, 'number');

    const corrected = report([number('haemoglobin', 11.2, 'low'), number('pcv', 34), number('wbc', 7.2), number('platelets', 98, 'low')]);
    const amendment = await send([entry('entry:correction', 'amendment', { note: 'Repeat run', correctedValues: results(corrected) }, { amends: 'entry:results', labReport: corrected })]);
    assert.deepEqual(amendment.rejected, []);
  });
});
