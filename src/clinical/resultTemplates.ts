import { randomUUID } from 'node:crypto';
import { AnswerList, ResultPartDefinition, ResultTemplate, type AnswerListDraft, type ResultPart, type ResultPartDraft, type ResultTemplateDraft } from '#shared';
import type { z } from 'zod';
import type { DeviceIdentity } from '../devices/credentials.ts';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord, insertRecord, TABLE_FOR, toRow } from '../db/records.ts';
import { recordsInFacility } from '../workforce/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';
import { STANDARD_TEMPLATES, type StandardTemplate } from './standardTemplates.ts';
import { STANDARD_TESTS, standardConcept } from './standardTests.ts';

export class TemplateRefusal extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) { super(message); this.status = status; }
}
export type TemplateActor = { identity: DeviceIdentity; staffId: string };
type Saved = { id: string; revision: number };

const lockFacility = async (tx: Tx, facilityId: string) => {
  const [facility] = await tx`SELECT id FROM facilities WHERE id = ${facilityId} FOR UPDATE`;
  if (!facility) throw new TemplateRefusal('This facility was not found', 404);
};
const envelope = (who: TemplateActor, now: string) => ({ facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, createdBy: who.staffId, createdOn: now, schemaVersion: 5 });
/** A record that fails its contract is the editor's mistake, reported in its own words. */
const parsed = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new TemplateRefusal(result.error.issues[0]?.message ?? 'Check the template and try again');
  return result.data;
};
const current = async <T extends ResultTemplate | ResultPartDefinition | AnswerList>(tx: Tx, who: TemplateActor, type: T['type'], id: string, expectedRevision: number, what: string): Promise<T> => {
  const record = await findRecord<T>(tx, type, id);
  if (!record || record.facilityId !== who.identity.facilityId) throw new TemplateRefusal(`This ${what} was not found`, 404);
  if (record.revision !== expectedRevision) throw new TemplateRefusal(`This ${what} changed since you opened it. Reload it before saving again`, 409);
  return record;
};
const update = async (tx: Tx, record: ResultTemplate | ResultPartDefinition | AnswerList) => {
  await tx`UPDATE ${tx(TABLE_FOR[record.type])} SET ${tx(toRow(tx, record.type, record))} WHERE id = ${record.id} AND facility_id = ${record.facilityId}`;
};
const audit = (tx: Tx, who: TemplateActor, action: 'create' | 'update', entityType: 'result_template' | 'result_part' | 'answer_list', entityId: string, metadata: Record<string, unknown> = {}) =>
  recordAuditEvent(tx, { facilityId: who.identity.facilityId, deviceId: who.identity.deviceId, actorStaffId: who.staffId, action, entityType, entityId, metadata: { workflow: 'result_templates', ...metadata } });

type Library = { parts: Map<string, ResultPartDefinition>; lists: Map<string, AnswerList> };
const loadLibrary = async (tx: Tx, facilityId: string): Promise<Library> => ({
  parts: new Map((await recordsInFacility(tx, facilityId, 'result_part')).map((part) => [part.id, part])),
  lists: new Map((await recordsInFacility(tx, facilityId, 'answer_list')).map((list) => [list.id, list])),
});

/**
 * Parts linked to the shared library always carry the library's current content;
 * the template keeps only its own key and whether the part is required. Answers
 * linked to a shared list are copied from it the same way.
 */
const resolveParts = (parts: readonly ResultPart[], library: Library): ResultPart[] => parts.map((part) => {
  let resolved = part;
  if (part.libraryPartId) {
    const shared = library.parts.get(part.libraryPartId);
    if (!shared?.active) throw new TemplateRefusal(`${part.label}: this shared part is no longer available`);
    resolved = { ...shared.part, key: part.key, required: part.required, libraryPartId: shared.id };
  }
  if (resolved.kind === 'choice' && resolved.answerListId) {
    const list = library.lists.get(resolved.answerListId);
    if (!list?.active) throw new TemplateRefusal(`${resolved.label}: this answer list is no longer available`);
    resolved = { ...resolved, answers: list.answers };
  }
  return resolved;
});

