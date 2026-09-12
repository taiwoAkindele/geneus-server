import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  FacilityRegistrationResult,
  SyncTokenResponse,
  UploadResponse,
  type UploadMutation,
} from '#shared';
import { mintSyncToken } from '../src/auth/syncToken.ts';
import { createSql } from '../src/db/client.ts';
import { createInvite } from '../src/facilities/invites.ts';
import { createSigner } from '../src/lib/signing.ts';
import { loadConfig } from '../src/lib/config.ts';
import { readFirstCheckpoint, waitForRow, type SyncedRow } from './powersyncClient.ts';

/**
 * The stack test: geneus-server + the PowerSync service + PostgreSQL, over
 * real HTTP, the way a device meets them. Not part of `npm test` because it
 * needs `docker compose up -d` (PowerSync must reach this server's JWKS); run
 * it with `npm run test:sync`. It uses the development database, with scratch
 * facilities that are left behind.
 *
 * What it proves (migration plan §14):
 *   Facility A device → Facility A data
 *   Facility A device → cannot receive Facility B data
 *   Facility A device → cannot write Facility B data
 * plus the round trip upload → PostgreSQL → PowerSync → device, and that a
 * rejected write comes back down as a sync_rejection.
 */
const config = loadConfig();
const POWERSYNC_URL = process.env.POWERSYNC_URL ?? 'http://127.0.0.1:8090';
const SERVER_URL = process.env.GENEUS_URL ?? 'http://127.0.0.1:8080';

type Facility = FacilityRegistrationResult;

const json = async <T>(response: Response, parse: (input: unknown) => T): Promise<T> => {
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return parse(body);
};

const serverIsUp = async (): Promise<boolean> =>
  fetch(`${SERVER_URL}/health`).then(
    async (response) => response.ok && typeof ((await response.json()) as { schemaVersion?: unknown }).schemaVersion === 'number',
    () => false,
  );

