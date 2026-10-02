import { buildApp } from './app.ts';
import { createSql } from './db/client.ts';
import { migrate } from './db/migrate.ts';
import { loadConfig } from './lib/config.ts';
import { createSigner } from './lib/signing.ts';
import { startRosterSigning, type RosterSigning } from './roster/rosterSigning.ts';

/**
 * The whole server: one process beside PostgreSQL and the PowerSync service.
 * Sweeps (roster signing now, referral routing later) run in this same
 * process — see the evolution ladder in PLAN.md before adding anything.
 */
const config = loadConfig();
const signer = createSigner(config.signingPrivateKey);
const sql = createSql(config.postgresUrl);
const app = buildApp({ config, sql, signer });
let rosterSigning: RosterSigning | undefined;

/** The URL carries the password; the log gets the host and database only. */
const describeDatabase = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname}`;
};

const start = async () => {
  const outcomes = await migrate(sql).catch((cause) => {
    app.log.error(
      { cause },
      `could not migrate PostgreSQL at ${describeDatabase(config.postgresUrl)} — is it running? (npm run db:up)`,
    );
    throw cause;
  });
  const applied = outcomes.filter((outcome) => outcome.outcome === 'applied');
  if (applied.length > 0) {
    app.log.info({ applied: applied.map((outcome) => `${outcome.version}_${outcome.name}`) }, 'migrations applied');
  }
  if (signer.isEphemeral) {
    app.log.warn(
      { fingerprint: signer.publicKeyFingerprint },
      'no SIGNING_PRIVATE_KEY: generated an ephemeral key, so signatures change on restart',
    );
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });
  rosterSigning = startRosterSigning(sql, signer, app.log);
};

/**
 * A container stop or redeploy sends SIGTERM. Requests in flight finish, the
 * signing pass in progress finishes, and only then does the pool close — so a
 * deploy never cuts an upload off halfway through its transaction.
 */
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await rosterSigning?.stop();
    await sql.end({ timeout: 5 });
    process.exit(0);
  } catch (cause) {
    app.log.error({ cause }, 'unclean shutdown');
    process.exit(1);
  }
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

start().catch((cause) => {
  app.log.error(cause);
  process.exit(1);
});