/** "Used by" names this facility's active lab tests, and none already entered with another template. */
const checkTests = async (tx: Tx, facilityId: string, templateId: string | undefined, ids: readonly string[]) => {
  if (!ids.length) return;
  const tests = new Map((await recordsInFacility(tx, facilityId, 'service_definition')).filter((d) => d.active && d.investigation).map((d) => [d.id, d]));
  if (ids.some((id) => !tests.has(id))) throw new TemplateRefusal('One or more chosen tests are not in this facility’s catalogue');
  for (const other of await recordsInFacility(tx, facilityId, 'result_template')) {
    if (other.id === templateId || other.status !== 'active') continue;
    const taken = ids.filter((id) => other.serviceDefinitionIds.includes(id));
    if (taken.length) throw new TemplateRefusal(`${taken.map((id) => tests.get(id)!.name).join(', ')} already ${taken.length === 1 ? 'uses' : 'use'} the template “${other.name}”. Remove ${taken.length === 1 ? 'it' : 'them'} there first`, 409);
  }
};

const insertTemplate = async (tx: Tx, who: TemplateActor, draft: ResultTemplateDraft, library: Library, origin: { source: 'standard' | 'own'; standardKey?: string }) => {
  const template = parsed(ResultTemplate, { ...envelope(who, new Date().toISOString()), id: `result_template:${randomUUID()}`, type: 'result_template', ...draft, parts: resolveParts(draft.parts, library), ...origin, revision: 1 });
  await insertRecord(tx, 'result_template', template);
  await audit(tx, who, 'create', 'result_template', template.id, { source: origin.source });
  return template;
};

export const createTemplate = async (tx: Tx, who: TemplateActor, draft: ResultTemplateDraft): Promise<Saved> => {
  await lockFacility(tx, who.identity.facilityId);
  await checkTests(tx, who.identity.facilityId, undefined, draft.serviceDefinitionIds);
  const template = await insertTemplate(tx, who, draft, await loadLibrary(tx, who.identity.facilityId), { source: 'own' });
  return { id: template.id, revision: template.revision };
};

/** Each save is a new revision; results already published keep the revision they name. */
export const updateTemplate = async (tx: Tx, who: TemplateActor, id: string, expectedRevision: number, draft: ResultTemplateDraft): Promise<Saved> => {
  await lockFacility(tx, who.identity.facilityId);
  const saved = await current<ResultTemplate>(tx, who, 'result_template', id, expectedRevision, 'template');
  await checkTests(tx, who.identity.facilityId, id, draft.serviceDefinitionIds);
  const next = parsed(ResultTemplate, { ...saved, ...draft, parts: resolveParts(draft.parts, await loadLibrary(tx, who.identity.facilityId)), revision: saved.revision + 1, updatedBy: who.staffId, updatedOn: new Date().toISOString() });
  await update(tx, next);
  await audit(tx, who, 'update', 'result_template', id, { revision: next.revision });
  return { id, revision: next.revision };
};

/** A library change reaches every template that uses it, each as a new revision. */
const cascade = async (tx: Tx, who: TemplateActor, uses: (part: ResultPart) => boolean) => {
  const library = await loadLibrary(tx, who.identity.facilityId), now = new Date().toISOString();
  for (const template of await recordsInFacility(tx, who.identity.facilityId, 'result_template')) {
    if (!template.parts.some(uses)) continue;
    const next = parsed(ResultTemplate, { ...template, parts: resolveParts(template.parts, library), revision: template.revision + 1, updatedBy: who.staffId, updatedOn: now });
    await update(tx, next);
    await audit(tx, who, 'update', 'result_template', template.id, { revision: next.revision, cause: 'library' });
  }
};

export const createPart = async (tx: Tx, who: TemplateActor, draft: ResultPartDraft): Promise<Saved> => {
  await lockFacility(tx, who.identity.facilityId);
  const part = parsed(ResultPartDefinition, { ...envelope(who, new Date().toISOString()), id: `result_part:${randomUUID()}`, type: 'result_part', ...draft, revision: 1 });
  await insertRecord(tx, 'result_part', part);
  await audit(tx, who, 'create', 'result_part', part.id);
  return { id: part.id, revision: 1 };
};

export const updatePart = async (tx: Tx, who: TemplateActor, id: string, expectedRevision: number, draft: ResultPartDraft): Promise<Saved> => {
  await lockFacility(tx, who.identity.facilityId);
  const saved = await current<ResultPartDefinition>(tx, who, 'result_part', id, expectedRevision, 'shared part');
  const next = parsed(ResultPartDefinition, { ...saved, ...draft, revision: saved.revision + 1, updatedBy: who.staffId, updatedOn: new Date().toISOString() });
  await update(tx, next);
  await audit(tx, who, 'update', 'result_part', id, { revision: next.revision });
  await cascade(tx, who, (part) => part.libraryPartId === id);
  return { id, revision: next.revision };
};

