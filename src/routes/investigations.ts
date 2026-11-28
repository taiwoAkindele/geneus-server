import { z } from 'zod';
import { LaboratoryTestInput, laboratorySpecimenLabel, staffPermissions } from '#shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { authorizeStaff } from '../auth/staffAuthorization.ts';
import { verifiedRequestStaff } from '../auth/staffSessions.ts';
import type { Sql } from '../db/client.ts';
import { recordsInFacility } from '../workforce/records.ts';
import { STANDARD_TESTS, standardConcept } from '../clinical/standardTests.ts';
import {
  addLabTests,
  CatalogueRefusal,
  retireLaboratoryTest,
  takenTestKeys,
  testKey,
} from '../clinical/labCatalogue.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const Actor = z.object({ actorStaffId: text(200) });
const Adopt = Actor.extend({ keys: z.array(text(80)).min(1).max(STANDARD_TESTS.length) });

const OwnTests = Actor.extend({
  tests: z
    .array(
      z.object({
        name: text(200),
        specimen: text(200),
        classification: text(200),
        aliases: z.array(z.string().max(200)).max(50).default([]),
      }),
    )
    .min(1)
    .max(500),
});

/** The signed-in staff member, who must be allowed to manage this facility's services. */
const actor = async (sql: Sql, request: FastifyRequest, reply: FastifyReply) => {
  const identity = await authenticateDevice(sql, request, reply);

  if (!identity) {
    return;
  }

  const parsed = Actor.safeParse(request.body);

  if (!parsed.success) {
    await reply
      .code(400)
      .send({ error: 'invalid_request', message: 'The acting staff member is required' });

    return;
  }

  const permission = await authorizeStaff(
    sql,
    identity.facilityId,
    parsed.data.actorStaffId,
    'service:manage',
  );

  if ('denial' in permission) {
    await reply.code(403).send({
      error: 'forbidden',
      message: 'Managing the investigation catalogue needs permission to manage services',
    });

    return;
  }

  return { identity, staffId: parsed.data.actorStaffId };
};

const verifiedLabActor = async (sql: Sql, request: FastifyRequest, reply: FastifyReply) => {
  const identity = await authenticateDevice(sql, request, reply);

  if (!identity) {
    return;
  }

  const staff = await verifiedRequestStaff(sql, identity, request.headers);
  const permissions = staff ? staffPermissions(staff) : [];

  if (!staff || !permissions.includes('service:manage')) {
    await reply.code(403).send({
      error: staff ? 'forbidden' : 'staff_session_required',
      message: 'Confirm a staff session with permission to manage the Laboratory catalogue',
    });
    return;
  }

  const assertedStaff = request.headers['x-actor-staff-id'];

  if (assertedStaff !== undefined && assertedStaff !== staff.id) {
    await reply
      .code(403)
      .send({ error: 'attribution_mismatch', message: 'Use your own verified staff session' });
    return;
  }

  return { identity, staff, permissions };
};

