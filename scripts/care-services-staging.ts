/**
 * Local care-services staging stack: the real geneus-server and a real
 * PowerSync service over disposable PostgreSQL databases (geneus_test_*), with a
 * synthetic hospital whose lab tests are already in its catalogue. The real web
 * app (geneus-web/qa/care-services-staging-browser.mjs) then runs the hospital
 * setup, booking, registration, visit and reporting flow against it.
 *
 *   POSTGRES_URL=postgres://geneus:devpassword@127.0.0.1:5433/geneus node scripts/care-services-staging.ts <handoff.json>
 *
 * Refuses any non-local database. Its own ports and container, so it can run
 * beside the insurance staging stack. Stop with Ctrl+C; the container and
 * databases are removed. A read-only inspector reports what the server holds.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { POLICY_VERSION } from '#shared';
import { buildApp } from '../src/app.ts';
import { buildSyncConfig } from '../src/sync/syncConfig.ts';
import { insertRecord } from '../src/db/records.ts';
import { issueEnrollmentCode } from '../src/devices/enrollment.ts';
import { issuePinSetupCode } from '../src/staff/pinSetupCodes.ts';
import {
  config,
  signer,
  addStaff,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
} from '../tests/postgres.ts';
import { readFirstCheckpoint } from '../tests/powersyncClient.ts';

const exec = promisify(execFile);
const handoffPath = process.argv[2];
assert.ok(
  handoffPath?.endsWith('.json'),
  'Usage: node scripts/care-services-staging.ts <handoff.json>',
);

assert.equal(
  new URL(config.postgresUrl).hostname,
  '127.0.0.1',
  'Use the local disposable PostgreSQL (docker compose up -d postgres)',
);

const API = 18280;
const SYNC = 18290;
const INSPECT = 18281;
const WEB = 'http://127.0.0.1:5197';
const endpoint = `http://127.0.0.1:${SYNC}`;
const source = await scratchDatabase();
const storage = await scratchDatabase();

const app = buildApp(
  {
    sql: source.sql,
    signer,
    mailer: { configured: true, send: async () => {} },
    config: {
      ...config,
      powerSyncPublicUrl: endpoint,
      powerSyncInternalUrl: endpoint,
      corsOrigins: [WEB, 'http://localhost:5197'],
    },
  },
  { logger: { level: 'warn' }, rateLimit: false },
);

const container = 'geneus-care-services-staging';
let started = false;

const cleanup = async () => {
  if (started) {
    await exec('docker', ['rm', '-f', container], { windowsHide: true }).catch(() => {});
  }

  await app.close().catch(() => {});
  await source.drop().catch(() => {});
  await storage.drop().catch(() => {});
};

process.on('SIGINT', () => void cleanup().then(() => process.exit(0)));
process.on('SIGTERM', () => void cleanup().then(() => process.exit(0)));

const CURRENT = {
  careServiceVersion: 1,
  insuranceWorkflowVersion: 1,
  clinicalWorkflowVersion: 1,
  facilityContractVersion: 1,
  schemaVersion: 5,
  policyVersion: POLICY_VERSION,
  pendingMutationCount: 0,
};

try {
  await app.listen({ port: API, host: '0.0.0.0' });
  await writeFile(resolve('powersync/sync-config.yaml'), buildSyncConfig());

  const inside = (url: string) => {
    const v = new URL(url);
    v.hostname = 'host.docker.internal';

    return v.toString();
  };

  await exec('docker', ['rm', '-f', container], { windowsHide: true }).catch(() => {});
  await exec(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      container,
      '--publish',
      `127.0.0.1:${SYNC}:8080`,
      '--add-host',
      'host.docker.internal:host-gateway',
      '--mount',
      `type=bind,source=${resolve('powersync')},target=/config,readonly`,
      '--env',
      'POWERSYNC_CONFIG_PATH=/config/service.yaml',
      '--env',
      `PS_SOURCE_URI=${inside(source.url)}`,
      '--env',
      `PS_STORAGE_URI=${inside(storage.url)}`,
      '--env',
      'PS_SSLMODE=disable',
      '--env',
      `PS_JWKS_URI=http://host.docker.internal:${API}/.well-known/jwks.json`,
      '--env',
      'PS_JWT_AUDIENCE=powersync',
      '--env',
      'PS_PORT=8080',
      'journeyapps/powersync-service:1.26.0',
      'start',
      '-r',
      'unified',
    ],
    { windowsHide: true, timeout: 60000 },
  );

  started = true;
  let healthy = false;

  for (let i = 0; i < 120 && !healthy; i++) {
    healthy = await fetch(endpoint + '/probes/readiness').then(
      (r) => r.ok,
      () => false,
    );

    if (!healthy) {
      await new Promise((d) => setTimeout(d, 500));
    }
  }

  assert.ok(healthy, 'PowerSync did not become ready');

  // A synthetic hospital as registration leaves it: name, code, state, LGA, level; nothing else set.
  const f = await registerScratchFacility(source.sql);

  const people = {} as Record<
    'admin' | 'desk' | 'doctor',
    { id: string; name: string; pinCode: string }
  >;

  for (const [key, role, name] of [
    ['admin', 'facility_admin', 'Ada Admin'],
    ['desk', 'records_officer', 'Dele Desk'],
    ['doctor', 'doctor', 'Dayo Doctor'],
  ] as const) {
    const staff = await addStaff(source.sql, f, { role, name, loginAccess: 'always' });

    const pin = await issuePinSetupCode(source.sql, {
      facilityId: f.facility.id,
      staffId: staff.id,
      issuedBy: f.admin.id,
      issuedFrom: f.device.deviceId,
    });

    assert.ok(pin.ok, `PIN code for ${name}`);
    people[key] = { id: staff.id, name, pinCode: pin.code };
  }

  // Teams, places and a lab catalogue already set up (each test is an offering, as the catalogue makes it).
  const env = { ...envelopeFor(f), schemaVersion: 4 };
  await insertRecord(source.sql, 'unit', {
    ...env,
    id: 'unit:opd',
    unitId: 'unit:opd',
    type: 'unit',
    name: 'Outpatients',
    active: true,
    kind: 'unit',
    revision: 1,
  });

  await insertRecord(source.sql, 'unit', {
    ...env,
    id: 'unit:lab',
    unitId: 'unit:lab',
    type: 'unit',
    name: 'Laboratory',
    active: true,
    kind: 'unit',
    revision: 1,
  });

  for (const [id, name, kind, unitId, parentId] of [
    ['location:c1', 'Consulting room 1', 'room', 'unit:opd'],
    ['location:lab', 'Laboratory', 'room', 'unit:lab'],
    ['location:fw', 'Female ward', 'ward', undefined],
    ['location:fw1', 'FW-01', 'bed', undefined, 'location:fw'],
  ] as const) {
    await insertRecord(source.sql, 'location', {
      ...env,
      id,
      type: 'location',
      name,
      kind,
      active: true,
      revision: 1,
      ...(unitId ? { unitId } : {}),
      ...(parentId ? { parentId } : {}),
    });
  }

  for (const [key, name] of [
    ['hb', 'Haemoglobin'],
    ['fbc', 'Full blood count'],
    ['hcv', 'Hepatitis C antibody'],
  ] as const) {
    await insertRecord(source.sql, 'service_definition', {
      ...env,
      id: `def:${key}`,
      type: 'service_definition',
      name,
      category: 'laboratory',
      concept: { system: 'local', code: key, label: name },
      orderable: true,
      active: true,
      revision: 1,
      investigation: { specimen: 'Blood', department: 'Haematology', aliases: [] },
    });

    await insertRecord(source.sql, 'service_offering', {
      ...env,
      id: `offering:${key}`,
      type: 'service_offering',
      serviceDefinitionId: `def:${key}`,
      unitId: 'unit:lab',
      name,
      locationIds: ['location:lab'],
      delivery: 'physical',
      requiredActions: ['perform_test', 'record_result'],
      intakePolicy: 'both',
      timeZone: 'Africa/Lagos',
      configuration: 'active',
      resourceReadiness: 'available',
      revision: 1,
      visitTypes: [],
    });
  }

  const fees = { ...envelopeFor(f), schemaVersion: 5 };
  await insertRecord(source.sql, 'fee_item', {
    ...fees,
    id: 'fee:consultation',
    type: 'fee_item',
    name: 'Consultation',
    category: 'consultation',
    amountMinor: 200_000,
    currency: 'NGN',
    chargeWhen: 'every_visit',
    exemptions: [{ reason: 'Antenatal policy', visitTypes: ['antenatal'] }],
  });

  const patientId = `${f.facility.id}-000001-K2`;
  await insertRecord(source.sql, 'patient', {
    ...fees,
    id: patientId,
    patientId,
    type: 'patient',
    fullName: 'Amaka Synthetic',
    address: 'Synthetic address',
    sex: 'female',
    ageYears: 34,
  });

  const enrollment = await issueEnrollmentCode(
    source.sql,
    f.facility.id,
    f.admin.id,
    f.device.deviceId,
  );

  let streaming = false;

  for (let i = 0; i < 120 && !streaming; i++) {
    const t = await fetch(`http://127.0.0.1:${API}/sync/token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${f.device.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(CURRENT),
    }).then((r) => r.json());

    const checkpoint = await readFirstCheckpoint(endpoint, t.token, 5000).catch(() => ({
      status: 0,
      rows: [],
    }));

    streaming = checkpoint.status === 200 && checkpoint.rows.length > 0;

    if (!streaming) {
      await new Promise((d) => setTimeout(d, 1000));
    }
  }

  assert.ok(streaming, 'PowerSync never served the facility');

  // Read-only views of what the server holds, for comparison with the device.
  createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${INSPECT}`);

    const send = (body: unknown, status = 200) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });

      response.end(JSON.stringify(body));
    };

    try {
      if (url.pathname === '/facility') {
        return send(
          (
            await source.sql`SELECT name, code, state, lga, level, country, address, phone, currency, time_zone FROM facilities WHERE id = ${f.facility.id}`
          )[0],
        );
      }

      if (url.pathname === '/offerings') {
        return send(
          await source.sql`SELECT o.id, o.name, o.configuration, o.visit_types, o.unit_id, o.location_ids, d.category, d.investigation IS NOT NULL AS lab_test FROM service_offerings o JOIN service_definitions d ON d.id = o.service_definition_id WHERE o.facility_id = ${f.facility.id} ORDER BY o.name`,
        );
      }

      if (url.pathname === '/appointments') {
        return send(
          await source.sql`SELECT id, patient_id, visit_type, offering_id, attendance, charge_ids FROM appointments WHERE facility_id = ${f.facility.id} ORDER BY created_on`,
        );
      }

      if (url.pathname === '/encounters') {
        return send(
          await source.sql`SELECT id, patient_id, appointment_id, visit_type, offering_id FROM encounters WHERE facility_id = ${f.facility.id} ORDER BY created_on`,
        );
      }

      if (url.pathname === '/charges') {
        return send(
          await source.sql`SELECT id, patient_id, fee_item_id, amount_minor, exemption_reason, appointment_id FROM charges WHERE facility_id = ${f.facility.id} ORDER BY created_on`,
        );
      }

      if (url.pathname === '/sessions') {
        return send(
          await source.sql`SELECT staff_id, ended_on IS NOT NULL AS ended, expires_on > now() AS current FROM staff_sessions WHERE facility_id = ${f.facility.id} ORDER BY created_on`,
        );
      }

      if (url.pathname === '/enrollment-code' && request.method === 'POST') {
        return send(
          await issueEnrollmentCode(source.sql, f.facility.id, f.admin.id, f.device.deviceId),
        );
      }

      send({ error: 'not_found' }, 404);
    } catch (cause) {
      send({ error: String(cause) }, 500);
    }
  }).listen(INSPECT, '127.0.0.1');

  await writeFile(
    handoffPath,
    JSON.stringify(
      {
        api: `http://127.0.0.1:${API}`,
        sync: endpoint,
        inspector: `http://127.0.0.1:${INSPECT}`,
        web: WEB,
        signingPublicKey: signer.publicKeyBase64,
        facilityId: f.facility.id,
        facilityName: f.facility.name,
        enrollmentCode: enrollment.code,
        people,
        patientId,
      },
      null,
      2,
    ),
  );

  console.log(
    `care services staging ready: api ${API}, sync ${SYNC}, inspector ${INSPECT}; handoff ${handoffPath}`,
  );
} catch (cause) {
  console.error(cause);
  await cleanup();
  process.exit(1);
}
