import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorBody } from '#shared';
import type { Sql } from '../db/client.ts';
import { verifyCredential, type DeviceIdentity } from '../devices/credentials.ts';

/**
 * Every device-facing route starts here: the `Authorization: Bearer` header is
 * the device credential, and what comes out is the trusted device and facility
 * identity that the rest of the request reasons from. Nothing in the request
 * body can override it.
 *
 * The client learns only that it was refused. The reason — wrong secret,
 * revoked, wipe requested — goes to the log, where the debug map wants it.
 */
const UNAUTHORIZED: ApiErrorBody = { error: 'unauthorized', message: 'This device is not enrolled or its access has been revoked' };

const bearerOf = (request: FastifyRequest): string | undefined => {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  return scheme?.toLowerCase() === 'bearer' && token && rest.length === 0 ? token : undefined;
};

export const authenticateDevice = async (
  sql: Sql,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<DeviceIdentity | undefined> => {
  const credential = bearerOf(request);
  if (!credential) {
    await reply.code(401).send(UNAUTHORIZED);
    return undefined;
  }

  const outcome = await verifyCredential(sql, credential);
  if ('failure' in outcome) {
    // The device id is the part before the dot; logging it (and never the
    // secret) is what lets a refused device be found in `devices`.
    request.log.warn({ deviceId: credential.split('.')[0], failure: outcome.failure }, 'device credential refused');
    await reply.code(401).send(UNAUTHORIZED);
    return undefined;
  }

  return outcome.identity;
};

/**
 * Notes that the device was heard from. Returns the previous value, which is
 * what "how long had this device been out of contact" questions need.
 */
export const touchDevice = async (sql: Sql, deviceId: string): Promise<string | undefined> => {
  const [row] = await sql<{ previous: string | null }[]>`
    UPDATE devices AS d
    SET last_seen_on = now()
    FROM (SELECT id, last_seen_on FROM devices WHERE id = ${deviceId} FOR UPDATE) AS before
    WHERE d.id = before.id
    RETURNING before.last_seen_on AS previous`;
  return row?.previous ?? undefined;
};
