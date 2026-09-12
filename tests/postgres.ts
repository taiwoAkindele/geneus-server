import { randomBytes } from 'node:crypto';
import { createSql, type Sql } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { loadConfig, type Config } from '../src/lib/config.ts';
import { createSigner, type Signer } from '../src/lib/signing.ts';
import { buildApp } from '../src/app.ts';
import { createInvite } from '../src/facilities/invites.ts';
import { registerFacility } from '../src/facilities/registration.ts';
import type { FacilityRegistrationResult } from '#shared';

/**
 * Tests that touch persistence run against real PostgreSQL in Docker, never a
 * mock: the constraints under test are enforced by PostgreSQL, so running them
 * anywhere else would prove nothing about production. Each test file gets its
 * own freshly migrated database and drops it afterwards, so files run in
 * parallel without seeing each other's rows.
 */
export const config: Config = loadConfig();

const TEST_DB_PREFIX = 'geneus_test_';

export type ScratchDatabase = { sql: Sql; url: string; drop: () => Promise<void> };

/**
 * A missing PostgreSQL is a setup problem, not a test failure, so it fails with
 * the command that fixes it instead of a connection stack trace.
 */
const requireAdmin = async (): Promise<Sql> => {
  const admin = createSql(config.postgresUrl);
  try {
    await admin`SELECT 1`;
  } catch {
    throw new Error(`PostgreSQL is not reachable at ${new URL(config.postgresUrl).host} — run: npm run db:up`);
  }
  return admin;
};

export const scratchDatabase = async (): Promise<ScratchDatabase> => {
  const admin = await requireAdmin();
  const name = `${TEST_DB_PREFIX}${randomBytes(4).toString('hex')}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(config.postgresUrl);
  url.pathname = `/${name}`;
  const sql = createSql(url.toString());
  await migrate(sql);

  return {
    sql,
    url: url.toString(),
    drop: async () => {
      await sql.end();
      const cleaner = createSql(config.postgresUrl);
      await cleaner.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleaner.end();
    },
  };
};

export const signer: Signer = createSigner(undefined);

/** The app under test: same construction as server.ts, no port, no log noise. */
export const testApp = (sql: Sql) => buildApp({ config, sql, signer }, { logger: false });

/** Uppercase and hyphenated so it satisfies the facility-code contract. */
export const scratchFacilityCode = (): string => `TEST-${randomBytes(3).toString('hex').toUpperCase()}`;

export const SYNC_ENDPOINT = 'http://127.0.0.1:8090';

/**
 * A registered facility with its admin and enrolled device — what almost every
 * persistence test needs first, since every row references a facility and a
 * device.
 */
export const registerScratchFacility = async (
  sql: Sql,
  overrides: { code?: string; deviceId?: string } = {},
): Promise<FacilityRegistrationResult> => {
  const code = overrides.code ?? scratchFacilityCode();
  const invite = await createInvite(sql, `Scratch ${code}`, 1);
  const outcome = await registerFacility(
    sql,
    {
      code,
      name: `Scratch ${code}`,
      state: 'Oyo',
      lga: 'Ibadan SW',
      level: 'phc',
      adminFullName: 'Test Admin',
      deviceId: overrides.deviceId ?? `device-${randomBytes(4).toString('hex')}`,
      inviteToken: invite.token,
    },
    SYNC_ENDPOINT,
  );
  if (!outcome.ok) throw new Error(`could not register scratch facility: ${outcome.error}`);
  return outcome.result;
};

/** The envelope for a record written by the facility's admin from its device. */
export const envelopeFor = (facility: FacilityRegistrationResult, createdOn = new Date().toISOString()) => ({
  facilityId: facility.facility.id,
  createdBy: facility.admin.id,
  createdOn,
  deviceId: facility.device.deviceId,
});

type PostgresError = { code?: string; constraint_name?: string; message?: string };

/**
 * Asserts PostgreSQL refused the statement and hands back the error, so each
 * test can prove *which* constraint fired rather than just that something failed.
 */
export const refusal = async (attempt: Promise<unknown>): Promise<PostgresError> => {
  const outcome = await attempt.then(
    () => undefined,
    (cause: PostgresError) => cause,
  );
  if (!outcome) throw new Error('expected PostgreSQL to refuse this statement, but it succeeded');
  return outcome;
};
