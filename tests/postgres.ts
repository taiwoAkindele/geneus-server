import { pbkdf2Sync, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  Staff,
  type FacilityRegistrationResult,
  type Role,
  type StaffPermission,
  type UploadRequest,
  type UploadResponse,
  isConfigurationWrite,
} from '#shared';
import { createSql, type Sql } from '../src/db/client.ts';
import { migrate, type Migration } from '../src/db/migrate.ts';
import { insertRecord } from '../src/db/records.ts';
import { loadConfig, type Config } from '../src/lib/config.ts';
import { createSigner, type Signer } from '../src/lib/signing.ts';
import { buildApp } from '../src/app.ts';
import { createInvite } from '../src/facilities/invites.ts';
import { registerFacility } from '../src/facilities/registration.ts';
import { createVerificationCode, registrationSubject } from '../src/email/verifications.ts';
import type { EmailMessage, Mailer } from '../src/lib/email.ts';

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

export const scratchDatabase = async (migrations?: Migration[]): Promise<ScratchDatabase> => {
  const admin = await requireAdmin();
  const name = `${TEST_DB_PREFIX}${randomBytes(4).toString('hex')}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(config.postgresUrl);
  url.pathname = `/${name}`;
  const sql = createSql(url.toString());
  try { await migrate(sql, migrations); }
  catch (error) {
    await sql.end();
    const cleaner = createSql(config.postgresUrl);
    await cleaner.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleaner.end();
    throw error;
  }

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

/** Every email the app under test sent, newest last — the inbox tests read codes from. */
export const mailbox: EmailMessage[] = [];
const recordingMailer: Mailer = { configured: true, send: async (message) => void mailbox.push(message) };

/** The code in the newest email to `to` ("...code is 482193.") — what a person would read out of their inbox. */
export const lastCodeSentTo = (to: string, pattern = /code is (\w+)\./): string => {
  const message = [...mailbox].reverse().find((candidate) => candidate.to === to);
  const code = message?.text.match(pattern)?.[1];
  if (!code) throw new Error(`no code was emailed to ${to}`);
  return code;
};

/** The app under test: same construction as server.ts, no port, no log noise, no rate limit, mail kept in `mailbox`. */
const sqlForApp = new WeakMap<object, Sql>();
export const testApp = (sql: Sql) => { const app = buildApp({ config, sql, signer, mailer: recordingMailer }, { logger: false, rateLimit: false }); sqlForApp.set(app, sql); return app; };

/** A proven admin email for a registration, without the round trip through mail. */
export const verifiedEmailFor = async (sql: Sql, inviteToken: string, email = 'admin@example.org') => ({
  adminEmail: email,
  emailCode: (await createVerificationCode(sql, { purpose: 'registration', subject: registrationSubject(inviteToken), email })).code,
});

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
      ...(await verifiedEmailFor(sql, invite.token)),
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

/* ------------------------------------------------------------------ */
/* Upload-path fixtures                                                */
/* ------------------------------------------------------------------ */

/** A member of staff written straight into the facility, the way sync would have. */
export const addStaff = async (
  sql: Sql,
  facility: FacilityRegistrationResult,
  staff: { role: Role; permission?: StaffPermission; active?: boolean; name?: string; additionalRoles?: Role[]; additionalPermissions?: Staff['additionalPermissions']; loginAccess?: Staff['loginAccess'] },
): Promise<Staff> => {
  const id = `staff:${randomBytes(4).toString('hex')}`;
  const record = Staff.parse({
    ...envelopeFor(facility),
    id,
    type: 'staff',
    staffId: id,
    fullName: staff.name ?? `${staff.role} ${id}`,
    role: staff.role,
    additionalRoles: staff.additionalRoles,
    additionalPermissions: staff.additionalPermissions,
    loginAccess: staff.loginAccess,
    permission: staff.permission ?? 'read_write',
    active: staff.active ?? true,
  });
  await insertRecord(sql, 'staff', record);
  return record;
};

export const asDevice = (credential: string) => ({ authorization: `Bearer ${credential}` });

export const TEST_PIN = '135790';
const enrolled = new Set<string>();
/**
 * A PIN-proven staff session for a person on the facility's devices, as the
 * app opens one at sign-in. Opening it ends any other session on the device,
 * exactly as a shared device does. Undefined for staff who cannot sign in.
 */
const opening = new Map<string, Promise<string | undefined>>();
/** One sign-in at a time per person and device: two at once would end each other's session. */
export const staffSessionFor = (app: FastifyInstance, credential: string, staffId: string): Promise<string | undefined> => {
  const key = `${credential}:${staffId}`;
  const pending = opening.get(key) ?? openStaffSession(app, credential, staffId).finally(() => opening.delete(key));
  opening.set(key, pending);
  return pending;
};
const openStaffSession = async (app: FastifyInstance, credential: string, staffId: string): Promise<string | undefined> => {
  const sql = sqlForApp.get(app);
  if (!sql) throw new Error('staffSessionFor needs an app from testApp');
  if (!enrolled.has(staffId)) {
    const [staff] = await sql<{ facility_id: string }[]>`SELECT facility_id FROM staff WHERE id = ${staffId}`;
    if (!staff) return undefined;
    const salt = randomBytes(16).toString('base64');
    const hash = pbkdf2Sync(TEST_PIN, Buffer.from(salt, 'base64'), 210_000, 32, 'sha256').toString('base64');
    for (const { id } of await sql<{ id: string }[]>`SELECT id FROM devices WHERE facility_id = ${staff.facility_id}`) {
      await sql`INSERT INTO staff_device_pins (facility_id, staff_id, device_id, salt, hash, iterations, enrolled_by) VALUES (${staff.facility_id}, ${staffId}, ${id}, ${salt}, ${hash}, 210000, 'setup_code') ON CONFLICT DO NOTHING`;
    }
    enrolled.add(staffId);
  }
  const opened = await app.inject({ method: 'POST', url: '/staff/session', headers: asDevice(credential), payload: { staffId, pin: TEST_PIN } });
  const token = opened.statusCode === 200 ? opened.json().token as string : undefined;
  if (token) sessions.set(`${credential}:${staffId}`, token);
  return token;
};
const sessions = new Map<string, string>();

/**
 * Uploads as the device. Configuration goes online, as the app sends it: to
 * /config/save, in the name of the person it is attributed to, with their
 * PIN-proven session. Everything else goes through the offline sync queue.
 */
export const upload = async (
  app: FastifyInstance,
  credential: string,
  request: UploadRequest,
): Promise<UploadResponse> => {
  const isConfig = (m: UploadRequest['mutations'][number]) => isConfigurationWrite(m.table, m.op, Object.keys(m.data ?? {}));
  const configuration = request.mutations.filter(isConfig), operational = request.mutations.filter((m) => !isConfig(m));
  let applied = 0, duplicates = 0; const rejected: UploadResponse['rejected'] = []; let serverTime = new Date().toISOString();
  const byPerson = new Map<string, typeof configuration>();
  for (const m of configuration) { const by = String((m.op === 'put' ? m.data.createdBy : m.data.updatedBy) ?? ''); byPerson.set(by, [...(byPerson.get(by) ?? []), m]); }
  for (const [by, mutations] of byPerson) {
    // The person's open session if they still hold the device; signing in again only when someone else has since.
    let token = by ? sessions.get(`${credential}:${by}`) ?? await staffSessionFor(app, credential, by) : undefined;
    const used = token;
    const save = () => app.inject({ method: 'POST', url: token ? '/config/save' : '/sync/upload', headers: { ...asDevice(credential), ...(token ? { 'x-staff-session': token } : {}) }, payload: { ...request, mutations } });
    let response = await save();
    if (token && response.statusCode === 403 && response.json().error === 'staff_session_required') {
      // Someone else signed in on this device since; sign this person in again (once, shared by concurrent saves).
      token = sessions.get(`${credential}:${by}`) !== used ? sessions.get(`${credential}:${by}`) : await staffSessionFor(app, credential, by);
      response = await save();
    }
    if (!token) {
      if (response.statusCode !== 200) throw new Error(`upload returned ${response.statusCode}: ${response.body}`);
      const body = response.json() as UploadResponse; applied += body.applied; duplicates += body.duplicates; rejected.push(...body.rejected); serverTime = body.serverTime; continue;
    }
    if (response.statusCode === 200) { applied += response.json().applied; duplicates += response.json().duplicates; continue; }
    if (response.statusCode !== 409) throw new Error(`config save returned ${response.statusCode}: ${response.body}`);
    for (const r of response.json().details.rejected as { table: string; id: string; category: string; reason: string }[]) {
      const m = mutations.find((x) => x.table === r.table && x.id === r.id)!;
      rejected.push({ clientId: m.clientId, table: m.table, id: m.id, category: r.category as never, reason: r.reason });
    }
    applied += response.json().details.applied; duplicates += response.json().details.duplicates;
  }
  if (operational.length || !configuration.length) {
    const response = await app.inject({ method: 'POST', url: '/sync/upload', headers: asDevice(credential), payload: { ...request, mutations: operational } });
    if (response.statusCode !== 200) throw new Error(`upload returned ${response.statusCode}: ${response.body}`);
    const body = response.json() as UploadResponse; applied += body.applied; duplicates += body.duplicates; rejected.push(...body.rejected); serverTime = body.serverTime;
  }
  return { applied, duplicates, rejected, serverTime, ...(request.facilityContractVersion ? { facilityContractVersion: request.facilityContractVersion } : {}) } as UploadResponse;
};

let nextClientId = 1;
/** PowerSync numbers queued writes per device; tests just need them distinct. */
export const clientId = (): number => nextClientId++;
