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
   * thing the process depends on rather than just answering 200: PostgreSQL,
   * the PowerSync service, the signing key, and the reconcile queue — a growing
   * number of open rejections is the first sign that devices and server
   * disagree about something. The signing key is here because an unset one is
   * invisible otherwise: it signs perfectly well, and only a restart reveals
   * that every signature it issued has become unverifiable.
   */
  app.get('/health', async () => {
    const [postgres, powerSync, openRejections] = await Promise.all([
      sql`SELECT 1`.then(
        () => 'reachable' as const,
        () => 'unreachable' as const,
      ),
      fetch(`${config.powerSyncInternalUrl}/probes/liveness`, { signal: AbortSignal.timeout(2000) }).then(
        (response) => (response.ok ? ('reachable' as const) : ('unhealthy' as const)),
        () => 'unreachable' as const,
      ),
      sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sync_rejections WHERE resolved_on IS NULL`.then(
        ([row]) => row?.n ?? 0,
        () => undefined,
      ),
    ]);
    const degraded = postgres !== 'reachable' || powerSync !== 'reachable' || (config.isProduction && signer.isEphemeral);

    return {
      status: degraded ? 'degraded' : 'ok',
      postgres,
      powerSync,
      signingKey: {
        source: signer.isEphemeral ? 'ephemeral' : 'configured',
        fingerprint: signer.publicKeyFingerprint,
      },
      openRejections,
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
