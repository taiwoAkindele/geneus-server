import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { authorizeStaff } from '../auth/staffAuthorization.ts';
import type { Sql } from '../db/client.ts';
import { recordsInFacility } from '../workforce/records.ts';
import { STANDARD_TESTS, standardConcept } from '../clinical/standardTests.ts';
import { addLabTests, CatalogueRefusal, takenTestKeys, testKey } from '../clinical/labCatalogue.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const Actor = z.object({ actorStaffId: text(200) });
const Placement = { unitId: text(200), locationId: text(200) };
const Adopt = Actor.extend({ ...Placement, keys: z.array(text(80)).min(1).max(STANDARD_TESTS.length) });
const OwnTests = Actor.extend({ ...Placement, tests: z.array(z.object({ name: text(200), specimen: text(200), classification: text(200), aliases: z.array(z.string().max(200)).max(50).default([]) })).min(1).max(500) });

/** The signed-in staff member, who must be allowed to manage this facility's services. */
const actor = async (sql: Sql, request: FastifyRequest, reply: FastifyReply) => {
  const identity = await authenticateDevice(sql, request, reply); if (!identity) return;
  const parsed = Actor.safeParse(request.body);
  if (!parsed.success) { await reply.code(400).send({ error: 'invalid_request', message: 'The acting staff member is required' }); return; }
  const permission = await authorizeStaff(sql, identity.facilityId, parsed.data.actorStaffId, 'service:manage');
  if ('denial' in permission) { await reply.code(403).send({ error: 'forbidden', message: 'Managing the investigation catalogue needs permission to manage services' }); return; }
  return { identity, staffId: parsed.data.actorStaffId };
};

/**
 * The lab test catalogue is changed only here, online, so every added test is
 * checked and de-duplicated by the server. Devices receive the new tests by sync.
 */
export const registerInvestigationRoutes = (app: FastifyInstance, sql: Sql) => {
  app.post('/investigations/standard-tests', async (request, reply) => {
    const who = await actor(sql, request, reply); if (!who) return;
    const taken = takenTestKeys(await recordsInFacility(sql, who.identity.facilityId, 'service_definition'));
    reply.header('cache-control', 'no-store');
    return { tests: STANDARD_TESTS.map(({ key, name, specimen, classification, aliases }) => ({ key, name, specimen, classification, aliases, added: [name, ...aliases].some((n) => taken.has(testKey(n))) })) };
  });

  app.post('/investigations/standard-tests/adopt', async (request, reply) => {
    const who = await actor(sql, request, reply); if (!who) return;
    const parsed = Adopt.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Choose the standard tests, unit and location' });
    const chosen = STANDARD_TESTS.filter((test) => parsed.data.keys.includes(test.key));
    if (chosen.length !== new Set(parsed.data.keys).size) return reply.code(400).send({ error: 'invalid_request', message: 'One or more chosen tests are not on the standard list' });
    try {
      return await sql.begin((tx) => addLabTests(tx, who.identity, who.staffId, chosen.map((test) => ({ name: test.name, specimen: test.specimen, classification: test.classification, aliases: test.aliases, concept: standardConcept(test) })), parsed.data, 'standard'));
    } catch (cause) {
      if (cause instanceof CatalogueRefusal) return reply.code(400).send({ error: 'invalid_request', message: cause.message });
      throw cause;
    }
  });

  app.post('/investigations/tests', async (request, reply) => {
    const who = await actor(sql, request, reply); if (!who) return;
    const parsed = OwnTests.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Each test needs a name, specimen and classification, with a unit and location' });
    try {
      return await sql.begin((tx) => addLabTests(tx, who.identity, who.staffId, parsed.data.tests, parsed.data, 'own'));
    } catch (cause) {
      if (cause instanceof CatalogueRefusal) return reply.code(400).send({ error: 'invalid_request', message: cause.message });
      throw cause;
    }
  });
};
