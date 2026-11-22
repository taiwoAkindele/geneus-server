import { it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMigrations, migrate } from '../src/db/migrate.ts';
import { insertRecord } from '../src/db/records.ts';
import { envelopeFor, registerScratchFacility, scratchDatabase } from './postgres.ts';

it('migrates populated Release 2 history additively and publishes exactly the existing confirmed amounts', async () => {
  const migrations = await loadMigrations();
  const db = await scratchDatabase(migrations.filter((m) => m.version < 42));

  try {
    const f = await registerScratchFacility(db.sql);
    const base = { ...envelopeFor(f), schemaVersion: 6 };
    const patientId = f.facility.id + '-000001-K2';
    await insertRecord(db.sql, 'patient', {
      ...base,
      id: patientId,
      type: 'patient',
      patientId,
      fullName: 'Synthetic legacy',
      sex: 'female',
      ageYears: 30,
      address: 'Synthetic',
    });

    await insertRecord(db.sql, 'payer', {
      ...base,
      id: 'payer:legacy',
      type: 'payer',
      name: 'Legacy synthetic payer',
      code: 'OLD',
      kind: 'hmo',
      active: true,
    });

    await insertRecord(db.sql, 'fee_item', {
      ...base,
      id: 'fee:legacy',
      type: 'fee_item',
      name: 'Intentional automated visit fee',
      category: 'consultation',
      amountMinor: 10000,
      currency: 'NGN',
      chargeWhen: 'every_visit',
    });

    await insertRecord(db.sql, 'charge', {
      ...base,
      id: 'charge:legacy',
      type: 'charge',
      patientId,
      feeItemId: 'fee:legacy',
      description: 'Historic visit',
      category: 'consultation',
      amountMinor: 10000,
      listPriceMinor: 10000,
      currency: 'NGN',
    });

    await insertRecord(db.sql, 'payment', {
      ...base,
      id: 'payment:legacy',
      type: 'payment',
      patientId,
      receiptNumber: f.facility.id + '-R-000001-Q2',
      method: 'cash',
      currency: 'NGN',
      amountMinor: 500,
      allocations: [{ chargeId: 'charge:legacy', amountMinor: 500 }],
    });

    await insertRecord(db.sql, 'coverage_allocation', {
      ...base,
      id: 'allocation:legacy',
      type: 'coverage_allocation',
      patientId,
      chargeId: 'charge:legacy',
      state: 'finalised',
      payerId: 'payer:legacy',
      arrangement: 'per_service',
      patientShareMinor: 1000,
      currency: 'NGN',
      basis: 'visit',
    });

    await db.sql`INSERT INTO coverage_allocation_details(allocation_id,facility_id,calculation_version,inputs,list_price_minor,patient_share_minor,payer_share_minor,contract_adjustment_minor,capitation_covered_minor,request_key)
   VALUES('allocation:legacy',${f.facility.id},1,'{"termsSlice":{"confidential":"synthetic"}}',10000,1000,8000,1000,0,'legacy')`;

    await db.sql`INSERT INTO insurance_remittances(id,facility_id,payer_id,received_on,reference,amount_minor,currency,method,recorded_by) VALUES('remittance:legacy',${f.facility.id},'payer:legacy','2026-11-18','OLD-RECEIPT',3000,'NGN','transfer',${f.admin.id})`;
    await db.sql`INSERT INTO billing_connections(facility_id,encrypted_secret,mode,updated_by) VALUES(${f.facility.id},'synthetic-encrypted-placeholder','live',${f.admin.id})`;
    await db.sql`INSERT INTO billing_receiving_accounts(id,facility_id,provider_account_id,account_number,account_name,bank_name,mode,created_by) VALUES('account:legacy',${f.facility.id},'999','9910000099','Historical general account','Synthetic bank','live',${f.admin.id})`;

    const tables = [
      'charges',
      'payments',
      'fee_items',
      'coverage_allocations',
      'coverage_allocation_details',
      'insurance_remittances',
      'billing_adjustments',
      'refunds',
      'stock_items',
      'stock_movements',
      'billing_connections',
      'billing_receiving_accounts',
    ];

    const snapshots = new Map<string, Record<string, unknown>[]>();

    for (const table of tables) {
      snapshots.set(table, await db.sql.unsafe(`SELECT * FROM ${table} ORDER BY 1`));
    }

    await migrate(db.sql, migrations);

    for (const table of tables) {
      const after = await db.sql.unsafe(`SELECT * FROM ${table} ORDER BY 1`);
      const before = snapshots.get(table)!;
      assert.equal(after.length, before.length, table);

      for (let i = 0; i < before.length; i++) {
        for (const key of Object.keys(before[i])) {
          assert.deepEqual(after[i][key], before[i][key], table + '.' + key);
        }
      }
    }

    const [summary] = await db.sql`SELECT * FROM coverage_financial_summaries`;
    assert.equal(summary.allocation_id, 'allocation:legacy');
    assert.equal(summary.payer_share_minor, 8000);
    assert.equal(summary.contract_adjustment_minor, 1000);
    assert.equal('inputs' in summary, false);
    assert.equal('terms_slice' in summary, false);
    assert.equal(
      (await db.sql`SELECT receiving_account_id FROM billing_connections`)[0].receiving_account_id,
      null,
      'legacy accounts need verification under current provider credentials before selection',
    );

    assert.ok((await migrate(db.sql, migrations)).every((m) => m.outcome === 'already_applied'));
  } finally {
    await db.drop();
  }
});
