import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import {
  POLICY_VERSION,
  SCHEMA_VERSION,
  type FacilityRegistrationResult,
  type StockItem,
  type UploadMutation,
} from '#shared';
import { findRecord } from '../src/db/records.ts';
import {
  asDevice,
  clientId,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
  staffSessionFor,
  testApp,
  type ScratchDatabase,
} from './postgres.ts';

describe('atomic medicines import', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let facility: FacilityRegistrationResult;
  let session: string;
  const versions = {
    facilityContractVersion: 1,
    schemaVersion: SCHEMA_VERSION,
    policyVersion: POLICY_VERSION,
    integratedBillingVersion: 1,
    billingCatalogueVersion: 1,
    pharmacyWorkflowVersion: 1,
    clinicalWorkflowVersion: 1,
  } as const;

  before(async () => {
    db = await scratchDatabase();
    await db.sql`UPDATE schema_migrations SET applied_on=now()-interval '2 days' WHERE version=41`;
    facility = await registerScratchFacility(db.sql);
    app = testApp(db.sql);
    const verified = await staffSessionFor(app, facility.device.credential, facility.admin.id);
    assert.ok(verified);
    session = verified;
    const handshake = await app.inject({
      method: 'POST',
      url: '/sync/token',
      headers: asDevice(facility.device.credential),
      payload: { ...versions, pendingMutationCount: 0 },
    });
    assert.equal(handshake.statusCode, 200, handshake.body);
    assert.equal(handshake.json().billingCatalogueEnabled, true, handshake.body);
  });

  after(async () => {
    await app?.close();
    await db?.drop();
  });

  const put = (
    table: UploadMutation['table'],
    id: string,
    data: Record<string, unknown>,
  ): UploadMutation => ({
    clientId: clientId(),
    op: 'put',
    table,
    id,
    data: { ...envelopeFor(facility), schemaVersion: SCHEMA_VERSION, id, type: table, ...data },
  });

  const price = (id: string, name: string) =>
    put('fee_item', id, {
      name,
      category: 'pharmacy',
      currency: 'NGN',
      amountMinor: 12000,
      chargeWhen: 'when_ordered',
      active: true,
    });

  const medicine = (
    id: string,
    name: string,
    feeItemId: string,
    expectedAmount = 12000,
  ): UploadMutation => ({
    ...put('stock_item', id, {
      name,
      category: 'drug',
      unitOfMeasure: 'tablet',
      quantityOnHand: 20,
      feeItemId,
    }),
    previous: { amountMinor: expectedAmount },
  });

  const save = (mutations: UploadMutation[], token = session) =>
    app.inject({
      method: 'POST',
      url: '/config/stock-import',
      headers: { ...asDevice(facility.device.credential), 'x-staff-session': token },
      payload: {
        transactionId: null,
        mutations,
        ...versions,
      },
    });

  it('saves a price and its linked opening stock and recognizes an exact replay', async () => {
    const fee = price('fee:medicine-import', 'Zinc 20 mg (tablet)');
    const item = medicine('stock:medicine-import', 'Zinc 20 mg', fee.id);
    const result = await save([item, fee]);

    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().applied, 2);

    const saved = await findRecord<StockItem>(db.sql, 'stock_item', item.id);
    assert.equal(saved?.feeItemId, fee.id);
    assert.equal(saved.quantityOnHand, 20);

    const replay = await save([item, fee]);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().duplicates, 2);

    const duplicate = medicine('stock:duplicate-import', ' zinc 20 mg ', fee.id);
    const refused = await save([duplicate]);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(await findRecord(db.sql, 'stock_item', duplicate.id), undefined);
  });

  it('rolls back earlier creates when a later row has the wrong expected selling price', async () => {
    const fee = price('fee:rolled-back-import', 'Paracetamol 500 mg (tablet)');
    const valid = medicine('stock:rolled-back-import', 'Paracetamol 500 mg', fee.id);
    const stale = medicine('stock:stale-price', 'Paracetamol 100 mg', fee.id, 9000);
    const result = await save([fee, valid, stale]);

    assert.equal(result.statusCode, 409, result.body);
    assert.match(result.body, /selected Pharmacy price is missing or has changed/);
    assert.equal(await findRecord(db.sql, 'fee_item', fee.id), undefined);
    assert.equal(await findRecord(db.sql, 'stock_item', valid.id), undefined);
    assert.equal(await findRecord(db.sql, 'stock_item', stale.id), undefined);
  });

  it('requires verified staff and rejects an orphan price or an edit', async () => {
    const fee = price('fee:orphan-import', 'Unlinked price');
    const item = medicine('stock:unauthorized-import', 'Imported item', fee.id);
    assert.equal((await save([fee, item], '')).statusCode, 403);
    assert.equal((await save([fee])).statusCode, 400);
    assert.equal(
      (
        await save([
          fee,
          { ...item, op: 'patch', data: { ...item.data, updatedBy: facility.admin.id } },
        ])
      ).statusCode,
      400,
    );
  });

  it('accepts 500 medicines and their prices in one request and refuses a larger file', async () => {
    const batch = Array.from({ length: 500 }, (_, index) => {
      const name = `Synthetic medicine ${index} ${'長'.repeat(290)}`;
      const fee = price(`fee:full-import:${index}`, `${name} (tablet)`);
      return [fee, medicine(`stock:full-import:${index}`, name, fee.id)];
    }).flat();
    const extraFee = price('fee:too-many-items', 'Extra medicine (tablet)');
    const extraItem = medicine('stock:too-many-items', 'Extra medicine', extraFee.id);

    const tooLarge = await save([...batch, extraFee, extraItem]);
    assert.equal(tooLarge.statusCode, 400, tooLarge.body);

    const result = await save(batch);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().applied, 1000);
  });
});