export const createAnswerList = async (tx: Tx, who: TemplateActor, draft: AnswerListDraft): Promise<Saved> => {
  await lockFacility(tx, who.identity.facilityId);
  const list = parsed(AnswerList, { ...envelope(who, new Date().toISOString()), id: `answer_list:${randomUUID()}`, type: 'answer_list', ...draft, revision: 1 });
  await insertRecord(tx, 'answer_list', list);
  await audit(tx, who, 'create', 'answer_list', list.id);
  return { id: list.id, revision: 1 };
};

export const updateAnswerList = async (tx: Tx, who: TemplateActor, id: string, expectedRevision: number, draft: AnswerListDraft): Promise<Saved> => {
  await lockFacility(tx, who.identity.facilityId);
  const saved = await current<AnswerList>(tx, who, 'answer_list', id, expectedRevision, 'answer list');
  const next = parsed(AnswerList, { ...saved, ...draft, revision: saved.revision + 1, updatedBy: who.staffId, updatedOn: new Date().toISOString() });
  await update(tx, next);
  await audit(tx, who, 'update', 'answer_list', id, { revision: next.revision });
  // Shared parts copy a list's answers too: refresh them, then every template using the list either way.
  const usesList = (part: ResultPart) => part.kind === 'choice' && part.answerListId === id;
  const shared = (await recordsInFacility(tx, who.identity.facilityId, 'result_part')).filter((p) => usesList(p.part));
  for (const part of shared) {
    const refreshed = parsed(ResultPartDefinition, { ...part, part: { ...part.part, answers: next.answers }, revision: part.revision + 1, updatedBy: who.staffId, updatedOn: new Date().toISOString() });
    await update(tx, refreshed);
    await audit(tx, who, 'update', 'result_part', part.id, { revision: refreshed.revision, cause: 'answer_list' });
  }
  await cascade(tx, who, (part) => usesList(part) || shared.some((p) => p.id === part.libraryPartId));
  return { id, revision: next.revision };
};

/* ------------------------------------------------------------------ */
/* Standard templates                                                  */
/* ------------------------------------------------------------------ */

const sameConcept = (a: { system: string; code: string }, b: { system: string; code: string }) => a.system === b.system && a.code === b.code;
const standardTestNames = (template: StandardTemplate) => template.tests.map((key) => STANDARD_TESTS.find((test) => test.key === key)!.name);

export const listStandardTemplates = async (sql: Sql | Tx, facilityId: string) => {
  const adopted = new Set((await recordsInFacility(sql, facilityId, 'result_template')).flatMap((t) => t.standardKey ? [t.standardKey] : []));
  return STANDARD_TEMPLATES.map((template) => ({ key: template.key, name: template.name, parts: template.parts.length, tests: standardTestNames(template), added: adopted.has(template.key) }));
};

/**
 * Adds chosen standard templates, each linked to this facility's tests adopted from
 * the matching standard tests, unless another template already serves a test.
 * A template already adopted is skipped; nothing existing is changed.
 */
export const adoptStandardTemplates = async (tx: Tx, who: TemplateActor, keys: readonly string[]) => {
  await lockFacility(tx, who.identity.facilityId);
  const templates = await recordsInFacility(tx, who.identity.facilityId, 'result_template');
  const adopted = new Set(templates.flatMap((t) => t.standardKey ? [t.standardKey] : []));
  const claimed = new Set(templates.filter((t) => t.status === 'active').flatMap((t) => t.serviceDefinitionIds));
  const tests = (await recordsInFacility(tx, who.identity.facilityId, 'service_definition')).filter((d) => d.active && d.investigation);
  const library = await loadLibrary(tx, who.identity.facilityId), added: string[] = [], skipped: string[] = [];
  for (const standard of STANDARD_TEMPLATES.filter((t) => keys.includes(t.key))) {
    if (adopted.has(standard.key)) { skipped.push(standard.name); continue; }
    const concepts = standard.tests.map((key) => standardConcept(STANDARD_TESTS.find((test) => test.key === key)!));
    const linked = tests.filter((test) => !claimed.has(test.id) && concepts.some((concept) => sameConcept(concept, test.concept))).map((test) => test.id);
    linked.forEach((id) => claimed.add(id));
    await insertTemplate(tx, who, { name: standard.name, status: 'active', parts: standard.parts, serviceDefinitionIds: linked }, library, { source: 'standard', standardKey: standard.key });
    added.push(standard.name);
  }
  return { added, skipped };
};
