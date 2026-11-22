import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_VERSION, type FeeItem, type Charge, type EncounterEntry } from '#shared';
import { findRecord, insertRecord } from '../src/db/records.ts';
import { catalogueReadiness } from '../src/billing/catalogue.ts';
import { enrollDevice, issueEnrollmentCode } from '../src/devices/enrollment.ts';
import {
  addStaff,
  asDevice,
  clientId,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
  staffSessionFor,
  testApp,
} from './postgres.ts';

describe('Billing 2A/2B central categories and immutable evidence', () => {
  let db: Awaited<ReturnType<typeof scratchDatabase>>;
  let app: ReturnType<typeof testApp>;
  let f: Awaited<ReturnType<typeof registerScratchFacility>>;
  let token: string;
  const versions = {
    billingCatalogueVersion: 1,
    schemaVersion: 6,
    facilityContractVersion: 1,
    policyVersion: POLICY_VERSION,
  } as const;
  const call = (url: string, payload: object, proof = true) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: {
        ...asDevice(f.device.credential),
        ...(proof
          ? { 'x-staff-session': token, 'x-billing-catalogue-version': '1' }
          : { 'x-actor-staff-id': f.admin.id }),
      },
    });
  const fee = (id: string, category = 'laboratory') => ({
    clientId: clientId(),
    op: 'put',
    table: 'fee_item',
    id,
    data: {
      ...envelopeFor(f),
      id,
      type: 'fee_item',
      name: id,
      category,
      amountMinor: 700000,
      currency: 'NGN',
      chargeWhen: 'when_ordered',
      exemptions: [],
    },
  });
  const save = (mutations: object[], proof = true) =>
    call('/config/save', { ...versions, transactionId: null, mutations }, proof);
  const handshake = () => call('/sync/token', { ...versions, pendingMutationCount: 0 });
  before(async () => {
    db = await scratchDatabase();
    f = await registerScratchFacility(db.sql);
    app = testApp(db.sql);
    const proof = await staffSessionFor(app, f.device.credential, f.admin.id);
    assert.ok(proof);
    token = proof;
  });
  after(async () => {
    await app?.close();
    await db?.drop();
  });
  it('allows the catalogue compatibility header in browser preflight without granting financial authentication', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/staff/session',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-billing-catalogue-version',
      },
    });
    assert.equal(response.statusCode, 204);
    assert.ok(
      String(response.headers['access-control-allow-headers']).includes(
        'x-billing-catalogue-version',
      ),
    );
  });
  it('keeps unsafe creation and reclassification protected during the transition', async () => {
    assert.equal((await save([fee('fee:lab')])).statusCode, 200);
    assert.equal((await save([fee('fee:medicine', 'pharmacy')])).json().error, 'upgrade_required');
    assert.equal(await findRecord(db.sql, 'fee_item', 'fee:medicine'), undefined);
    const before = await findRecord<FeeItem>(db.sql, 'fee_item', 'fee:lab');
    const refused = await save([
      {
        clientId: clientId(),
        op: 'patch',
        table: 'fee_item',
        id: 'fee:lab',
        data: { category: 'procedure', updatedBy: f.admin.id, updatedOn: new Date().toISOString() },
      },
    ]);
    assert.equal(refused.statusCode, 409);
    assert.equal(
      (await findRecord<FeeItem>(db.sql, 'fee_item', 'fee:lab'))?.category,
      before?.category,
    );
  });
  it('requires upgraded active devices, a drained queue and expiration of old reader tokens', async () => {
    const code = await issueEnrollmentCode(db.sql, f.facility.id, f.admin.id, f.device.deviceId);
    const other = await enrollDevice(
      db.sql,
      { code: code.code, deviceId: 'catalogue:older' },
      'http://localhost:8080',
    );
    assert.ok(other.ok);
    assert.equal((await handshake()).json().billingCatalogueEnabled, false);
    assert.ok(
      (await catalogueReadiness(db.sql, f.facility.id)).devices.find(
        (d) => d.id === 'catalogue:older',
      )?.blockers.length,
    );
    await db.sql`UPDATE schema_migrations SET applied_on=now()-interval '2 days' WHERE version=41`;
    const legacy = await app.inject({
      method: 'POST',
      url: '/sync/token',
      payload: {
        schemaVersion: 5,
        facilityContractVersion: 1,
        policyVersion: POLICY_VERSION,
        pendingMutationCount: 0,
      },
      headers: asDevice(other.credential.credential),
    });
    const [tracked] =
      await db.sql`SELECT legacy_billing_token_expires_on FROM workforce_client_versions WHERE device_id='catalogue:older'`;
    assert.ok(
      new Date(tracked.legacy_billing_token_expires_on).getTime() >=
        Date.parse(legacy.json().expiresOn),
      'cutover cannot precede actual minted token expiry',
    );
    await app.inject({
      method: 'POST',
      url: '/sync/token',
      payload: { ...versions, pendingMutationCount: 0 },
      headers: asDevice(other.credential.credential),
    });
    assert.equal(
      (await handshake()).json().billingCatalogueEnabled,
      false,
      'an older valid token still blocks cutover after its client upgrades',
    );
    const retired = await call('/devices/catalogue%3Aolder/revoke', { revokedBy: f.admin.id });
    assert.equal(retired.statusCode, 200, retired.body);
    assert.equal(
      (await handshake()).json().billingCatalogueEnabled,
      false,
      'retiring the device must not bypass its still-valid JWT',
    );
    await db.sql`UPDATE workforce_client_versions SET legacy_billing_token_expires_on=now()-interval '1 second' WHERE facility_id=${f.facility.id}`;
    assert.equal((await handshake()).json().billingCatalogueEnabled, true);
    const old = await call('/sync/token', {
      schemaVersion: 5,
      facilityContractVersion: 1,
      policyVersion: POLICY_VERSION,
    });
    assert.equal(old.statusCode, 409);
    assert.equal(old.json().error, 'upgrade_required');
  });
  it('creates central Pharmacy/Imaging prices without operational definitions and keeps assertion-only callers out', async () => {
    for (const [id, category] of [
      ['fee:medicine', 'pharmacy'],
      ['fee:scan', 'imaging'],
    ]) {
      assert.equal((await save([fee(id, category)])).statusCode, 200);
    }
    assert.equal((await save([fee('fee:spoof')], false)).json().error, 'staff_session_required');
    const stored = await findRecord<FeeItem>(db.sql, 'fee_item', 'fee:medicine');
    assert.equal(stored?.chargeWhen, 'when_ordered');
    assert.equal(stored?.priceEvidenceVersion, 1);
    assert.equal(
      (
        await db.sql`SELECT COUNT(*)::int AS n FROM service_definitions WHERE facility_id=${f.facility.id}`
      )[0].n,
      0,
    );
  });
  it('accepts an offline old-price quantity snapshot after a new catalogue price, and rejects forged evidence', async () => {
    const selected = (await findRecord<FeeItem>(db.sql, 'fee_item', 'fee:medicine'))!;
    const patientId = f.facility.id + '-000001-K2';
    await insertRecord(db.sql, 'patient', {
      ...envelopeFor(f),
      id: patientId,
      type: 'patient',
      patientId,
      fullName: 'Synthetic patient',
      sex: 'female',
      ageYears: 30,
      address: 'Synthetic',
    });
    const record = {
      ...envelopeFor(f),
      schemaVersion: 6,
      id: 'charge:old-price',
      type: 'charge',
      patientId,
      feeItemId: selected.id,
      category: selected.category,
      description: selected.name,
      feePriceVersion: selected.priceVersion,
      quantity: 3,
      unitPriceMinor: selected.amountMinor,
      listPriceMinor: selected.amountMinor * 3,
      amountMinor: selected.amountMinor * 3,
      currency: selected.currency,
    };
    const priceEdit = await save([
      {
        clientId: clientId(),
        op: 'patch',
        table: 'fee_item',
        id: selected.id,
        data: { amountMinor: 800000, updatedBy: f.admin.id, updatedOn: new Date().toISOString() },
      },
    ]);
    assert.equal(priceEdit.statusCode, 200, priceEdit.body);
    const upload = (data: object) =>
      call(
        '/sync/upload',
        {
          ...versions,
          transactionId: 1,
          mutations: [
            {
              clientId: clientId(),
              op: 'put',
              table: 'charge',
              id: (data as { id: string }).id,
              data,
            },
          ],
        },
        false,
      );
    const accepted = await upload(record);
    assert.equal(accepted.json().rejected.length, 0, accepted.body);
    assert.equal((await findRecord<Charge>(db.sql, 'charge', record.id))?.listPriceMinor, 2100000);
    const forged = await upload({
      ...record,
      id: 'charge:forged',
      unitPriceMinor: 10,
      listPriceMinor: 30,
      amountMinor: 30,
    });
    assert.equal(forged.json().rejected[0].category, 'validation');
    assert.equal(await findRecord(db.sql, 'charge', 'charge:forged'), undefined);
    assert.equal(
      Number(
        (
          await db.sql`SELECT amount_minor FROM fee_price_versions WHERE id=${selected.priceVersion!}`
        )[0].amount_minor,
      ),
      700000,
    );
  });
  it('does not acknowledge an older financial outbox after cutover', async () => {
    const pendingId = clientId();
    const response = await call(
      '/sync/upload',
      {
        transactionId: 4,
        schemaVersion: 5,
        policyVersion: POLICY_VERSION,
        facilityContractVersion: 1,
        mutations: [
          { clientId: pendingId, op: 'put', table: 'charge', id: 'charge:pending', data: {} },
        ],
      },
      false,
    );
    assert.equal(response.statusCode, 409);
    assert.equal(
      (
        await db.sql`SELECT 1 FROM applied_mutations WHERE device_id=${f.device.deviceId} AND client_id=${pendingId}`
      ).length,
      0,
    );
  });
  it('preserves the existing fractional-quantity rounding rather than introducing PostgreSQL repricing', async () => {
    const edited = await save([
      {
        clientId: clientId(),
        op: 'patch',
        table: 'fee_item',
        id: 'fee:medicine',
        data: { amountMinor: 100, updatedBy: f.admin.id, updatedOn: new Date().toISOString() },
      },
    ]);
    assert.equal(edited.statusCode, 200);
    const selected = (await findRecord<FeeItem>(db.sql, 'fee_item', 'fee:medicine'))!;
    const patientId = f.facility.id + '-000001-K2';
    const total = Math.round(100 * 0.145);
    const data = {
      ...envelopeFor(f),
      schemaVersion: 6,
      id: 'charge:fraction',
      type: 'charge',
      patientId,
      feeItemId: selected.id,
      category: selected.category,
      description: selected.name,
      feePriceVersion: selected.priceVersion,
      quantity: 0.145,
      unitPriceMinor: 100,
      listPriceMinor: total,
      amountMinor: total,
      currency: 'NGN',
    };
    const result = await call(
      '/sync/upload',
      {
        ...versions,
        transactionId: 1,
        mutations: [{ clientId: clientId(), op: 'put', table: 'charge', id: data.id, data }],
      },
      false,
    );
    assert.deepEqual(result.json().rejected, [], result.body);
    assert.equal((await findRecord<Charge>(db.sql, 'charge', data.id))?.listPriceMinor, total);
  });
  it('accepts fee-only signed investigations, preserves repeated source IDs and requires review of a possible manual bill', async () => {
    const env = { ...envelopeFor(f), schemaVersion: 6 };
    const patientId = f.facility.id + '-000001-K2';
    const encounterId = 'encounter:central-lab';
    const selected = (await findRecord<FeeItem>(db.sql, 'fee_item', 'fee:lab'))!;
    await insertRecord(db.sql, 'encounter', {
      ...env,
      id: encounterId,
      type: 'encounter',
      patientId,
      openedOn: env.createdOn,
      workflowVersion: 1,
    });
    for (const [id, step, values] of [
      ['lab:vitals', 'vitals', { temperatureC: 37 }],
      ['lab:complaint', 'complaint', { complaints: ['Synthetic symptoms'] }],
    ] as const) {
      await insertRecord(db.sql, 'encounter_entry', {
        ...env,
        id,
        type: 'encounter_entry',
        encounterId,
        patientId,
        actorRole: f.admin.role,
        workflowVersion: 1,
        step,
        values,
      });
    }
    const item = (id: string) => ({
      id,
      name: selected.name,
      priority: 'routine',
      catalogueSource: 'billing',
      feeItemId: selected.id,
      feePriceVersion: selected.priceVersion,
      priceMinor: selected.amountMinor,
      currency: selected.currency,
      exemptions: selected.exemptions,
    });
    const send = async (id: string, items: object[]) => {
      const visit = encounterId + ':' + id;
      await insertRecord(db.sql, 'encounter', {
        ...env,
        id: visit,
        type: 'encounter',
        patientId,
        openedOn: env.createdOn,
        workflowVersion: 1,
      });
      for (const [suffix, step, values] of [
        ['vitals', 'vitals', { temperatureC: 37 }],
        ['complaint', 'complaint', { complaints: ['Synthetic symptoms'] }],
      ] as const) {
        await insertRecord(db.sql, 'encounter_entry', {
          ...env,
          id: visit + suffix,
          type: 'encounter_entry',
          encounterId: visit,
          patientId,
          actorRole: f.admin.role,
          workflowVersion: 1,
          step,
          values,
        });
      }
      return call(
        '/sync/upload',
        {
          ...versions,
          clinicalWorkflowVersion: 1,
          transactionId: 1,
          mutations: [
            {
              clientId: clientId(),
              op: 'put',
              table: 'encounter_entry',
              id,
              data: {
                ...env,
                id,
                type: 'encounter_entry',
                encounterId: visit,
                patientId,
                actorRole: f.admin.role,
                workflowVersion: 1,
                step: 'lab_order',
                values: { tests: items.map(() => selected.name), items },
              },
            },
          ],
        },
        false,
      );
    };
    const first = await send('central:order', [item('central:item:one'), item('central:item:two')]);
    assert.deepEqual(first.json().rejected, [], first.body);
    assert.equal(
      (
        await db.sql`SELECT COUNT(*)::int AS n FROM service_definitions WHERE facility_id=${f.facility.id}`
      )[0].n,
      0,
    );
    await insertRecord(db.sql, 'charge', {
      ...env,
      schemaVersion: 5,
      id: 'manual:lab',
      type: 'charge',
      patientId,
      feeItemId: selected.id,
      category: 'laboratory',
      description: selected.name,
      listPriceMinor: selected.amountMinor,
      amountMinor: selected.amountMinor,
      currency: selected.currency,
    });
    const blocked = await send('central:ambiguous', [item('central:item:three')]);
    assert.match(blocked.json().rejected[0].reason, /manual bill/);
    const review = await send('central:review', [
      { ...item('central:item:review'), billingReviewReason: 'Manual bill needs source review' },
    ]);
    assert.deepEqual(review.json().rejected, [], review.body);
    const extra = await send('central:additional', [
      {
        ...item('central:item:additional'),
        additionalChargeReason: 'Separate repeated investigation confirmed',
      },
    ]);
    assert.deepEqual(extra.json().rejected, [], extra.body);
  });
  it('does not let a financial reviewer clinically sign or amend a Laboratory review source', async () => {
    const cashier = await addStaff(db.sql, f, { role: 'cashier' });
    const original = (await findRecord<EncounterEntry>(
      db.sql,
      'encounter_entry',
      'central:review',
    ))!;
    const writes = [
      { ...original, id: 'cashier:lab-order', createdBy: cashier.id, actorRole: 'cashier' },
      {
        ...original,
        id: 'cashier:lab-amendment',
        createdBy: cashier.id,
        actorRole: 'cashier',
        step: 'amendment',
        amends: original.id,
        values: {
          note: 'Financial review is not clinical authorization',
          correctedValues: original.values,
        },
      },
    ];
    const result = await call(
      '/sync/upload',
      {
        ...versions,
        clinicalWorkflowVersion: 1,
        transactionId: 1,
        mutations: writes.map((data) => ({
          clientId: clientId(),
          op: 'put',
          table: 'encounter_entry',
          id: data.id,
          data,
        })),
      },
      false,
    );
    assert.equal(result.json().applied, 0, result.body);
    assert.ok(
      result.json().rejected.every((r: { category: string }) => r.category === 'authorization'),
      result.body,
    );
    assert.deepEqual(await findRecord(db.sql, 'encounter_entry', original.id), original);
    for (const data of writes) {
      assert.equal(await findRecord(db.sql, 'encounter_entry', data.id), undefined);
    }
  });
});
