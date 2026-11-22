import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EncounterEntry,
  ServiceChargeAllocation,
  dispensingSummary,
  serviceFulfillment,
  type Charge,
  type FeeItem,
  type UploadMutation,
  type DispensingDetails,
  type ServiceChargeAllocation as Allocation,
} from '#shared';
import { insertRecord, findRecord, fromRow } from '../src/db/records.ts';
import { pharmacyRecords } from '../src/clinical/pharmacy.ts';
import { buildPatientStatement } from '../src/billing/patientStatements.ts';
import {
  addStaff,
  asDevice,
  clientId,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
  staffSessionFor,
  testApp,
  upload,
} from './postgres.ts';

describe('integrated prepayment, clinical supply, association, return, refund and statement', () => {
  let db: Awaited<ReturnType<typeof scratchDatabase>>;
  let f: Awaited<ReturnType<typeof registerScratchFacility>>;
  let app: ReturnType<typeof testApp>;
  let base: ReturnType<typeof envelopeFor> & { schemaVersion: number };
  let patientId: string;
  let rx: EncounterEntry;
  let pharmacist: Awaited<ReturnType<typeof addStaff>>;
  let cashier: Awaited<ReturnType<typeof addStaff>>;
  let charge: Charge;
  let first: EncounterEntry;
  let second: EncounterEntry;
  let returned: EncounterEntry;
  const versions = {
    integratedBillingVersion: 1,
    billingCatalogueVersion: 1,
    schemaVersion: 7,
    policyVersion: 17,
    facilityContractVersion: 1,
    clinicalWorkflowVersion: 1,
    pharmacyWorkflowVersion: 1,
  } as const;
  const send = (...mutations: UploadMutation[]) =>
    upload(app, f.device.credential, { ...versions, transactionId: null, mutations });
  const mutation = (record: Record<string, unknown>): UploadMutation => ({
    clientId: clientId(),
    op: 'put',
    table: record.type as UploadMutation['table'],
    id: String(record.id),
    data: record,
  });
  const association = (
    id: string,
    source: EncounterEntry,
    quantity: number,
    changes: Partial<Allocation> = {},
  ) =>
    ServiceChargeAllocation.parse({
      ...base,
      id,
      type: 'service_charge_allocation',
      createdBy: cashier.id,
      patientId,
      chargeId: charge.id,
      sourceKind: 'pharmacy',
      sourceEntryId: source.id,
      sourceItemId: source.id,
      action: 'allocate',
      quantity,
      unit: 'tablets',
      reason: 'Reviewed exact prepaid purchase against actual signed supply',
      ...changes,
    });
  const supply = async (id: string, d: DispensingDetails) => {
    const data = await pharmacyRecords(db.sql as never, rx);
    const e = EncounterEntry.parse({
      ...base,
      id,
      type: 'encounter_entry',
      createdBy: pharmacist.id,
      createdOn: new Date().toISOString(),
      patientId,
      encounterId: rx.encounterId,
      actorRole: 'pharmacy_staff',
      workflowVersion: 1,
      pharmacyVersion: 1,
      step: 'dispense',
      values: {
        supply: d,
        lines: [{ drug: 'Synthetic medication', dispensed: false, reason: 'Pending' }],
      },
    });
    e.values.lines = dispensingSummary(rx, data.entries, e);
    const result = await send(mutation(e));
    assert.deepEqual(result.rejected, []);
    return e;
  };
  before(async () => {
    db = await scratchDatabase();
    f = await registerScratchFacility(db.sql);
    app = testApp(db.sql);
    base = { ...envelopeFor(f), schemaVersion: 7 };
    patientId = f.facility.id + '-000001-K2';
    pharmacist = await addStaff(db.sql, f, { role: 'pharmacy_staff' });
    cashier = await addStaff(db.sql, f, { role: 'cashier' });
    await db.sql`UPDATE facilities SET billing_catalogue_version=1,integrated_billing_version=1 WHERE id=${f.facility.id}`;
    await insertRecord(db.sql, 'patient', {
      ...base,
      id: patientId,
      type: 'patient',
      patientId,
      fullName: 'Synthetic prepaid patient',
      sex: 'female',
      ageYears: 30,
      address: 'Synthetic address',
    });
    await insertRecord(db.sql, 'encounter', {
      ...base,
      id: 'visit:prepaid',
      type: 'encounter',
      patientId,
      openedOn: base.createdOn,
    });
    rx = EncounterEntry.parse({
      ...base,
      id: 'rx:prepaid',
      type: 'encounter_entry',
      patientId,
      encounterId: 'visit:prepaid',
      actorRole: 'doctor',
      workflowVersion: 1,
      step: 'prescription',
      values: {
        decision: 'prescribed',
        prescription: [
          {
            lineId: 'line:prepaid',
            drug: 'Synthetic medication',
            dose: 'Synthetic instructions',
            quantity: 3,
            unitOfMeasure: 'tablets',
          },
        ],
      },
    });
    await insertRecord(db.sql, 'encounter_entry', rx);
    await insertRecord(db.sql, 'fee_item', {
      ...base,
      id: 'fee:prepaid',
      type: 'fee_item',
      name: 'Synthetic medication',
      category: 'pharmacy',
      amountMinor: 450000,
      currency: 'NGN',
      chargeWhen: 'when_ordered',
    });
    const fee = (await findRecord<FeeItem>(db.sql, 'fee_item', 'fee:prepaid'))!;
    await insertRecord(db.sql, 'stock_item', {
      ...base,
      id: 'stock:prepaid',
      type: 'stock_item',
      name: 'Synthetic medication',
      category: 'drug',
      unitOfMeasure: 'tablets',
      quantityOnHand: 100,
      feeItemId: fee.id,
    });
    await insertRecord(db.sql, 'charge', {
      ...base,
      id: 'charge:prepaid',
      type: 'charge',
      patientId,
      feeItemId: fee.id,
      category: fee.category,
      description: fee.name,
      currency: 'NGN',
      listPriceMinor: 1350000,
      amountMinor: 1350000,
      quantity: 3,
      unitOfMeasure: 'tablets',
      unitPriceMinor: 450000,
      feePriceVersion: fee.priceVersion,
    });
    charge = (await findRecord<Charge>(db.sql, 'charge', 'charge:prepaid'))!;
    const paid = {
      ...base,
      id: 'payment:prepaid',
      type: 'payment',
      createdBy: cashier.id,
      patientId,
      receiptNumber: f.facility.id + '-R-000001-Q2',
      method: 'cash',
      currency: 'NGN',
      amountMinor: 1350000,
      allocations: [{ chargeId: charge.id, amountMinor: 1350000 }],
    };
    assert.deepEqual((await send(mutation(paid))).rejected, []);
  });
  after(async () => {
    await app?.close();
    await db?.drop();
  });
  it('retains one fully paid charge while actual 2+1 supplies consume exact purchased quantity', async () => {
    const details = (quantity: number, previousEntryId?: string): DispensingDetails => ({
      catalogueVersion: 1,
      prescriptionEntryId: rx.id,
      lineId: 'line:prepaid',
      action: 'supply',
      complete: quantity === 1,
      quantity,
      unit: 'tablets',
      source: 'stock',
      stockItemId: 'stock:prepaid',
      billing: 'unpriced',
      reason: 'Possible existing prepaid charge needs exact financial association',
      ...(previousEntryId ? { previousEntryId } : {}),
    });
    first = await supply('supply:two', details(2));
    assert.deepEqual((await send(mutation(association('association:two', first, 2)))).rejected, []);
    second = await supply('supply:one', details(1, first.id));
    const m = mutation(association('association:one', second, 1));
    assert.deepEqual((await send(m)).rejected, []);
    assert.equal((await send(m)).duplicates, 1);
    assert.equal((await db.sql`SELECT id FROM charges WHERE patient_id=${patientId}`).length, 1);
    assert.equal((await db.sql`SELECT id FROM payments WHERE patient_id=${patientId}`).length, 1);
    const [stock] =
      await db.sql`SELECT SUM(change) AS n FROM stock_movements WHERE item_id='stock:prepaid'`;
    assert.equal(Number(stock.n), -3);
    const associations = (await db.sql`SELECT * FROM service_charge_allocations`).map((r) =>
      fromRow<Allocation>('service_charge_allocation', r),
    );
    const evidence = serviceFulfillment(charge, {
      associations,
      associatedEntries: [first, second],
      results: [],
      visitEntries: [],
    });
    assert.equal(evidence.kind, 'association');
    if (evidence.kind === 'association') {
      assert.deepEqual(evidence.entryIds.sort(), [first.id, second.id].sort());
    }
  });
  it('refuses duplicate consumption without losing clinical facts or money and attributes the review', async () => {
    const result = await send(mutation(association('association:duplicate', first, 1)));
    assert.equal(result.rejected.length, 1);
    const [review] =
      await db.sql`SELECT * FROM sync_rejections WHERE entity_id='association:duplicate'`;
    assert.equal(review.attributed_to, cashier.id);
    assert.equal(review.refused_record.sourceEntryId, first.id);
    assert.ok(await findRecord(db.sql, 'encounter_entry', first.id));
    assert.ok(await findRecord(db.sql, 'payment', 'payment:prepaid'));
  });
  it('records the actual partial return first, then an authorized release and credit, without restating a price', async () => {
    returned = await supply('return:one', {
      prescriptionEntryId: rx.id,
      lineId: 'line:prepaid',
      previousEntryId: second.id,
      action: 'return',
      returnOf: first.id,
      complete: false,
      quantity: 1,
      unit: 'tablets',
      restock: true,
      creditMinor: 0,
      reason: 'Patient returned one intact unit',
    });
    assert.equal((await db.sql`SELECT id FROM billing_adjustments`).length, 0);
    const request = association('release:return', first, 1, {
      action: 'release',
      reversesId: 'association:two',
      returnEntryId: returned.id,
      creditReturnedUnits: true,
      createdBy: f.admin.id,
    });
    assert.deepEqual((await send(mutation(request))).rejected, []);
    const [credit] =
      await db.sql`SELECT amount_minor FROM billing_adjustments WHERE charge_id=${charge.id}`;
    assert.equal(Number(credit.amount_minor), 450000);
    assert.equal((await findRecord<Charge>(db.sql, 'charge', charge.id))?.listPriceMinor, 1350000);
    const proof = await staffSessionFor(app, f.device.credential, f.admin.id);
    const refund = await app.inject({
      method: 'POST',
      url: '/billing/refunds',
      headers: {
        ...asDevice(f.device.credential),
        'x-staff-session': proof!,
        'x-billing-catalogue-version': '1',
        'x-integrated-billing-version': '1',
      },
      payload: {
        id: 'refund:prepaid123',
        patientId,
        method: 'cash',
        currency: 'NGN',
        allocations: [{ chargeId: charge.id, amountMinor: 450000 }],
        reason: 'Refund the approved returned unit',
      },
    });
    assert.equal(refund.statusCode, 201, refund.body);
    const snapshot = await db.sql.begin((tx) =>
      buildPatientStatement(tx as never, f.facility.id, patientId, 'NGN', new Date().toISOString()),
    );
    assert.equal(snapshot.totals.originalMinor, 1350000);
    assert.equal(snapshot.totals.netMinor, 900000);
    assert.equal(snapshot.totals.patientReceivedMinor, 1350000);
    assert.equal(snapshot.totals.patientRefundedMinor, 450000);
    assert.equal(snapshot.totals.patientBalanceMinor, 0);
    assert.equal(snapshot.categories[0].totals.netMinor, snapshot.totals.netMinor);
  });
  it('blocks credited quantity reuse and denies a cashier clinical signing or an unauthorized return credit', async () => {
    const reconsume = association('association:credited', second, 1);
    assert.equal((await send(mutation(reconsume))).rejected.length, 1);
    const forged = { ...first, id: 'supply:cashier', createdBy: cashier.id };
    assert.equal((await send(mutation(forged))).rejected.length, 1);
    const badCredit = association('release:cashier', second, 1, {
      action: 'release',
      reversesId: 'association:one',
      returnEntryId: returned.id,
      creditReturnedUnits: true,
    });
    assert.equal((await send(mutation(badCredit))).rejected.length, 1);
  });
  it('never reuses withdrawn clinical quantity against a different new purchase after a credited return', async () => {
    await insertRecord(db.sql, 'charge', {
      ...charge,
      id: 'charge:another-purchase',
      quantity: 1,
      listPriceMinor: 450000,
      amountMinor: 450000,
    });
    const result = await send(
      mutation(
        association('association:withdrawn-reuse', first, 1, {
          chargeId: 'charge:another-purchase',
        }),
      ),
    );
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0].reason, /returned/);
  });
  const laboratory = async (id: string, quantity: number) => {
    const feeId = 'fee:' + id;
    await insertRecord(db.sql, 'fee_item', {
      ...base,
      id: feeId,
      type: 'fee_item',
      name: 'Synthetic repeated investigation',
      category: 'laboratory',
      amountMinor: 10000,
      currency: 'NGN',
      chargeWhen: 'when_ordered',
    });
    const fee = (await findRecord<FeeItem>(db.sql, 'fee_item', feeId))!;
    await insertRecord(db.sql, 'charge', {
      ...base,
      id: 'charge:' + id,
      type: 'charge',
      patientId,
      feeItemId: fee.id,
      category: 'laboratory',
      description: fee.name,
      quantity,
      unitOfMeasure: 'item',
      unitPriceMinor: 10000,
      feePriceVersion: fee.priceVersion,
      listPriceMinor: 10000 * quantity,
      amountMinor: 10000 * quantity,
      currency: 'NGN',
    });
    const order = EncounterEntry.parse({
      ...base,
      id: 'order:' + id,
      type: 'encounter_entry',
      patientId,
      encounterId: rx.encounterId,
      actorRole: 'doctor',
      workflowVersion: 1,
      step: 'lab_order',
      values: {
        tests: [fee.name, fee.name],
        items: ['a', 'b'].map((suffix) => ({
          id: id + ':' + suffix,
          name: fee.name,
          catalogueSource: 'billing',
          feeItemId: fee.id,
          feePriceVersion: fee.priceVersion,
          priceMinor: 10000,
          currency: 'NGN',
          billingReviewReason: 'Review exact existing manual bill',
          additionalChargeReason: 'Repeat investigation clinically indicated',
        })),
      },
    });
    await insertRecord(db.sql, 'encounter_entry', order);
    const a = (suffix: string) =>
      ServiceChargeAllocation.parse({
        ...base,
        id: 'association:' + id + ':' + suffix,
        type: 'service_charge_allocation',
        createdBy: cashier.id,
        patientId,
        chargeId: 'charge:' + id,
        sourceKind: 'laboratory',
        sourceEntryId: order.id,
        sourceItemId: id + ':' + suffix,
        action: 'allocate',
        quantity: 1,
        unit: 'item',
        reason: 'Exact signed repeat investigation and prepaid quantity reviewed',
      });
    return { fee, order, a };
  };
  it('supports repeated legitimate investigations by exact item IDs and preserves the original price after catalogue edits', async () => {
    const scene = await laboratory('repeated', 2);
    const before = await findRecord<Charge>(db.sql, 'charge', 'charge:repeated');
    await db.sql`UPDATE fee_items SET amount_minor=20000 WHERE id=${scene.fee.id}`;
    assert.deepEqual((await send(mutation(scene.a('a')), mutation(scene.a('b')))).rejected, []);
    assert.deepEqual(await findRecord(db.sql, 'charge', 'charge:repeated'), before);
    const duplicate = scene.a('a');
    duplicate.id = 'association:duplicate-repeat';
    assert.equal((await send(mutation(duplicate))).rejected.length, 1);
  });
  it('serializes two offline intentions competing for one remaining purchased unit while retaining both signed investigations', async () => {
    const scene = await laboratory('race', 1);
    const results = await Promise.all([send(mutation(scene.a('a'))), send(mutation(scene.a('b')))]);
    assert.equal(
      results.reduce((n, r) => n + r.applied, 0),
      1,
    );
    assert.equal(
      results.reduce((n, r) => n + r.rejected.length, 0),
      1,
    );
    assert.ok(await findRecord(db.sql, 'encounter_entry', scene.order.id));
    assert.equal(
      (await db.sql`SELECT id FROM service_charge_allocations WHERE charge_id='charge:race'`)
        .length,
      1,
    );
    assert.equal(
      (
        await db.sql`SELECT id FROM sync_rejections WHERE entity_id IN ('association:race:a','association:race:b')`
      ).length,
      1,
    );
  });
});
