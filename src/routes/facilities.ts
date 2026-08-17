import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type nano from 'nano';
import { z } from 'zod';
import { Facility, SCHEMA_VERSION, Staff } from '#shared';
import { databaseNameFor, facilityExists, provisionFacility } from '../couch/provision.ts';
import { claimInvite, findInvite, rejectionFor, releaseInvite } from '../couch/invites.ts';
import type { Config } from '../lib/config.ts';

/**
 * Facility registration is the one thing a device cannot do for itself: no
 * database exists yet and it holds no credential. Everything afterwards —
 * staff, rosters, patients — is an ordinary document written on the device and
 * carried up by replication, so it needs no endpoint here.
 */
const Registration = z.object({
  code: z
    .string()
    .min(2)
    .max(20)
    .regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/, 'Use uppercase letters, digits and hyphens'),
  name: z.string().min(1),
  state: z.string().min(1),
  lga: z.string().min(1),
  level: Facility.shape.level,
  adminFullName: z.string().min(1),
  deviceId: z.string().min(1),
  inviteToken: z.string().min(1),
});

const INVITE_REJECTIONS = {
  unknown: 'That invite code is not recognised',
  expired: 'That invite code has expired',
  already_used: 'That invite code has already been used',
} as const;

export const registerFacilityRoutes = (app: FastifyInstance, couch: nano.ServerScope, config: Config) => {
  /** Lets the onboarding screen reject a bad code before asking for any details. */
  app.get<{ Params: { token: string } }>('/invites/:token', async (request, reply) => {
    const invite = await findInvite(couch, request.params.token);
    const rejection = rejectionFor(invite);
    if (rejection || !invite) {
      return reply.code(404).send({ error: 'invalid_invite', message: INVITE_REJECTIONS[rejection ?? 'unknown'] });
    }
    return { label: invite.label, expiresOn: invite.expiresOn };
  });

  app.post('/facilities', async (request, reply) => {
    const parsed = Registration.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_registration', issues: parsed.error.issues });
    }
    const registration = parsed.data;

    const invite = await findInvite(couch, registration.inviteToken);
    const rejection = rejectionFor(invite);
    if (rejection || !invite) {
      return reply.code(403).send({ error: 'invalid_invite', message: INVITE_REJECTIONS[rejection ?? 'unknown'] });
    }

    if (await facilityExists(couch, registration.code)) {
      return reply.code(409).send({
        error: 'facility_code_taken',
        message: `Facility code ${registration.code} is already registered`,
      });
    }

    if (!(await claimInvite(couch, invite, registration.code))) {
      return reply.code(403).send({ error: 'invalid_invite', message: INVITE_REJECTIONS.already_used });
    }

    const credential = await provisionFacility(couch, registration.code).catch(async (cause) => {
      await releaseInvite(couch, invite.token);
      throw cause;
    });
    const facilityDb = couch.use(databaseNameFor(registration.code));
    const createdOn = new Date().toISOString();
    const envelope = {
      facilityId: registration.code,
      schemaVersion: SCHEMA_VERSION,
      createdBy: 'system',
      createdOn,
      deviceId: registration.deviceId,
    };

    const facility = Facility.parse({
      ...envelope,
      _id: registration.code,
      type: 'facility',
      code: registration.code,
      name: registration.name,
      state: registration.state,
      lga: registration.lga,
      level: registration.level,
    });

    const staffId = `staff:${randomUUID()}`;
    const admin = Staff.parse({
      ...envelope,
      _id: staffId,
      type: 'staff',
      staffId,
      fullName: registration.adminFullName,
      role: 'facility_admin',
      permission: 'read_write',
      active: true,
    });

    await facilityDb.insert(facility as never);
    await facilityDb.insert(admin as never);

    request.log.info({ facility: registration.code, database: credential.database }, 'facility provisioned');

    return reply.code(201).send({
      facility,
      admin,
      sync: {
        url: config.couchPublicUrl,
        database: credential.database,
        username: credential.username,
        password: credential.password,
      },
    });
  });
};
