import { it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMigrations, migrate } from '../src/db/migrate.ts';
import { insertRecord } from '../src/db/records.ts';
import { envelopeFor, registerScratchFacility, scratchDatabase } from './postgres.ts';

it('upgrades populated Release 1 data without rewriting prices, charges, stock links or historical price versions', async () => {
  const migrations = await loadMigrations();
  const db = await scratchDatabase(migrations.filter((m) => m.version < 41));

  try {
    const f = await registerScratchFacility(db.sql);
    const base = envelopeFor(f);
    const patientId = f.facility.id + '-000001-K2';
    await insertRecord(db.sql, 'patient', {
      ...base,
      id: patientId,
      type: 'patient',
      patientId,
      fullName: 'Synthetic',
      address: 'Synthetic',
      sex: 'female',
      ageYears: 30,
    });

    await insertRecord(db.sql, 'fee_item', {
      ...base,
      id: 'fee:existing',
      type: 'fee_item',
      name: 'Intentional visit fee',
      category: 'consultation',
      amountMinor: 400000,
      currency: 'NGN',
      chargeWhen: 'every_visit',
      exemptions: [],
      active: true,
    });

    await insertRecord(db.sql, 'stock_item', {
      ...base,
      id: 'stock:legacy',
      type: 'stock_item',
      name: 'Legacy stock',
      category: 'drug',
      unitOfMeasure: 'vials',
      quantityOnHand: 5,
      feeItemId: 'fee:existing',
    });

    await insertRecord(db.sql, 'charge', {
      ...base,
      id: 'charge:history',
      type: 'charge',
      patientId,
      feeItemId: 'fee:existing',
      category: 'consultation',
      description: 'Original visit',
      listPriceMinor: 400000,
      amountMinor: 400000,
      currency: 'NGN',
    });

    const [before] = await db.sql`SELECT * FROM fee_items WHERE id='fee:existing'`;
    const oldPrices = await db.sql`SELECT * FROM fee_price_versions ORDER BY id`;
    const oldCharges = await db.sql`SELECT * FROM charges ORDER BY id`;
    const oldStock = await db.sql`SELECT * FROM stock_items ORDER BY id`;
    await migrate(db.sql, migrations);
    const [after] = await db.sql`SELECT * FROM fee_items WHERE id='fee:existing'`;
    const { price_version: oldHead, ...original } = before;
    const { price_version: newHead, price_evidence_version, description, ...unchanged } = after;
    assert.equal(description, null);
    assert.deepEqual(unchanged, original);
    assert.notEqual(newHead, oldHead);
    assert.equal(price_evidence_version, 1);

    for (const old of oldPrices) {
      assert.deepEqual(
        (
          await db.sql`SELECT id,facility_id,fee_item_id,amount_minor,currency,recorded_on FROM fee_price_versions WHERE id=${old.id}`
        )[0],
        old,
      );
    }

    for (const old of oldCharges) {
      const now = (await db.sql`SELECT * FROM charges WHERE id=${old.id}`)[0];

      for (const key of Object.keys(old)) {
        assert.deepEqual(now[key], old[key]);
      }

      assert.equal(now.fee_price_version, null);
    }

    assert.deepEqual(await db.sql`SELECT * FROM stock_items ORDER BY id`, oldStock);
    assert.equal(
      (await db.sql`SELECT to_regclass('charge_service_link') AS relation`)[0].relation,
      null,
    );
  } finally {
    await db.drop();
  }
});
