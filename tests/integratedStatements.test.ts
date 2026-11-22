import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPatientStatement } from '../src/billing/patientStatements.ts';
import { seedInsuredStatement } from './integratedInsuranceFixture.ts';
import {
  addStaff,
  asDevice,
  registerScratchFacility,
  scratchDatabase,
  staffSessionFor,
  testApp,
} from './postgres.ts';
import { RemittanceInput } from '#shared';
import { recordRemittance } from '../src/insurance/settlement.ts';
describe('insured statements and confidentiality against real PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof scratchDatabase>>;
  let f: Awaited<ReturnType<typeof registerScratchFacility>>;
  let app: ReturnType<typeof testApp>;
  let patientId: string;
  before(async () => {
    db = await scratchDatabase();
    f = await registerScratchFacility(db.sql);
    app = testApp(db.sql);
    patientId = f.facility.id + '-000003-K2';
    await seedInsuredStatement(db.sql, f, patientId);
    await db.sql`UPDATE facilities SET billing_catalogue_version=1,integrated_billing_version=1 WHERE id=${f.facility.id}`;
  });
  after(async () => {
    await app?.close();
    await db?.drop();
  });
  it('reuses the confirmed split and claim-level settlement with the correct adjustment sign', async () => {
    const s = await db.sql.begin((tx) =>
      buildPatientStatement(tx as never, f.facility.id, patientId, 'NGN', new Date().toISOString()),
    );
    assert.equal(s.totals.originalMinor, 1000000);
    assert.equal(s.totals.contractAdjustmentMinor, 100000);
    assert.equal(s.totals.netMinor, 900000);
    assert.equal(s.totals.patientMinor, 90000);
    assert.equal(s.totals.payerMinor, 810000);
    assert.equal(s.totals.payerReceivedMinor, 400000);
    assert.equal(s.totals.payerOutstandingMinor, 410000);
    assert.equal(s.totals.patientOutstandingMinor, 40000);
    assert.equal(s.claims.length, 1);
    assert.equal('payerReceivedMinor' in s.lines[0], false);
  });
  it('allows a verified cashier to print permitted amounts without any confidential contract read access', async () => {
    const staff = await addStaff(db.sql, f, { role: 'cashier' });
    const proof = await staffSessionFor(app, f.device.credential, staff.id);
    const headers = {
      ...asDevice(f.device.credential),
      'x-staff-session': proof!,
      'x-billing-catalogue-version': '1',
      'x-integrated-billing-version': '1',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/billing/statements/patient',
      headers,
      payload: { patientId, currency: 'NGN' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().totals.payerReceivedMinor, 400000);
    for (const secret of [
      'termsSlice',
      'tariff',
      'contractVersionId',
      'enrolleeNumber',
      'inputs',
    ]) {
      assert.ok(!response.body.includes(secret), secret);
    }
    assert.equal(
      (await app.inject({ method: 'POST', url: '/insurance/contracts/list', headers, payload: {} }))
        .statusCode,
      403,
    );
    const spoof = await app.inject({
      method: 'POST',
      url: '/billing/statements/patient',
      headers: { ...asDevice(f.device.credential), 'x-actor-staff-id': staff.id },
      payload: { patientId, currency: 'NGN' },
    });
    assert.equal(spoof.statusCode, 403);
    const foreign = await app.inject({
      method: 'POST',
      url: '/billing/statements/patient',
      headers,
      payload: { patientId: 'OTHER-000001-K2', currency: 'NGN' },
    });
    assert.equal(foreign.statusCode, 409);
  });
  it('creates a safe public immutable summary and keeps its confidential source outside replication', async () => {
    const [publicRow] =
      await db.sql`SELECT * FROM coverage_financial_summaries WHERE patient_id=${patientId}`;
    assert.equal(publicRow.payer_share_minor, 810000);
    assert.equal('inputs' in publicRow, false);
    await assert.rejects(db.sql`UPDATE coverage_financial_summaries SET payer_share_minor=0`);
    const published = (
      await db.sql`SELECT tablename FROM pg_publication_tables WHERE pubname='powersync'`
    ).map((r) => r.tablename);
    assert.ok(published.includes('coverage_financial_summaries'));
    assert.ok(!published.includes('coverage_allocation_details'));
  });
  it('reports unallocated payer funds once at facility level without fabricating patient allocations', async () => {
    await db.sql.begin((tx) =>
      recordRemittance(
        tx as never,
        f.facility.id,
        f.admin.id,
        RemittanceInput.parse({
          payerId: 'payer:integrated',
          receivedOn: new Date().toISOString().slice(0, 10),
          reference: 'UNALLOCATED-CASH',
          amountMinor: 12345,
          currency: 'NGN',
          method: 'cash',
          allocations: [],
          requestKey: 'test:unallocated',
        }),
      ),
    );
    const proof = await staffSessionFor(app, f.device.credential, f.admin.id);
    const response = await app.inject({
      method: 'POST',
      url: '/billing/reports/financial',
      headers: {
        ...asDevice(f.device.credential),
        'x-staff-session': proof!,
        'x-billing-catalogue-version': '1',
        'x-integrated-billing-version': '1',
      },
      payload: { currency: 'NGN' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().payerReceiptsMinor, 412345);
    assert.equal(response.json().unallocatedPayerReceiptsMinor, 12345);
    assert.equal(response.json().statements[0].totals.payerReceivedMinor, 400000);
  });
});
