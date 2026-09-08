import { randomBytes } from 'node:crypto';
import nano from 'nano';
import { SCHEMA_VERSION } from '#shared';
import { loadConfig } from '../src/lib/config.ts';
import { databaseNameFor, ensureSystemDatabases } from '../src/couch/provision.ts';

/**
 * Tests that touch sync semantics run against real CouchDB in Docker, never a
 * mock (PLAN.md §7): the guard under test is executed by CouchDB's own JS
 * engine, so running it anywhere else would prove nothing about production.
 */
const config = loadConfig();

export const adminCouch = (): nano.ServerScope =>
  nano({
    url: config.couchUrl,
    requestDefaults: { auth: { username: config.couchUser, password: config.couchPassword } },
  });

/** A credential-scoped client — what a device holds after registration. */
export const deviceCouch = (username: string, password: string): nano.ServerScope =>
  nano({ url: config.couchUrl, requestDefaults: { auth: { username, password } } });

/**
 * A missing CouchDB is a setup problem, not a test failure, so it fails with
 * the command that fixes it instead of a connection stack trace.
 */
export const requireCouch = async (): Promise<nano.ServerScope> => {
  const couch = adminCouch();
  try {
    await couch.info();
  } catch {
    throw new Error(`CouchDB is not reachable at ${config.couchUrl} — run: npm run couch:up`);
  }
  // Provisioning writes into _users, which a fresh CouchDB does not have. The
  // server does this at boot; the suite must not depend on a server having run.
  await ensureSystemDatabases(couch);
  return couch;
};

/** Uppercase and hyphenated so it satisfies the facility-code contract. */
export const scratchFacilityCode = (): string => `TEST-${randomBytes(4).toString('hex').toUpperCase()}`;

export const envelopeFor = (facilityId: string) => ({
  facilityId,
  schemaVersion: SCHEMA_VERSION,
  createdBy: 'system',
  createdOn: new Date().toISOString(),
  deviceId: 'test-device',
});

/**
 * Cleanup runs after a failed assertion too, so it must not itself throw and
 * mask the real failure — a scratch database that was never created is the
 * expected case, not an error.
 */
export const removeFacility = async (couch: nano.ServerScope, facilityCode: string): Promise<void> => {
  await couch.db.destroy(databaseNameFor(facilityCode)).catch(() => undefined);
};

export const removeCredential = async (couch: nano.ServerScope, username: string): Promise<void> => {
  const users = couch.use('_users');
  const id = `org.couchdb.user:${username}`;
  const existing = await users.get(id).catch(() => undefined);
  if (existing) await users.destroy(id, existing._rev).catch(() => undefined);
};

type CouchError = { statusCode?: number; reason?: string };

/**
 * Asserts CouchDB refused the write and hands back the guard's reason, so each
 * test can prove *which* rule fired rather than just that something failed.
 */
export const rejectionReason = async (attempt: Promise<unknown>): Promise<string> => {
  const outcome = await attempt.then(
    () => undefined,
    (cause: CouchError) => cause,
  );
  if (!outcome) throw new Error('expected CouchDB to reject this write, but it succeeded');
  if (outcome.statusCode !== 403) {
    throw new Error(`expected a 403 from validate_doc_update, got ${outcome.statusCode}: ${outcome.reason}`);
  }
  return outcome.reason ?? '';
};
