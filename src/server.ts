import Fastify from 'fastify';
import nano from 'nano';
import { SCHEMA_VERSION } from '#shared';
import { loadConfig } from './lib/config.ts';
import { createSigner } from './lib/signing.ts';
import { ensureCors, ensureSystemDatabases } from './couch/provision.ts';
import { ensureInvitesDatabase } from './couch/invites.ts';
import { registerFacilityRoutes } from './routes/facilities.ts';

/**
 * The whole server: one process beside CouchDB. Sweeps (referral routing, the
 * not-yet-arrived watchdog) join this same process when Phase 2 starts — see
 * the evolution ladder in PLAN.md §6 before adding anything else.
 */
const config = loadConfig();
const signer = createSigner(config.signingPrivateKey);

/**
 * Pretty printing is a terminal convenience, and `pino-pretty` is a dev
 * dependency the production image does not install — asking for it there would
 * crash the process at boot. Production logs raw JSON to stdout, which is what
 * the debug map (PLAN.md §5) assumes you can grep.
 */
const app = Fastify({
  logger: config.isProduction ? true : { transport: { target: 'pino-pretty' } },
});

const couch = nano({
  url: config.couchUrl,
  requestDefaults: { auth: { username: config.couchUser, password: config.couchPassword } },
});

/**
 * The PWA is served from a different origin, so browsers preflight these calls.
 * Only the configured app origins are allowed — a handful of lines instead of a
 * dependency.
 */
app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'origin');
    reply.header('access-control-allow-headers', 'content-type');
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
  }
  if (request.method === 'OPTIONS') return reply.code(204).send();
});

const startedOn = new Date().toISOString();

/**
 * "Is it working?" has to be one URL (PLAN.md §5), so this reports the state of
 * each thing the process is trusted for rather than just answering 200. The
 * signing key is here because an unset one is invisible otherwise: it signs
 * perfectly well, and only a restart reveals that every signature it issued has
 * become unverifiable.
 */
app.get('/health', async () => {
  const reachable = await couch.info().then(
    () => true,
    () => false,
  );
  const degraded = !reachable || (config.isProduction && signer.isEphemeral);

  return {
    status: degraded ? 'degraded' : 'ok',
    couchdb: reachable ? 'reachable' : 'unreachable',
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

registerFacilityRoutes(app, couch, config);

const start = async () => {
  await ensureSystemDatabases(couch).catch((cause) => {
    app.log.error({ cause }, `could not prepare CouchDB at ${config.couchUrl} — is it running? (npm run couch:up)`);
    throw cause;
  });
  await ensureCors(couch, config.corsOrigins);
  await ensureInvitesDatabase(couch);
  if (signer.isEphemeral) {
    app.log.warn(
      { fingerprint: signer.publicKeyFingerprint },
      'no SIGNING_PRIVATE_KEY: generated an ephemeral key, so signatures change on restart',
    );
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });
};

start().catch((cause) => {
  app.log.error(cause);
  process.exit(1);
});
