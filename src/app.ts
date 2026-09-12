import Fastify, { type FastifyInstance } from 'fastify';
import { SCHEMA_VERSION } from '#shared';
import type { Sql } from './db/client.ts';
import type { Config } from './lib/config.ts';
import type { Signer } from './lib/signing.ts';
import { registerDeviceRoutes } from './routes/devices.ts';
import { registerFacilityRoutes } from './routes/facilities.ts';
import { registerSyncRoutes } from './routes/sync.ts';

/**
 * The HTTP application, separate from the process that listens (server.ts) so
 * tests can drive it with `inject` against a scratch database and no port.
 */
export type AppDependencies = { config: Config; sql: Sql; signer: Signer };
export type AppOptions = { logger?: boolean };

export const buildApp = ({ config, sql, signer }: AppDependencies, options: AppOptions = {}): FastifyInstance => {
  /**
   * Pretty printing is a terminal convenience, and `pino-pretty` is a dev
   * dependency the production image does not install — asking for it there
   * would crash the process at boot. Production logs raw JSON to stdout.
   * Tests switch logging off rather than pretty-print every injected request.
   */
  const logger =
    options.logger === false ? false : config.isProduction ? true : { transport: { target: 'pino-pretty' } };
  const app = Fastify({ logger });

  /**
   * The PWA is served from a different origin, so browsers preflight these
   * calls. Only the configured app origins are allowed — a handful of lines
   * instead of a dependency. `authorization` carries the device credential.
   */
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
      reply.header('access-control-allow-headers', 'content-type, authorization');
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });

  const startedOn = new Date().toISOString();

  /**
   * "Is it working?" has to be one URL, so this reports the state of each
   * thing the process is trusted for rather than just answering 200. The
   * signing key is here because an unset one is invisible otherwise: it signs
   * perfectly well, and only a restart reveals that every signature it issued
   * has become unverifiable.
   */
  app.get('/health', async () => {
    const reachable = await sql`SELECT 1`.then(
      () => true,
      () => false,
    );
    const degraded = !reachable || (config.isProduction && signer.isEphemeral);

    return {
      status: degraded ? 'degraded' : 'ok',
      postgres: reachable ? 'reachable' : 'unreachable',
      signingKey: {
        source: signer.isEphemeral ? 'ephemeral' : 'configured',
        fingerprint: signer.publicKeyFingerprint,
      },
      schemaVersion: SCHEMA_VERSION,
      startedOn,
    };
  });

  /**
   * The clock devices trust. A cheap phone's own clock is unreliable, and the
   * 7-day sync-or-freeze window depends on this being authoritative (root §4.3).
   */
  app.get('/time', async () => {
    const payload = { now: new Date().toISOString() };
    return { ...payload, signature: signer.sign(payload), publicKey: signer.publicKeyBase64 };
  });

  registerFacilityRoutes(app, sql, config);
  registerDeviceRoutes(app, sql, config);
  registerSyncRoutes(app, sql, config, signer);

  return app;
};
