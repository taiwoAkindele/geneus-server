/**
 * Local insurance staging stack: the real geneus-server and a real PowerSync
 * service over disposable PostgreSQL databases (geneus_test_*), seeded with a
 * synthetic hospital. The real web app (geneus-web/qa/insurance-staging-browser.mjs)
 * then runs against it — no stand-in routes.
 *
 *   POSTGRES_URL=postgres://geneus:devpassword@127.0.0.1:5433/geneus node scripts/insurance-staging.ts <handoff.json>
 *
 * Requires the local Docker PostgreSQL (docker compose up -d postgres). Never
 * touches a shared or production database: it refuses any non-local URL.
 * A read-only inspector on 18081 lets the browser run compare its figures with
 * the server's. Stop with Ctrl+C; the container and databases are removed.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { POLICY_VERSION, type Charge } from '#shared';
import { buildApp } from '../src/app.ts';
import { buildSyncConfig } from '../src/sync/syncConfig.ts';
import { insertRecord } from '../src/db/records.ts';
import { issueEnrollmentCode } from '../src/devices/enrollment.ts';
import { issuePinSetupCode } from '../src/staff/pinSetupCodes.ts';
import { setInsuranceState } from '../src/insurance/enablement.ts';
import { chargePositions, chargesById } from '../src/insurance/coverage.ts';
import { config, signer, addStaff, envelopeFor, registerScratchFacility, scratchDatabase } from '../tests/postgres.ts';
import type { EmailMessage } from '../src/lib/email.ts';
import { readFirstCheckpoint } from '../tests/powersyncClient.ts';

const exec = promisify(execFile);
const handoffPath = process.argv[2];
assert.ok(handoffPath?.endsWith('.json'), 'Usage: node scripts/insurance-staging.ts <handoff.json>');
assert.equal(new URL(config.postgresUrl).hostname, '127.0.0.1', 'Use the local disposable PostgreSQL (docker compose up -d postgres)');

const API = 18080, SYNC = 18090, INSPECT = 18081, WEB = 'http://127.0.0.1:5199';
const endpoint = `http://127.0.0.1:${SYNC}`;
const source = await scratchDatabase(), storage = await scratchDatabase();
const mail: EmailMessage[] = [];
const app = buildApp({
  sql: source.sql, signer, mailer: { configured: true, send: async (m) => { mail.push(m); } },
  config: { ...config, powerSyncPublicUrl: endpoint, powerSyncInternalUrl: endpoint, corsOrigins: [WEB, 'http://localhost:5199'] },
}, { logger: { level: 'warn' }, rateLimit: false });
const container = 'geneus-insurance-staging';
let started = false;
const cleanup = async () => {
  if (started) await exec('docker', ['rm', '-f', container], { windowsHide: true }).catch(() => {});
  await app.close().catch(() => {}); await source.drop().catch(() => {}); await storage.drop().catch(() => {});
};
process.on('SIGINT', () => void cleanup().then(() => process.exit(0)));
process.on('SIGTERM', () => void cleanup().then(() => process.exit(0)));

try {
  await app.listen({ port: API, host: '0.0.0.0' });
  await writeFile(resolve('powersync/sync-config.yaml'), buildSyncConfig());
  const inside = (url: string) => { const v = new URL(url); v.hostname = 'host.docker.internal'; return v.toString(); };
  await exec('docker', ['rm', '-f', container], { windowsHide: true }).catch(() => {});
  await exec('docker', ['run', '--detach', '--name', container, '--publish', `127.0.0.1:${SYNC}:8080`, '--add-host', 'host.docker.internal:host-gateway',
    '--mount', `type=bind,source=${resolve('powersync')},target=/config,readonly`,
    '--env', 'POWERSYNC_CONFIG_PATH=/config/service.yaml', '--env', `PS_SOURCE_URI=${inside(source.url)}`, '--env', `PS_STORAGE_URI=${inside(storage.url)}`,
    '--env', 'PS_SSLMODE=disable', '--env', `PS_JWKS_URI=http://host.docker.internal:${API}/.well-known/jwks.json`, '--env', 'PS_JWT_AUDIENCE=powersync', '--env', 'PS_PORT=8080',
    'journeyapps/powersync-service:1.26.0', 'start', '-r', 'unified'], { windowsHide: true, timeout: 60000 });
  started = true;
  let healthy = false;
  for (let i = 0; i < 120 && !healthy; i++) { healthy = await fetch(endpoint + '/probes/readiness').then((r) => r.ok, () => false); if (!healthy) await new Promise((d) => setTimeout(d, 500)); }
  assert.ok(healthy, 'PowerSync did not become ready');

  // A synthetic hospital. The registration device is the harness's own; the browser enrolls a second.
  const f = await registerScratchFacility(source.sql);
  const people = {} as Record<'admin' | 'desk' | 'cashier' | 'officer' | 'supervisor', { id: string; name: string; email?: string; pinCode: string }>;
  const roles = [['admin', 'facility_admin', 'Ada Admin', 'admin2@example.org'], ['desk', 'records_officer', 'Dele Desk', undefined], ['cashier', 'cashier', 'Chika Cashier', undefined],
    ['officer', 'insurance_officer', 'Ifeoma Officer', 'officer@example.org'], ['supervisor', 'supervisor', 'Sola Supervisor', 'supervisor@example.org']] as const;
  for (const [key, role, name, email] of roles) {
    const staff = await addStaff(source.sql, f, { role, name, loginAccess: 'always' });
    if (email) await source.sql`INSERT INTO staff_contacts (facility_id, staff_id, email, verified_on) VALUES (${f.facility.id}, ${staff.id}, ${email}, now())`;
    const pin = await issuePinSetupCode(source.sql, { facilityId: f.facility.id, staffId: staff.id, issuedBy: f.admin.id, issuedFrom: f.device.deviceId });
    assert.ok(pin.ok, `PIN code for ${name}`);
    people[key] = { id: staff.id, name, ...(email ? { email } : {}), pinCode: pin.code };
  }
  const base = { ...envelopeFor(f), schemaVersion: 5 };
  const patient = (n: string) => `${f.facility.id}-${n}-K2`;
  for (const [n, name] of [['000001', 'Amaka Synthetic'], ['000002', 'Bayo Synthetic']] as const) {
    await insertRecord(source.sql, 'patient', { ...base, id: patient(n), patientId: patient(n), type: 'patient', fullName: name, address: 'Synthetic address', sex: 'female', ageYears: 34 });
  }
  for (const [id, name, category, amountMinor] of [['fee:consultation', 'General consultation', 'consultation', 200_000], ['fee:lab', 'Malaria RDT', 'laboratory', 150_000]] as const) {
    await insertRecord(source.sql, 'fee_item', { ...base, id, type: 'fee_item', name, category, amountMinor, currency: 'NGN', chargeWhen: 'when_ordered' });
  }
  const charges: [string, string, string, string, number][] = [['charge:p1-consult', '000001', 'fee:consultation', 'consultation', 200_000], ['charge:p1-lab', '000001', 'fee:lab', 'laboratory', 150_000], ['charge:p2-consult', '000002', 'fee:consultation', 'consultation', 200_000]];
  for (const [id, n, feeItemId, category, amount] of charges) {
    await insertRecord(source.sql, 'charge', { ...base, id, type: 'charge', patientId: patient(n), feeItemId, category, description: feeItemId === 'fee:lab' ? 'Malaria RDT' : 'General consultation', listPriceMinor: amount, amountMinor: amount, currency: 'NGN' } as Partial<Charge>);
  }
  // Setup the way an operator would: audited, with the time zone recorded. Billing is activated later, after readiness.
  await setInsuranceState(source.sql, { facilityId: f.facility.id, state: 'setup', operator: 'staging-harness', governanceReference: 'staging:synthetic-hospital', timeZone: 'Africa/Lagos' });
  // The time zone is recorded; the hospital administrator then starts setup from the app.
  await setInsuranceState(source.sql, { facilityId: f.facility.id, state: 'off', operator: 'staging-harness', governanceReference: 'staging:synthetic-hospital' });
  const enrollment = await issueEnrollmentCode(source.sql, f.facility.id, f.admin.id, f.device.deviceId);
  // The harness device reports itself synced with insurance support, so activation waits only on real devices.
  const reportReady = async () => {
    const r = await fetch(`http://127.0.0.1:${API}/sync/token`, { method: 'POST', headers: { authorization: `Bearer ${f.device.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ insuranceWorkflowVersion: 1, clinicalWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: POLICY_VERSION, pendingMutationCount: 0 }) });
    assert.equal(r.status, 200, await r.text());
  };
  await reportReady();
  // Readiness is not enough: PowerSync must also have loaded the sync rules and answer a real stream.
  let streaming = false;
  for (let i = 0; i < 120 && !streaming; i++) {
    const t = await fetch(`http://127.0.0.1:${API}/sync/token`, { method: 'POST', headers: { authorization: `Bearer ${f.device.credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ insuranceWorkflowVersion: 1, clinicalWorkflowVersion: 1, facilityContractVersion: 1, schemaVersion: 5, policyVersion: POLICY_VERSION, pendingMutationCount: 0 }) }).then((r) => r.json()) as { token: string };
    const checkpoint = await readFirstCheckpoint(endpoint, t.token, 5000).catch(() => ({ status: 0, rows: [] }));
    streaming = checkpoint.status === 200 && checkpoint.rows.length > 0;
    if (!streaming) await new Promise((d) => setTimeout(d, 1000));
  }
  assert.ok(streaming, 'PowerSync never served the facility');

  // Read-only views of the server's own figures, for comparison with the device.
  createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${INSPECT}`);
    const send = (body: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); response.end(JSON.stringify(body)); };
    try {
      if (url.pathname === '/positions') {
        const ids = (await source.sql<{ id: string }[]>`SELECT id FROM charges WHERE facility_id = ${f.facility.id} AND patient_id = ${url.searchParams.get('patient') ?? ''}`).map((r) => r.id);
        const positions = await chargePositions(source.sql, f.facility.id, await chargesById(source.sql, f.facility.id, ids));
        const details = await source.sql`SELECT a.charge_id, d.list_price_minor, d.patient_share_minor, d.payer_share_minor, d.contract_adjustment_minor, d.capitation_covered_minor
          FROM coverage_allocations a JOIN coverage_allocation_details d ON d.allocation_id = a.id WHERE a.facility_id = ${f.facility.id}`;
        return send([...positions.values()].map((p) => ({ chargeId: p.charge.id, state: p.estimate.state, baseMinor: p.baseMinor, undeterminedMinor: p.undeterminedMinor, balanceMinor: p.balanceMinor, final: p.final, money: p.money,
          split: details.find((d) => d.charge_id === p.charge.id) ?? null })));
      }
      if (url.pathname === '/mail') return send(mail.filter((m) => m.to === url.searchParams.get('to')).slice(-1)[0] ?? null);
      if (url.pathname === '/audit') return send(await source.sql`SELECT entity_type, entity_id, actor_staff_id, device_id, metadata FROM audit_events WHERE facility_id = ${f.facility.id} AND metadata->>'context' = ${url.searchParams.get('context') ?? ''}`);
      if (url.pathname === '/payments') return send(await source.sql`SELECT id, patient_id, amount_minor, created_by, device_id, allocations FROM payments WHERE facility_id = ${f.facility.id} ORDER BY created_on`);
      if (url.pathname === '/refunds') return send(await source.sql`SELECT id, refund_number, amount_minor, allocations FROM refunds WHERE facility_id = ${f.facility.id}`);
      if (url.pathname === '/devices') return send(await source.sql`SELECT d.id, d.status, v.insurance_version, v.pending_mutation_count, v.recorded_on FROM devices d LEFT JOIN workforce_client_versions v ON v.device_id = d.id WHERE d.facility_id = ${f.facility.id}`);
      if (url.pathname === '/ready' && request.method === 'POST') { await reportReady(); return send({ ok: true }); }
      if (url.pathname === '/activate-billing' && request.method === 'POST') { await reportReady(); return send(await setInsuranceState(source.sql, { facilityId: f.facility.id, state: 'active', operator: 'staging-harness', governanceReference: 'staging:billing-activation' })); }
      if (url.pathname === '/enrollment-code' && request.method === 'POST') return send(await issueEnrollmentCode(source.sql, f.facility.id, f.admin.id, f.device.deviceId));
      // Ends every verified staff session, to exercise expiry and renewal in the real app.
      if (url.pathname === '/expire-sessions' && request.method === 'POST') { await source.sql`UPDATE workforce_private_sessions SET expires_on = now() - interval '1 second' WHERE facility_id = ${f.facility.id}`; return send({ ok: true }); }
      send({ error: 'not_found' }, 404);
    } catch (cause) { send({ error: String(cause) }, 500); }
  }).listen(INSPECT, '127.0.0.1');

  await writeFile(handoffPath, JSON.stringify({
    api: `http://127.0.0.1:${API}`, sync: endpoint, inspector: `http://127.0.0.1:${INSPECT}`, web: WEB, signingPublicKey: signer.publicKeyBase64,
    facilityId: f.facility.id, enrollmentCode: enrollment.code, people, patients: { first: patient('000001'), second: patient('000002') },
  }, null, 2));
  console.log(`staging ready: api ${API}, sync ${SYNC}, inspector ${INSPECT}; handoff ${handoffPath}`);
} catch (cause) {
  console.error(cause);
  await cleanup();
  process.exit(1);
}
