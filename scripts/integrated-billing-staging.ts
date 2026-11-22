/**
 * Local Billing Release 1 staging stack: real geneus-server and real PowerSync
 * service over disposable PostgreSQL databases (geneus_test_*), seeded with a
 * synthetic hospital. The real web app (geneus-web/qa/integrated-billing-browser.mjs)
 * then runs against it — no stand-in routes.
 *
 *   POSTGRES_URL=postgres://geneus:devpassword@127.0.0.1:5433/geneus node scripts/integrated-billing-staging.ts <handoff.json>
 *
 * Requires the local Docker PostgreSQL (docker compose up -d postgres). Never
 * touches a shared or production database: it refuses any non-local URL.
 * A local fixture inspector on 18281 lets the browser compare its figures with
 * the server's. Stop with Ctrl+C; the container and databases are removed.
 */
import { mintSyncToken } from '../src/auth/syncToken.ts';
import { ensureBootstrapOperators } from '../src/routes/operator.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  POLICY_VERSION,
  EncounterEntry,
  dispensingSummary,
  type Charge,
  type FeeItem,
} from '#shared';
import { pharmacyRecords } from '../src/clinical/pharmacy.ts';
import { buildApp } from '../src/app.ts';
import { buildSyncConfig } from '../src/sync/syncConfig.ts';
import { findRecord, insertRecord } from '../src/db/records.ts';
import { enrollDevice, issueEnrollmentCode } from '../src/devices/enrollment.ts';
import { issuePinSetupCode } from '../src/staff/pinSetupCodes.ts';
import { chargePositions, chargesById } from '../src/insurance/coverage.ts';
import { outstandingClaims } from '../src/insurance/settlement.ts';
import {
  config,
  signer,
  addStaff,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
} from '../tests/postgres.ts';
import type { EmailMessage } from '../src/lib/email.ts';
import { readFirstCheckpoint } from '../tests/powersyncClient.ts';
import { seedInsuredStatement } from '../tests/integratedInsuranceFixture.ts';
import { buildPatientStatement } from '../src/billing/patientStatements.ts';

const exec = promisify(execFile);
const handoffPath = process.argv[2];
assert.ok(
  handoffPath?.endsWith('.json'),
  'Usage: node scripts/insurance-staging.ts <handoff.json>',
);

assert.equal(
  new URL(config.postgresUrl).hostname,
  '127.0.0.1',
  'Use the local disposable PostgreSQL (docker compose up -d postgres)',
);

const API = 18280;
const SYNC = 18290;
const INSPECT = 18281;
const WEB = 'http://127.0.0.1:5219';
const endpoint = `http://127.0.0.1:${SYNC}`;
const source = await scratchDatabase();
const storage = await scratchDatabase();
const mail: EmailMessage[] = [];

