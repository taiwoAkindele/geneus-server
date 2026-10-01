import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { SCHEMA_VERSION, type ApiErrorBody } from '#shared';
import type { Sql } from './db/client.ts';
import type { Config } from './lib/config.ts';
import type { Signer } from './lib/signing.ts';
import { registerDeviceRoutes } from './routes/devices.ts';
import { registerFacilityRoutes } from './routes/facilities.ts';
import { registerStaffRoutes } from './routes/staff.ts';
import { registerSyncRoutes } from './routes/sync.ts';
import { createRateLimiter } from './lib/rateLimit.ts';

/**
 * The HTTP application, separate from the process that listens (server.ts) so
 * tests can drive it with `inject` against a scratch database and no port.
 */
export type AppDependencies = { config: Config; sql: Sql; signer: Signer };
/**
 * `rateLimit: false` is for tests that make many requests from one injected
 * address on purpose; tests/hardening.test.ts keeps it on to prove the limit.
 */
export type AppOptions = { logger?: boolean; rateLimit?: boolean };

/**
 * An invite token in a URL is as good as the invite until it is claimed, so it
 * never reaches the log. Everything else about the request is kept.
 */
const redactUrl = (url: string): string => url.replace(/^\/invites\/[^/?#]+/, '/invites/[redacted]');

const serializers = {
  req: (request: FastifyRequest) => ({
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
  }),
};

/**
 * The endpoints a caller can reach with no device credential, where a code or
 * token is the only secret: a guesser gets a handful of tries a minute per
 * address, a real person mistyping gets plenty.
 */
const RATE_LIMITED_ROUTES = new Set(['GET /invites/:token', 'POST /facilities', 'POST /devices']);
const RATE_LIMIT_PER_MINUTE = 10;

export const buildApp = ({ config, sql, signer }: AppDependencies, options: AppOptions = {}): FastifyInstance => {
  /**
   * Pretty printing is a terminal convenience, and `pino-pretty` is a dev
   * dependency the production image does not install — asking for it there
   * would crash the process at boot. Production logs raw JSON to stdout.
   * Tests switch logging off rather than pretty-print every injected request.
   */
  const logger =
    options.logger === false
      ? false
      : config.isProduction
        ? { serializers }
        : { serializers, transport: { target: 'pino-pretty' } };
  const app = Fastify({ logger, trustProxy: config.trustProxy });

  /**
   * A POST with `content-type: application/json` and no body (a token request
   * carries its credential in a header) is a 400 in Fastify's default parser,
   * before the route sees it. Treat an empty body as "no body" instead.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (cause) {
      done(cause as Error, undefined);
    }
  });

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

  if (options.rateLimit !== false) {
    const limiter = createRateLimiter(RATE_LIMIT_PER_MINUTE, 60_000);
    app.addHook('onRequest', async (request, reply) => {
      const route = `${request.method} ${request.routeOptions.url ?? ''}`;
      if (!RATE_LIMITED_ROUTES.has(route)) return;
      const retryAfter = limiter.hit(`${route} ${request.ip}`);
      if (retryAfter === undefined) return;
      request.log.warn({ route }, 'rate limited');
      return reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send({ error: 'rate_limited', message: `Too many attempts — try again in ${retryAfter} seconds` } satisfies ApiErrorBody);
    });
  }

  /**
   * Every response is JSON for a device, never a page to render or frame, and
   * often carries a credential or a token, so nothing may cache it.
   */
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cache-control', 'no-store');
    if (config.isProduction) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  });

  /**
   * A 5xx's own message can carry PostgreSQL's text or a stack detail, so the
   * caller gets a plain sentence and the log gets the error. A 4xx (a malformed
   * body, an oversized one) is the caller's to fix, so its message is kept.
   */
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(status).send({ error: 'internal_error', message: 'Something went wrong on the server — try again' } satisfies ApiErrorBody);
    }
    return reply.code(status).send({ error: error.code ?? 'bad_request', message: error.message || 'The request was not valid' } satisfies ApiErrorBody);
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
  app.get('/health', async (_request, reply) => {
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

    // 503 when degraded, so an uptime check that only reads the status code still notices.
    return reply.code(degraded ? 503 : 200).send({
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
    });
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
  registerStaffRoutes(app, sql);
  registerSyncRoutes(app, sql, config, signer);

  return app;
};
