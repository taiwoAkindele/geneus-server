import { z } from 'zod';
import { AnswerListDraft, ResultPartDraft, ResultTemplateDraft } from '#shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { authorizeStaff } from '../auth/staffAuthorization.ts';
import type { Sql, Tx } from '../db/client.ts';
import { STANDARD_TEMPLATES } from '../clinical/standardTemplates.ts';
import {
  adoptStandardTemplates, createAnswerList, createPart, createTemplate, listStandardTemplates, TemplateRefusal,
  updateAnswerList, updatePart, updateTemplate, type TemplateActor,
} from '../clinical/resultTemplates.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const Actor = z.object({ actorStaffId: text(200) });
const Adopt = Actor.extend({ keys: z.array(text(80)).min(1).max(STANDARD_TEMPLATES.length) });
const revision = z.number().int().positive();
const Id = z.object({ id: text(200) });

/** The signed-in staff member, who must be allowed to manage result templates. */
const actor = async (sql: Sql, request: FastifyRequest, reply: FastifyReply): Promise<TemplateActor | undefined> => {
  const identity = await authenticateDevice(sql, request, reply); if (!identity) return;
  const parsed = Actor.safeParse(request.body);
  if (!parsed.success) { await reply.code(400).send({ error: 'invalid_request', message: 'The acting staff member is required' }); return; }
  const permission = await authorizeStaff(sql, identity.facilityId, parsed.data.actorStaffId, 'result_template:manage');
  if ('denial' in permission) { await reply.code(403).send({ error: 'forbidden', message: 'Managing result templates needs permission to manage result templates' }); return; }
  return { identity, staffId: parsed.data.actorStaffId };
};

/** Runs one change in a transaction; a refusal is the editor's to fix, not a server error. */
const save = async <T>(sql: Sql, reply: FastifyReply, change: (tx: Tx) => Promise<T>) => {
  try { return await sql.begin(change); } catch (cause) {
    if (cause instanceof TemplateRefusal) return reply.code(cause.status).send({ error: cause.status === 409 ? 'conflict' : cause.status === 404 ? 'not_found' : 'invalid_request', message: cause.message });
    throw cause;
  }
};
const invalid = (reply: FastifyReply, error: z.ZodError, fallback: string) =>
  reply.code(400).send({ error: 'invalid_request', message: error.issues[0]?.message ?? fallback });

/**
 * Result templates, shared parts and answer lists change only here, online, so
 * every change is checked by the server and kept as a revision. Devices receive
 * them by sync and enter results against them offline.
 */
export const registerResultTemplateRoutes = (app: FastifyInstance, sql: Sql) => {
  app.post('/result-templates/standard', async (request, reply) => {
    const who = await actor(sql, request, reply); if (!who) return;
    reply.header('cache-control', 'no-store');
    return { templates: await listStandardTemplates(sql, who.identity.facilityId) };
  });

  app.post('/result-templates/standard/adopt', async (request, reply) => {
    const who = await actor(sql, request, reply); if (!who) return;
    const parsed = Adopt.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Choose the standard templates to add' });
    if (parsed.data.keys.some((key) => !STANDARD_TEMPLATES.some((t) => t.key === key))) return reply.code(400).send({ error: 'invalid_request', message: 'One or more chosen templates are not on the standard list' });
    return save(sql, reply, (tx) => adoptStandardTemplates(tx, who, parsed.data.keys));
  });

  app.post('/result-templates', async (request, reply) => {
    const who = await actor(sql, request, reply); if (!who) return;
    const parsed = Actor.extend({ template: ResultTemplateDraft }).safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error, 'Check the template and try again');
    return save(sql, reply, (tx) => createTemplate(tx, who, parsed.data.template));
  });

  app.post<{ Params: { id: string } }>('/result-templates/:id', async (request, reply) => {
    const who = await actor(sql, request, reply); if (!who) return;
    const id = Id.safeParse(request.params), parsed = Actor.extend({ expectedRevision: revision, template: ResultTemplateDraft }).safeParse(request.body);
    if (!id.success || !parsed.success) return invalid(reply, (parsed.error ?? id.error)!, 'Check the template and try again');
    return save(sql, reply, (tx) => updateTemplate(tx, who, id.data.id, parsed.data.expectedRevision, parsed.data.template));
  });

  app.post('/result-parts', async (request, reply) => {
    const who = await actor(sql, request, reply); if (!who) return;
    const parsed = Actor.extend({ part: ResultPartDraft }).safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error, 'Check the part and try again');
    return save(sql, reply, (tx) => createPart(tx, who, parsed.data.part));
  });

  app.post<{ Params: { id: string } }>('/result-parts/:id', async (request, reply) => {
    const who = await actor(sql, request, reply); if (!who) return;
    const id = Id.safeParse(request.params), parsed = Actor.extend({ expectedRevision: revision, part: ResultPartDraft }).safeParse(request.body);
    if (!id.success || !parsed.success) return invalid(reply, (parsed.error ?? id.error)!, 'Check the part and try again');
    return save(sql, reply, (tx) => updatePart(tx, who, id.data.id, parsed.data.expectedRevision, parsed.data.part));
  });

  app.post('/answer-lists', async (request, reply) => {
    const who = await actor(sql, request, reply); if (!who) return;
    const parsed = Actor.extend({ list: AnswerListDraft }).safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error, 'Check the answer list and try again');
    return save(sql, reply, (tx) => createAnswerList(tx, who, parsed.data.list));
  });

  app.post<{ Params: { id: string } }>('/answer-lists/:id', async (request, reply) => {
    const who = await actor(sql, request, reply); if (!who) return;
    const id = Id.safeParse(request.params), parsed = Actor.extend({ expectedRevision: revision, list: AnswerListDraft }).safeParse(request.body);
    if (!id.success || !parsed.success) return invalid(reply, (parsed.error ?? id.error)!, 'Check the answer list and try again');
    return save(sql, reply, (tx) => updateAnswerList(tx, who, id.data.id, parsed.data.expectedRevision, parsed.data.list));
  });
};