/** Classified setup is server-confirmed; legacy routes remain available to older clients. */
export const registerInvestigationRoutes = (app: FastifyInstance, sql: Sql) => {
  app.post('/investigations/catalogue', async (request, reply) => {
    const who = await verifiedLabActor(sql, request, reply);

    if (!who) {
      return;
    }

    const { identity, staff, permissions } = who;
    const parsed = z
      .object({ tests: z.array(LaboratoryTestInput).min(1).max(500) })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Review specimen and pricing choices before saving',
      });
    }

    if (
      parsed.data.tests.some(({ resultTemplateId }) => resultTemplateId) &&
      !permissions.includes('result_template:manage')
    ) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'Linking a result template requires template management permission',
      });
    }

    try {
      const tests = parsed.data.tests.map((test) => {
        const standard = STANDARD_TESTS.find(({ key }) => key === test.standardKey);

        if (test.standardKey && !standard) {
          throw new CatalogueRefusal('A selected standard test is no longer available');
        }

        // The standard list already states whether its specimen types are alternatives or required together.
        let standardRule: 'all' | 'any' | undefined;
        if (standard?.specimen.includes(' and ')) {
          standardRule = 'all';
        } else if (standard?.specimen.includes(' or ')) {
          standardRule = 'any';
        }
        const catalogue = standard
          ? {
              ...test.catalogue,
              specimenTypes: standard.specimen.split(standardRule === 'all' ? ' and ' : ' or '),
              specimenRequirement: standardRule,
            }
          : test.catalogue;

        return {
          name: standard?.name ?? test.name,
          specimen: laboratorySpecimenLabel(catalogue),
          classification: standard?.classification ?? test.department,
          aliases: standard?.aliases ?? test.aliases,
          concept: standard ? standardConcept(standard) : undefined,
          catalogue,
          resultTemplateId: test.resultTemplateId,
        };
      });

      return await sql.begin((tx) => addLabTests(tx, identity, staff.id, tests, 'classified'));
    } catch (cause) {
      if (cause instanceof CatalogueRefusal) {
        return reply.code(409).send({ error: 'catalogue_conflict', message: cause.message });
      }

      throw cause;
    }
  });

  app.post('/investigations/catalogue/retire', async (request, reply) => {
    const who = await verifiedLabActor(sql, request, reply);

    if (!who) {
      return;
    }

    const parsed = z
      .object({ definitionId: text(200), revision: z.number().int().positive() })
      .safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'Choose a current Laboratory test to retire' });
    }

    try {
      await sql.begin((tx) =>
        retireLaboratoryTest(
          tx,
          who.identity,
          who.staff.id,
          parsed.data.definitionId,
          parsed.data.revision,
        ),
      );
      return { retired: true };
    } catch (cause) {
      if (cause instanceof CatalogueRefusal) {
        return reply.code(409).send({ error: 'catalogue_conflict', message: cause.message });
      }
      throw cause;
    }
  });

  app.post('/investigations/standard-tests', async (request, reply) => {
    const who = await actor(sql, request, reply);

    if (!who) {
      return;
    }

    const taken = takenTestKeys(
      await recordsInFacility(sql, who.identity.facilityId, 'service_definition'),
    );

    reply.header('cache-control', 'no-store');

    return {
      tests: STANDARD_TESTS.map(({ key, name, specimen, classification, aliases }) => ({
        key,
        name,
        specimen,
        classification,
        aliases,
        added: [name, ...aliases].some((n) => taken.has(testKey(n))),
      })),
    };
  });

  app.post('/investigations/standard-tests/adopt', async (request, reply) => {
    const who = await actor(sql, request, reply);

    if (!who) {
      return;
    }

    const parsed = Adopt.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'Choose the standard tests to add' });
    }

    const chosen = STANDARD_TESTS.filter((test) => parsed.data.keys.includes(test.key));

    if (chosen.length !== new Set(parsed.data.keys).size) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'One or more chosen tests are not on the standard list',
      });
    }

    try {
      return await sql.begin((tx) =>
        addLabTests(
          tx,
          who.identity,
          who.staffId,
          chosen.map((test) => ({
            name: test.name,
            specimen: test.specimen,
            classification: test.classification,
            aliases: test.aliases,
            concept: standardConcept(test),
          })),
          'standard',
        ),
      );
    } catch (cause) {
      if (cause instanceof CatalogueRefusal) {
        return reply.code(400).send({ error: 'invalid_request', message: cause.message });
      }

      throw cause;
    }
  });

  app.post('/investigations/tests', async (request, reply) => {
    const who = await actor(sql, request, reply);

    if (!who) {
      return;
    }

    const parsed = OwnTests.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Each test needs a name, specimen and classification',
      });
    }

    try {
      return await sql.begin((tx) =>
        addLabTests(tx, who.identity, who.staffId, parsed.data.tests, 'own'),
      );
    } catch (cause) {
      if (cause instanceof CatalogueRefusal) {
        return reply.code(400).send({ error: 'invalid_request', message: cause.message });
      }

      throw cause;
    }
  });
};
