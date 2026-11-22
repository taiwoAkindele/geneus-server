import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { POLICY_VERSION, type FacilityRegistrationResult, type FeeItem } from '#shared';
import { findRecord, insertRecord } from '../src/db/records.ts';
import { chargePriceIssues } from '../src/billing/catalogue.ts';
import {
  addStaff,
  asDevice,
  clientId,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
  staffSessionFor,
  testApp,
  type ScratchDatabase,
} from './postgres.ts';

describe('Billing design atomic import and additive bill references', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let f: FacilityRegistrationResult;
  let token: string | undefined;
  const versions = { facilityContractVersion: 1, schemaVersion: 5, policyVersion: POLICY_VERSION };

  const fee = (id: string, name = id, chargeWhen = 'when_ordered') => ({
    clientId: clientId(),
    op: 'put',
    table: 'fee_item',
    id,
    data: {
      ...envelopeFor(f),
      createdBy: f.admin.id,
      id,
      type: 'fee_item',
      name,
      category: 'consultation',
      amountMinor: 10000,
      currency: 'NGN',
      chargeWhen,
      exemptions: [],
      description: 'Optional text',
    },
  });

  const save = (mutations: unknown[], session = token) =>
    app.inject({
      method: 'POST',
      url: '/config/save?billingImport=1',
      headers: {
        ...asDevice(f.device.credential),
        ...(session ? { 'x-staff-session': session } : {}),
      },
      payload: { ...versions, transactionId: null, mutations },
    });

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    f = await registerScratchFacility(db.sql);
    token = await staffSessionFor(app, f.device.credential, f.admin.id);
    const patientId = f.facility.id + '-000001-K2';
    await insertRecord(db.sql, 'patient', {
      ...envelopeFor(f),
      createdBy: f.admin.id,
      id: patientId,
      type: 'patient',
      patientId,
      fullName: 'Synthetic patient',
      address: 'Synthetic',
      sex: 'female',
      ageYears: 30,
    });
  });

  after(async () => {
    await app?.close();
    await db?.drop();
  });

  it('requires a verified staff session for bulk configuration', async () => {
    assert.equal((await save([fee('unauth')], '')).statusCode, 403);
    assert.equal(await findRecord(db.sql, 'fee_item', 'unauth'), undefined);
  });

  it('rolls back every item and its mutation ledger when a later item is refused', async () => {
    const first = fee('rollback:first');
    const last = fee('rollback:last', 'Unsafe', 'every_visit');
    const response = await save([first, last]);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(await findRecord(db.sql, 'fee_item', first.id), undefined);
    assert.equal(await findRecord(db.sql, 'fee_item', last.id), undefined);

    const ledger =
      await db.sql`SELECT * FROM applied_mutations WHERE device_id=${f.device.deviceId} AND client_id=${first.clientId}`;

    assert.equal(ledger.length, 0);
  });

  it('imports safe items and retries the same mutations without duplicates', async () => {
    const batch = [fee('import:a'), fee('import:b')];
    const first = await save(batch);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().applied, 2);
    const second = await save(batch);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().duplicates, 2);
    assert.equal(
      (await findRecord<FeeItem>(db.sql, 'fee_item', 'import:a'))?.description,
      'Optional text',
    );
  });

  it('refuses duplicate normalized catalogue names atomically, including within the file', async () => {
    const response = await save([fee('dup:1', 'Unique sample'), fee('dup:2', ' unique SAMPLE ')]);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(await findRecord(db.sql, 'fee_item', 'dup:1'), undefined);
  });

  it('rejects policy/category patches, deletes and oversized batches at the import boundary', async () => {
    for (const data of [
      { category: 'laboratory' },
      { chargeWhen: 'every_visit' },
      { exemptions: [] },
    ]) {
      assert.equal(
        (
          await save([
            {
              clientId: clientId(),
              table: 'fee_item',
              id: 'import:a',
              op: 'patch',
              data: { ...data, updatedBy: f.admin.id, updatedOn: new Date().toISOString() },
            },
          ])
        ).statusCode,
        400,
      );
    }

    assert.equal(
      (
        await save([
          {
            clientId: clientId(),
            table: 'fee_item',
            id: 'import:a',
            op: 'delete',
            data: { updatedBy: f.admin.id },
          },
        ])
      ).statusCode,
      400,
    );

    assert.equal(
      (await save(Array.from({ length: 501 }, (_, i) => fee(`large:${i}`)))).statusCode,
      400,
    );
  });

  it('keeps catalogue management permissions on bulk import', async () => {
    const cashier = await addStaff(db.sql, f, { role: 'cashier' });
    const session = await staffSessionFor(app, f.device.credential, cashier.id);
    const item = fee('cashier:import');
    item.data.createdBy = cashier.id;
    assert.equal((await save([item], session)).statusCode, 409);
    assert.equal(await findRecord(db.sql, 'fee_item', item.id), undefined);
  });

  it('updates a legacy automatic price without changing its policy or historical charge', async () => {
    token = await staffSessionFor(app, f.device.credential, f.admin.id);
    await insertRecord(db.sql, 'fee_item', { ...fee('legacy:auto', 'Legacy', 'every_visit').data });

    const charge = {
      ...envelopeFor(f),
      createdBy: f.admin.id,
      id: 'historic:charge',
      type: 'charge' as const,
      patientId: f.facility.id + '-000001-K2',
      feeItemId: 'legacy:auto',
      description: 'Historic name',
      category: 'consultation' as const,
      listPriceMinor: 10000,
      amountMinor: 10000,
      currency: 'NGN',
    };

    await insertRecord(db.sql, 'charge', charge);
    const before = await findRecord(db.sql, 'charge', charge.id);

    const response = await save([
      {
        clientId: clientId(),
        table: 'fee_item',
        id: 'legacy:auto',
        op: 'patch',
        data: {
          amountMinor: 12000,
          description: 'Updated',
          updatedBy: f.admin.id,
          updatedOn: new Date().toISOString(),
        },
      },
    ]);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      (await findRecord<FeeItem>(db.sql, 'fee_item', 'legacy:auto'))?.chargeWhen,
      'every_visit',
    );

    assert.deepEqual(await findRecord(db.sql, 'charge', charge.id), before);
  });

  it('keeps bill metadata additive and rejects a reference spanning patients or currencies', async () => {
    const billId = 'b9dc902f-9287-41be-a0dd-6455e1ed3341';

    const charge = {
      ...envelopeFor(f),
      createdBy: f.admin.id,
      schemaVersion: 5,
      id: 'bill:scope',
      type: 'charge' as const,
      billId,
      patientId: f.facility.id + '-000001-K2',
      feeItemId: 'legacy:auto',
      description: 'Bill item',
      category: 'consultation' as const,
      listPriceMinor: 10000,
      amountMinor: 10000,
      currency: 'NGN',
    };

    await insertRecord(db.sql, 'charge', charge);
    await db.sql.begin(async (tx) => {
      assert.match(
        (await chargePriceIssues(tx, { ...charge, id: 'cross', patientId: 'another' })).join(' '),
        /patient/,
      );

      assert.match(
        (await chargePriceIssues(tx, { ...charge, id: 'currency', currency: 'USD' })).join(' '),
        /currency/,
      );
    });

    assert.equal(
      (await db.sql`SELECT bill_id FROM charges WHERE id='historic:charge'`)[0].bill_id,
      null,
    );
  });
});