const app = buildApp(
  {
    paystackFetch: async (url, options) => {
      const path = new URL(String(url)).pathname;

      const verifiedTransaction = () => ({
        reference: decodeURIComponent(path.split('/').at(-1)!),
        status: 'success',
        amount: 2000000,
        currency: 'NGN',
        domain: 'live',
        paid_at: new Date().toISOString(),
        authorization: {
          channel: 'dedicated_nuban',
          receiver_bank_account_number: '9910000099',
          sender_name: 'Synthetic receipt sender',
        },
      });

      const syntheticAccount = {
        id: 999,
        active: true,
        currency: 'NGN',
        account_number: '9910000099',
        account_name: 'Synthetic hospital general',
        bank: { name: 'Synthetic bank' },
      };

      const responseData = () => {
        if (path === '/transaction') {
          return [];
        }

        if (path.startsWith('/transaction/verify/')) {
          return verifiedTransaction();
        }

        return syntheticAccount;
      };

      const data = responseData();

      return new Response(JSON.stringify({ status: true, data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    sql: source.sql,
    signer,
    mailer: {
      configured: true,
      send: async (m) => {
        mail.push(m);
      },
    },
    config: {
      ...config,
      billingEncryptionKey: Buffer.alloc(32, 19).toString('hex'),
      powerSyncPublicUrl: endpoint,
      powerSyncInternalUrl: endpoint,
      corsOrigins: [WEB, 'http://localhost:5219'],
    },
  },
  { logger: { level: 'warn' }, rateLimit: false },
);

const container = 'geneus-integrated-billing-staging';
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

  // A synthetic hospital. The registration device is the harness's own; the browser enrolls a second.
  const f = await registerScratchFacility(source.sql);
  // Disposable QA clock fixture: simulate rollout after the initial maximum token lifetime.
  await source.sql`UPDATE schema_migrations SET applied_on=now()-interval '2 days' WHERE version IN (41,42)`;

  const lostCode = await issueEnrollmentCode(
    source.sql,
    f.facility.id,
    f.admin.id,
    f.device.deviceId,
  );

  const lost = await enrollDevice(
    source.sql,
    { code: lostCode.code, deviceId: 'qa:lost-old-device', deviceLabel: 'Lost QA device' },
    WEB,
  );

  assert.ok(lost.ok);

  const people = {} as Record<
    'admin' | 'desk' | 'cashier' | 'officer' | 'supervisor' | 'doctor' | 'maternity' | 'pharmacy',
    { id: string; name: string; email?: string; pinCode: string }
  >;

  const roles = [
    ['admin', 'facility_admin', 'Ada Admin', 'admin2@example.org'],
    ['desk', 'records_officer', 'Dele Desk', undefined],
    ['cashier', 'cashier', 'Chika Cashier', undefined],
    ['officer', 'insurance_officer', 'Ifeoma Officer', 'officer@example.org'],
    ['supervisor', 'supervisor', 'Sola Supervisor', 'supervisor@example.org'],
    ['doctor', 'doctor', 'Dayo Doctor', undefined],
    ['maternity', 'nurse', 'Nneka Maternity Clinician', undefined],
    ['pharmacy', 'pharmacy_staff', 'Pemi Pharmacy', undefined],
  ] as const;

  for (const [key, role, name, email] of roles) {
    const staff = await addStaff(source.sql, f, { role, name, loginAccess: 'always' });

    if (email && key !== 'officer') {
      await source.sql`INSERT INTO staff_contacts (facility_id, staff_id, email, verified_on) VALUES (${f.facility.id}, ${staff.id}, ${email}, now())`;
    }

    const pin = await issuePinSetupCode(source.sql, {
      facilityId: f.facility.id,
      staffId: staff.id,
      issuedBy: f.admin.id,
      issuedFrom: f.device.deviceId,
    });

    assert.ok(pin.ok, `PIN code for ${name}`);
    people[key] = { id: staff.id, name, ...(email ? { email } : {}), pinCode: pin.code };
  }

  const base = { ...envelopeFor(f), schemaVersion: 5 };
  const patient = (n: string) => `${f.facility.id}-${n}-K2`;

  for (const [n, name] of [
    ['000001', 'Amaka Synthetic'],
    ['000002', 'Bayo Synthetic'],
  ] as const) {
    await insertRecord(source.sql, 'patient', {
      ...base,
      id: patient(n),
      patientId: patient(n),
      type: 'patient',
      fullName: name,
      address: 'Synthetic address',
      sex: 'female',
      ageYears: 34,
    });
  }

  for (const [id, name, category, amountMinor] of [
    ['fee:consultation', 'General consultation', 'consultation', 200_000],
    ['fee:lab', 'Malaria RDT', 'laboratory', 150_000],
  ] as const) {
    await insertRecord(source.sql, 'fee_item', {
      ...base,
      id,
      type: 'fee_item',
      name,
      category,
      amountMinor,
      currency: 'NGN',
      chargeWhen: 'when_ordered',
    });
  }

  // The patients attend after insurance billing starts: billing applies only to charges raised from activation.
  // Each visit has a doctor's written diagnosis; the consultation is shown done by it, the test needs a completion.
  const attend = async () => {
    const now = { ...envelopeFor(f), schemaVersion: 5 };

    for (const [n, diagnosis] of [
      ['000001', 'Uncomplicated malaria'],
      ['000002', 'Suspected malaria'],
    ] as const) {
      await insertRecord(source.sql, 'encounter', {
        ...now,
        createdBy: people.doctor.id,
        id: `encounter:p${Number(n)}`,
        type: 'encounter',
        patientId: patient(n),
        openedOn: now.createdOn,
        setting: 'facility',
      });

      await insertRecord(source.sql, 'encounter_entry', {
        ...now,
        createdBy: people.doctor.id,
        id: `entry:p${Number(n)}-dx`,
        type: 'encounter_entry',
        encounterId: `encounter:p${Number(n)}`,
        patientId: patient(n),
        step: 'diagnosis',
        actorRole: 'doctor',
        values: { diagnosis },
      });
    }

    const charges: [string, string, string, string, number][] = [
      ['charge:p1-consult', '000001', 'fee:consultation', 'consultation', 200_000],
      ['charge:p1-lab', '000001', 'fee:lab', 'laboratory', 150_000],
      ['charge:p2-consult', '000002', 'fee:consultation', 'consultation', 200_000],
    ];

    for (const [id, n, feeItemId, category, amount] of charges) {
      await insertRecord(source.sql, 'charge', {
        ...now,
        id,
        type: 'charge',
        patientId: patient(n),
        feeItemId,
        category,
        description: feeItemId === 'fee:lab' ? 'Malaria RDT' : 'General consultation',
        listPriceMinor: amount,
        amountMinor: amount,
        currency: 'NGN',
        encounterId: `encounter:p${Number(n)}`,
      } as Partial<Charge>);
    }
  };

  // Nothing is preconfigured: the administrator records the time zone and starts setup in the app,
  // and a Geneus operator approves billing in the operator console.
  await ensureBootstrapOperators(source.sql, ['ops@geneus.example.org']);

  const enrollment = await issueEnrollmentCode(
    source.sql,
    f.facility.id,
    f.admin.id,
    f.device.deviceId,
  );

  // The harness device reports itself synced with insurance support, so activation waits only on real devices.
  const reportReady = async () => {
    const r = await fetch(`http://127.0.0.1:${API}/sync/token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${f.device.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        insuranceWorkflowVersion: 1,
        clinicalWorkflowVersion: 1,
        facilityContractVersion: 1,
        schemaVersion: 7,
        integratedBillingVersion: 1,
        billingCatalogueVersion: 1,
        policyVersion: POLICY_VERSION,
        pendingMutationCount: 0,
      }),
    });

    assert.equal(r.status, 200, await r.text());
  };

  await reportReady();
  // Readiness is not enough: PowerSync must also have loaded the sync rules and answer a real stream.
  let streaming = false;

  for (let i = 0; i < 120 && !streaming; i++) {
    const t = (await fetch(`http://127.0.0.1:${API}/sync/token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${f.device.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        insuranceWorkflowVersion: 1,
        clinicalWorkflowVersion: 1,
        facilityContractVersion: 1,
        schemaVersion: 7,
        integratedBillingVersion: 1,
        billingCatalogueVersion: 1,
        policyVersion: POLICY_VERSION,
        pendingMutationCount: 0,
      }),
    }).then((r) => r.json())) as { token: string };

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

  // Check the real pinned PowerSync service, not only the API JWT verifier.
  const short = mintSyncToken(signer, {
    deviceId: f.device.deviceId,
    facilityId: f.facility.id,
    audience: config.powerSyncAudience,
    ttlSeconds: 5,
  });

  const startedAt = Date.now();
  const controller = new AbortController();
  const expiryTimeout = setTimeout(() => controller.abort(), 20000);
  let streamStatus = 0;
  let closedAfterMs = 0;

  try {
    const response = await fetch(endpoint + '/sync/stream', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + short.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        buckets: [],
        include_checksum: true,
        raw_data: true,
        client_id: 'expiry-check',
        streams: { include_defaults: true, subscriptions: [] },
      }),
      signal: controller.signal,
    });

    streamStatus = response.status;
    assert.equal(streamStatus, 200);
    const reader = response.body!.getReader();

    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }
    }

    closedAfterMs = Date.now() - startedAt;
  } finally {
    clearTimeout(expiryTimeout);
  }

  const expired = await fetch(endpoint + '/sync/stream', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + short.token, 'content-type': 'application/json' },
    body: JSON.stringify({
      buckets: [],
      include_checksum: true,
      raw_data: true,
      client_id: 'expired-check',
      streams: { include_defaults: true, subscriptions: [] },
    }),
    signal: AbortSignal.timeout(5000),
  });

  const expiredBody = await expired.text();

  const expiredLines = expiredBody
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.deepEqual(expiredLines, [{ token_expires_in: 0 }]);
  await writeFile(
    resolve(handoffPath, '../token-expiry.json'),
    JSON.stringify({
      streamStatus,
      closedAfterMs,
      expiredRequestStatus: expired.status,
      expiredTokenExpiresIn: 0,
      expiredRows: 0,
    }),
  );

  let seededReview = false;
  let reviewMutation = 1000000;

  const seedReview = async () => {
    if (seededReview) {
      return;
    }

    const [labRow] =
      await source.sql`SELECT id FROM fee_items WHERE facility_id=${f.facility.id} AND name='Full Blood Count QA'`;

    const [pharmacyRow] =
      await source.sql`SELECT id FROM fee_items WHERE facility_id=${f.facility.id} AND name='Ceftriaxone Injection QA'`;

    const lab = (await findRecord<FeeItem>(source.sql, 'fee_item', labRow.id))!;
    const medicine = (await findRecord<FeeItem>(source.sql, 'fee_item', pharmacyRow.id))!;
    const patientId = patient('000002');
    const at = Date.now();
    let sequence = 0;

    const env = () => ({
      ...envelopeFor(f),
      schemaVersion: 7,
      createdOn: new Date(at + sequence++).toISOString(),
    });

    // Synthetic scenes enter through the real financial/clinical upload boundary.
    const send = async (records: Record<string, unknown>[]) => {
      const response = await app.inject({
        method: 'POST',
        url: '/sync/upload',
        headers: { authorization: 'Bearer ' + f.device.credential },
        payload: {
          integratedBillingVersion: 1,
          billingCatalogueVersion: 1,
          clinicalWorkflowVersion: 1,
          pharmacyWorkflowVersion: 1,
          facilityContractVersion: 1,
          schemaVersion: 7,
          policyVersion: POLICY_VERSION,
          transactionId: 1,
          mutations: records.map((data) => ({
            clientId: ++reviewMutation,
            op: 'put',
            table: data.type,
            id: data.id,
            data,
          })),
        },
      });

      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().rejected, [], response.body);
    };

    const bill = (id: string, fee: FeeItem, quantity: number) => ({
      ...env(),
      id,
      type: 'charge',
      patientId,
      feeItemId: fee.id,
      category: fee.category,
      description: fee.name,
      feePriceVersion: fee.priceVersion,
      quantity,
      unitOfMeasure: fee.category === 'pharmacy' ? 'vials' : 'item',
      unitPriceMinor: fee.amountMinor,
      listPriceMinor: fee.amountMinor * quantity,
      amountMinor: fee.amountMinor * quantity,
      currency: fee.currency,
    });

    await send([
      bill('acceptance:manual-lab', lab, 1),
      bill('acceptance:manual-three', medicine, 3),
    ]);

    await send([
      {
        ...env(),
        id: 'acceptance:prepayment',
        type: 'payment',
        patientId,
        receiptNumber: f.facility.id + '-R-000101-Q2',
        method: 'cash',
        amountMinor: medicine.amountMinor * 3,
        currency: medicine.currency,
        allocations: [
          { chargeId: 'acceptance:manual-three', amountMinor: medicine.amountMinor * 3 },
        ],
      },
    ]);

    const visit = 'acceptance:lab-visit';
    const itemId = 'acceptance:lab-item';

    const clinical = (
      id: string,
      encounterId: string,
      step: string,
      values: Record<string, unknown>,
    ) => ({
      ...env(),
      id,
      type: 'encounter_entry',
      createdBy: people.doctor.id,
      encounterId,
      patientId,
      actorRole: 'doctor',
      workflowVersion: 1,
      step,
      values,
    });

    const prerequisites = (id: string) => [
      {
        ...env(),
        id,
        type: 'encounter',
        createdBy: people.doctor.id,
        patientId,
        workflowVersion: 1,
        openedOn: new Date(at).toISOString(),
      },
      clinical(id + ':vitals', id, 'vitals', { temperatureC: 37 }),
      clinical(id + ':complaint', id, 'complaint', { complaints: ['Synthetic review scene'] }),
    ];

    await send([
      ...prerequisites(visit),
      clinical('acceptance:lab-order', visit, 'lab_order', {
        tests: [lab.name],
        items: [
          {
            id: itemId,
            name: lab.name,
            catalogueSource: 'billing',
            feeItemId: lab.id,
            feePriceVersion: lab.priceVersion,
            priceMinor: lab.amountMinor,
            currency: lab.currency,
            exemptions: lab.exemptions,
            billingReviewReason: 'Existing manual Laboratory bill requires financial review',
          },
        ],
      }),
      clinical('acceptance:lab-result', visit, 'lab_results', {
        results: [
          {
            test: lab.name,
            orderItemId: itemId,
            result: 'Synthetic free-text result; no result template required',
          },
        ],
      }),
    ]);

    const pharmacyVisit = 'acceptance:pharmacy-visit';
    const rxId = 'acceptance:prescription';

    const rx = clinical(rxId, pharmacyVisit, 'prescription', {
      decision: 'prescribed',
      prescription: [
        {
          lineId: 'acceptance:medicine-line',
          drug: medicine.name,
          dose: 'Explicit synthetic instructions',
          quantity: 3,
          unitOfMeasure: 'vials',
        },
      ],
    });

    await send([
      ...prerequisites(pharmacyVisit),
      clinical(pharmacyVisit + ':decision', pharmacyVisit, 'investigation_review', {
        decision: 'none_required',
      }),
      clinical(pharmacyVisit + ':diagnosis', pharmacyVisit, 'diagnosis', {
        diagnosis: 'Synthetic fixture diagnosis',
      }),
      rx,
    ]);

    let previousEntryId: string | undefined;

    for (const [id, quantity] of [
      ['acceptance:supply-two', 2],
      ['acceptance:supply-one', 1],
    ] as const) {
      const entry = EncounterEntry.parse({
        ...clinical(id, pharmacyVisit, 'dispense', {}),
        createdBy: people.pharmacy.id,
        actorRole: 'pharmacy_staff',
        pharmacyVersion: 1,
        values: {
          supply: {
            catalogueVersion: 1,
            prescriptionEntryId: rxId,
            lineId: 'acceptance:medicine-line',
            previousEntryId,
            action: 'supply',
            quantity,
            unit: 'vials',
            source: 'untracked',
            billing: 'unpriced',
            complete: quantity === 1,
            reason: 'Existing three-unit manual bill requires source-association review',
          },
          lines: [{ drug: medicine.name, dispensed: false, reason: 'Pending' }],
        },
      });

      const data = await pharmacyRecords(source.sql as never, entry);
      entry.values.lines = dispensingSummary(EncounterEntry.parse(rx), data.entries, entry);
      await send([entry]);
      previousEntryId = id;
    }

    seededReview = true;
  };

  // Read-only views of the server's own figures, for comparison with the device.
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
      if (url.pathname === '/positions') {
        const ids = (
          await source.sql<
            { id: string }[]
          >`SELECT id FROM charges WHERE facility_id = ${f.facility.id} AND patient_id = ${url.searchParams.get('patient') ?? ''}`
        ).map((r) => r.id);

        const positions = await chargePositions(
          source.sql,
          f.facility.id,
          await chargesById(source.sql, f.facility.id, ids),
        );

        const details =
          await source.sql`SELECT a.charge_id, d.list_price_minor, d.patient_share_minor, d.payer_share_minor, d.contract_adjustment_minor, d.capitation_covered_minor
          FROM coverage_allocations a JOIN coverage_allocation_details d ON d.allocation_id = a.id WHERE a.facility_id = ${f.facility.id}`;

        return send(
          [...positions.values()].map((p) => ({
            chargeId: p.charge.id,
            state: p.estimate.state,
            baseMinor: p.baseMinor,
            undeterminedMinor: p.undeterminedMinor,
            balanceMinor: p.balanceMinor,
            final: p.final,
            money: p.money,
            split: details.find((d) => d.charge_id === p.charge.id) ?? null,
          })),
        );
      }

      if (url.pathname === '/mail') {
        return send(mail.filter((m) => m.to === url.searchParams.get('to')).slice(-1)[0] ?? null);
      }

      if (url.pathname === '/audit') {
        return send(
          await source.sql`SELECT entity_type, entity_id, actor_staff_id, device_id, metadata FROM audit_events WHERE facility_id = ${f.facility.id} AND metadata->>'context' = ${url.searchParams.get('context') ?? ''}`,
        );
      }

      if (url.pathname === '/payments') {
        return send(
          await source.sql`SELECT id, patient_id, amount_minor, created_by, device_id, allocations,incoming_transfer_id FROM payments WHERE facility_id = ${f.facility.id} ORDER BY created_on`,
        );
      }

      if (url.pathname === '/refunds') {
        return send(
          await source.sql`SELECT id, refund_number, amount_minor, allocations FROM refunds WHERE facility_id = ${f.facility.id}`,
        );
      }

      if (url.pathname === '/catalogue-status') {
        return send(
          (
            await source.sql`SELECT integrated_billing_version,billing_catalogue_version FROM facilities WHERE id=${f.facility.id}`
          )[0],
        );
      }

      if (url.pathname === '/records') {
        return send({
          charges:
            await source.sql`SELECT id,fee_item_id,fee_price_version,quantity,unit_price_minor,list_price_minor,amount_minor,description,bill_id FROM charges WHERE facility_id=${f.facility.id}`,
          definitions:
            await source.sql`SELECT id FROM service_definitions WHERE facility_id=${f.facility.id}`,
          stocks: await source.sql`SELECT id FROM stock_items WHERE facility_id=${f.facility.id}`,
        });
      }

      if (url.pathname === '/acceptance-review' && request.method === 'POST') {
        await seedReview();

        return send({ ok: true });
      }

      if (url.pathname === '/insured-fixture' && request.method === 'POST') {
        const patientId = patient('000003');
        await seedInsuredStatement(source.sql, f, patientId, people.admin.id, { pharmacy: true });
        const base = { ...envelopeFor(f), schemaVersion: 7 };

        if (!(await findRecord(source.sql, 'encounter', 'insured:visit'))) {
          await insertRecord(source.sql, 'encounter', {
            ...base,
            id: 'insured:visit',
            type: 'encounter',
            patientId,
            openedOn: base.createdOn,
          });

          const entry = (id: string, action: string, quantity: number) => ({
            ...base,
            id,
            type: 'encounter_entry',
            createdBy: people.pharmacy.id,
            patientId,
            encounterId: 'insured:visit',
            actorRole: 'pharmacy_staff',
            step: 'dispense',
            workflowVersion: 1,
            pharmacyVersion: 1,
            values: {
              lines: [
                {
                  drug: 'Synthetic insured medicine',
                  dispensed: action === 'supply',
                  ...(action === 'return' ? { reason: 'Historical fixture' } : {}),
                },
              ],
              supply: {
                prescriptionEntryId: 'historical:rx',
                lineId: 'historical:line',
                action,
                complete: action === 'supply',
                quantity,
                unit: 'tablets',
                ...(action === 'supply' ? { source: 'untracked', billing: 'unpriced' } : {}),
                reason: 'Synthetic signed historical service fixture',
                ...(action === 'return'
                  ? {
                      previousEntryId: 'insured:supply',
                      returnOf: 'insured:supply',
                      restock: false,
                      creditMinor: 0,
                    }
                  : {}),
              },
            },
          });

          await insertRecord(source.sql, 'encounter_entry', entry('insured:supply', 'supply', 3));

          const data = {
            ...base,
            id: 'insured:association',
            type: 'service_charge_allocation',
            createdBy: people.admin.id,
            patientId,
            chargeId: 'charge:integrated-insured',
            sourceKind: 'pharmacy',
            sourceEntryId: 'insured:supply',
            sourceItemId: 'insured:supply',
            action: 'allocate',
            quantity: 3,
            unit: 'tablets',
            reason: 'Exact historical insured purchase and supply',
            creditReturnedUnits: false,
          };

          const result = await app.inject({
            method: 'POST',
            url: '/sync/upload',
            headers: { authorization: 'Bearer ' + f.device.credential },
            payload: {
              integratedBillingVersion: 1,
              billingCatalogueVersion: 1,
              clinicalWorkflowVersion: 1,
              pharmacyWorkflowVersion: 1,
              facilityContractVersion: 1,
              schemaVersion: 7,
              policyVersion: POLICY_VERSION,
              transactionId: 1,
              mutations: [
                { clientId: ++reviewMutation, op: 'put', table: data.type, id: data.id, data },
              ],
            },
          });

          assert.equal(result.statusCode, 200, result.body);
          assert.deepEqual(result.json().rejected, [], result.body);
          await insertRecord(
            source.sql,
            'encounter_entry',
            entry('insured:return:one', 'return', 1),
          );
        }

        return send({ patientId });
      }

      if (url.pathname === '/insured-statement') {
        return send(
          await source.sql.begin((tx) =>
            buildPatientStatement(
              tx as never,
              f.facility.id,
              patient('000003'),
              'NGN',
              new Date().toISOString(),
            ),
          ),
        );
      }

      if (url.pathname === '/integrated-state') {
        return send({
          allocations:
            await source.sql`SELECT id,charge_id,source_entry_id,source_item_id,action,quantity,accepted_on,credit_minor,return_entry_id FROM service_charge_allocations WHERE facility_id=${f.facility.id} ORDER BY accepted_on,id`,
          credits:
            await source.sql`SELECT id,charge_id,amount_minor FROM billing_adjustments WHERE facility_id=${f.facility.id}`,
          returns:
            await source.sql`SELECT id,values FROM encounter_entries WHERE facility_id=${f.facility.id} AND pharmacy_version=1 AND values->'supply'->>'action'='return'`,
          accounts:
            await source.sql`SELECT id,department_id FROM billing_receiving_accounts WHERE facility_id=${f.facility.id}`,
          general:
            (
              await source.sql`SELECT receiving_account_id FROM billing_connections WHERE facility_id=${f.facility.id}`
            )[0] ?? null,
          transfers:
            await source.sql`SELECT id,amount_minor FROM incoming_transfers WHERE facility_id=${f.facility.id}`,
        });
      }

      if (url.pathname === '/acceptance-state') {
        return send({
          charges:
            await source.sql`SELECT id,amount_minor FROM charges WHERE facility_id=${f.facility.id} AND patient_id=${patient('000002')} ORDER BY id`,
          payments:
            await source.sql`SELECT id,amount_minor,allocations FROM payments WHERE facility_id=${f.facility.id} AND patient_id=${patient('000002')} ORDER BY id`,
          sources:
            await source.sql`SELECT id,created_by,values FROM encounter_entries WHERE facility_id=${f.facility.id} AND id IN ('acceptance:lab-order','acceptance:supply-two','acceptance:supply-one') ORDER BY id`,
        });
      }

      if (url.pathname === '/fees') {
        return send(
          await source.sql`SELECT id,name,description,category,amount_minor,currency,charge_when,exemptions,department_id FROM fee_items WHERE facility_id = ${f.facility.id} ORDER BY name`,
        );
      }

      if (url.pathname === '/finish' && request.method === 'POST') {
        send({ ok: true });
        setTimeout(() => void cleanup().then(() => process.exit(0)), 100);

        return;
      }

      if (url.pathname === '/devices') {
        return send(
          await source.sql`SELECT d.id, d.status, v.insurance_version, v.pending_mutation_count, v.recorded_on FROM devices d LEFT JOIN workforce_client_versions v ON v.device_id = d.id WHERE d.facility_id = ${f.facility.id}`,
        );
      }

      if (url.pathname === '/ready' && request.method === 'POST') {
        await reportReady();

        return send({ ok: true });
      }

      // Patients attend once billing is active (activation itself happens in the operator console).
      if (url.pathname === '/attend' && request.method === 'POST') {
        await attend();

        return send({ ok: true });
      }

      if (url.pathname === '/insurance-state') {
        return send(
          (
            await source.sql`SELECT insurance_state, time_zone FROM facilities WHERE id = ${f.facility.id}`
          )[0],
        );
      }

      if (url.pathname === '/claims') {
        return send(
          await source.sql`SELECT claim_number, revision, state, superseded_by, patient_id, (SELECT COUNT(*)::int FROM insurance_claim_lines l WHERE l.claim_id = c.id AND l.current) AS lines FROM insurance_claims c WHERE facility_id = ${f.facility.id} ORDER BY claim_number, revision`,
        );
      }

      if (url.pathname === '/remittances') {
        return send(
          await source.sql`SELECT r.reference, r.amount_minor, (SELECT COALESCE(SUM(a.amount_minor), 0)::int FROM insurance_remittance_allocations a WHERE a.remittance_id = r.id) AS allocated, EXISTS (SELECT 1 FROM insurance_remittance_reversals v WHERE v.remittance_id = r.id) AS reversed FROM insurance_remittances r WHERE r.facility_id = ${f.facility.id} ORDER BY r.recorded_on`,
        );
      }

      if (url.pathname === '/settlement') {
        return send(
          (await outstandingClaims(source.sql, f.facility.id)).claims.map((x) => ({
            claimNumber: x.claimNumber,
            revision: x.revision,
            patientId: x.patientId,
            ...x.settlement,
          })),
        );
      }

      if (url.pathname === '/decisions') {
        return send(
          await source.sql`SELECT c.claim_number, d.decision, d.approved_minor FROM insurance_claim_decisions d JOIN insurance_claims c ON c.id = d.claim_id WHERE d.facility_id = ${f.facility.id} ORDER BY d.recorded_on`,
        );
      }

      if (url.pathname === '/completions') {
        return send(
          await source.sql`SELECT id, charge_id, status, actor_role, created_by FROM service_completions WHERE facility_id = ${f.facility.id}`,
        );
      }

      if (url.pathname === '/claim-exports') {
        return send(
          await source.sql`SELECT draft, format, rows, payload_sha256 FROM insurance_claim_exports WHERE facility_id = ${f.facility.id} ORDER BY exported_on`,
        );
      }

      if (url.pathname === '/claim-submissions') {
        return send(
          await source.sql`SELECT s.channel, s.reference, s.claim_ids, a.reference AS ack FROM insurance_claim_submissions s LEFT JOIN insurance_claim_acknowledgements a ON a.submission_id = s.id WHERE s.facility_id = ${f.facility.id}`,
        );
      }

      if (url.pathname === '/enrollment-code' && request.method === 'POST') {
        return send(
          await issueEnrollmentCode(source.sql, f.facility.id, f.admin.id, f.device.deviceId),
        );
      }

      // Ends every verified staff session, to exercise expiry and renewal in the real app.
      if (url.pathname === '/expire-sessions' && request.method === 'POST') {
        await source.sql`UPDATE staff_sessions SET expires_on = now() - interval '1 second' WHERE facility_id = ${f.facility.id}`;

        return send({ ok: true });
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
        enrollmentCode: enrollment.code,
        people,
        patients: { first: patient('000001'), second: patient('000002') },
      },
      null,
      2,
    ),
  );

  console.log(
    `staging ready: api ${API}, sync ${SYNC}, inspector ${INSPECT}; handoff ${handoffPath}`,
  );
} catch (cause) {
  console.error(cause);
  await cleanup();
  process.exit(1);
}