describe('PowerSync stack', { timeout: 120_000 }, () => {
  const sql = createSql(config.postgresUrl);
  let server: ChildProcess | undefined;
  let a: Facility;
  let b: Facility;
  let tokenA: SyncTokenResponse;
  let tokenB: SyncTokenResponse;

  const register = async (): Promise<Facility> => {
    const code = `SYNC-${randomBytes(2).toString('hex').toUpperCase()}`;
    const invite = await createInvite(sql, `Stack test ${code}`, 1);
    return json(
      await fetch(`${SERVER_URL}/facilities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          name: `Stack test ${code}`,
          state: 'Oyo',
          lga: 'Ibadan SW',
          level: 'phc',
          adminFullName: 'Stack Admin',
          deviceId: `device-${code}`,
          inviteToken: invite.token,
        }),
      }),
      FacilityRegistrationResult.parse,
    );
  };

  const tokenFor = async (facility: Facility): Promise<SyncTokenResponse> =>
    json(
      await fetch(`${SERVER_URL}/sync/token`, { method: 'POST', headers: { authorization: `Bearer ${facility.device.credential}` } }),
      SyncTokenResponse.parse,
    );

  const uploadAs = async (facility: Facility, ...mutations: UploadMutation[]): Promise<UploadResponse> =>
    json(
      await fetch(`${SERVER_URL}/sync/upload`, {
        method: 'POST',
        headers: { authorization: `Bearer ${facility.device.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ transactionId: 1, mutations }),
      }),
      UploadResponse.parse,
    );

  const patientOf = (facility: Facility, sequence: string, overrides: Record<string, unknown> = {}): UploadMutation => {
    const id = `${facility.facility.id}-${sequence}-K2`;
    return {
      clientId: Math.floor(Math.random() * 1_000_000),
      op: 'put',
      table: 'patient',
      id,
      data: {
        id,
        type: 'patient',
        facilityId: facility.facility.id,
        createdBy: facility.admin.id,
        createdOn: new Date().toISOString(),
        deviceId: facility.device.deviceId,
        patientId: id,
        fullName: 'Amaka Okoro',
        address: 'Odo-Ona',
        sex: 'female',
        ageYears: 32,
        allergies: ['penicillin'],
        ...overrides,
      },
    };
  };

  const belongsTo = (facility: Facility) => (row: SyncedRow) => row.data.facilityId === facility.facility.id;

  before(async () => {
    if (!(await serverIsUp())) {
      server = spawn(process.execPath, ['src/server.ts'], {
        env: { ...process.env, PORT: new URL(SERVER_URL).port || '8080' },
        stdio: 'ignore',
      });
      for (let attempt = 0; attempt < 30 && !(await serverIsUp()); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.ok(await serverIsUp(), `geneus-server did not come up at ${SERVER_URL}`);
    }
    assert.ok(
      await fetch(`${POWERSYNC_URL}/probes/liveness`).then((response) => response.ok, () => false),
      `PowerSync is not reachable at ${POWERSYNC_URL} — run: docker compose up -d`,
    );

    [a, b] = await Promise.all([register(), register()]);
    [tokenA, tokenB] = await Promise.all([tokenFor(a), tokenFor(b)]);
    assert.equal(tokenA.syncEndpoint, config.powerSyncPublicUrl);
  });

  after(async () => {
    server?.kill();
    await sql.end();
  });

  it('delivers facility A its own facility, admin and device — and every bucket is A\'s', async () => {
    const { found, last } = await waitForRow(POWERSYNC_URL, tokenA.token, (row) => row.table === 'facilities' && row.id === a.facility.id);

    assert.ok(found, `facility ${a.facility.id} never arrived; got ${JSON.stringify(last.rows.map((row) => `${row.table}/${row.id}`))}`);
    assert.ok(last.rows.every(belongsTo(a)), 'a row from another facility was delivered');
    assert.ok(last.buckets.length > 0);
    assert.ok(last.buckets.every((bucket) => bucket.includes(`["${a.facility.id}"]`)), `buckets not partitioned by facility: ${last.buckets[0]}`);
    assert.ok(last.rows.some((row) => row.table === 'staff' && row.id === a.admin.id));
    assert.ok(last.rows.some((row) => row.table === 'devices' && row.id === a.device.deviceId));
  });

  it('never delivers facility B\'s rows to facility A\'s device, nor A\'s to B\'s', async () => {
    const [forA, forB] = await Promise.all([readFirstCheckpoint(POWERSYNC_URL, tokenA.token), readFirstCheckpoint(POWERSYNC_URL, tokenB.token)]);

    assert.equal(forA.rows.some((row) => row.id === b.facility.id || row.data.facilityId === b.facility.id), false);
    assert.equal(forB.rows.some((row) => row.id === a.facility.id || row.data.facilityId === a.facility.id), false);
    assert.ok(forB.rows.some((row) => row.table === 'facilities' && row.id === b.facility.id));
  });

  it('carries a patient uploaded from A to A\'s device, through PostgreSQL and PowerSync, and not to B\'s', async () => {
    const patient = patientOf(a, '000001');
    const uploaded = await uploadAs(a, patient);
    assert.deepEqual(uploaded.rejected, []);

    const { found } = await waitForRow(POWERSYNC_URL, tokenA.token, (row) => row.table === 'patients' && row.id === patient.id);
    const forB = await readFirstCheckpoint(POWERSYNC_URL, tokenB.token);

    assert.ok(found, 'the uploaded patient never reached the stream');
    assert.equal(found.data.fullName, 'Amaka Okoro');
    assert.equal(forB.rows.some((row) => row.id === patient.id), false);
  });

  it('delivers rows under their contract names, with lists as JSON text', async () => {
    const { found } = await waitForRow(POWERSYNC_URL, tokenA.token, (row) => row.table === 'patients');
    assert.ok(found);

    assert.ok('facilityId' in found.data && 'createdOn' in found.data && 'patientId' in found.data);
    assert.equal('facility_id' in found.data, false);
    assert.deepEqual(JSON.parse(String(found.data.allergies)), ['penicillin']);
  });

  it('refuses a write from A that claims to belong to B, and syncs the refusal back to A', async () => {
    const forged = patientOf(a, '000002', { facilityId: b.facility.id });

    const response = await uploadAs(a, forged);

    assert.equal(response.rejected[0]?.category, 'identity');
    const { found } = await waitForRow(POWERSYNC_URL, tokenA.token, (row) => row.table === 'sync_rejections' && row.data.entityId === forged.id);
    assert.ok(found, 'the rejection never synced back to the device');
    assert.equal(found.data.category, 'identity');
    const forB = await readFirstCheckpoint(POWERSYNC_URL, tokenB.token);
    assert.equal(forB.rows.some((row) => row.id === forged.id), false);
  });

  it('refuses a token signed by anyone but geneus-server', async () => {
    const forged = mintSyncToken(createSigner(undefined), {
      deviceId: a.device.deviceId,
      facilityId: b.facility.id,
      audience: config.powerSyncAudience,
      ttlSeconds: 60,
    });

    const result = await readFirstCheckpoint(POWERSYNC_URL, forged.token, 5000);

    assert.equal(result.status, 401);
    assert.deepEqual(result.rows, []);
  });
});
