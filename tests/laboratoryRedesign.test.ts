import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EncounterEntry, type FeeItem, type InvestigationItem } from '#shared';
import { careWorkflowIssues } from '../src/clinical/careWorkflow.ts';
import { findRecord, insertRecord } from '../src/db/records.ts';
import { recordsInFacility } from '../src/workforce/records.ts';
import {
  asDevice,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
  staffSessionFor,
  testApp,
} from './postgres.ts';

describe('classified Laboratory catalogue and first-price activation', () => {
  let db: Awaited<ReturnType<typeof scratchDatabase>>;
  let app: ReturnType<typeof testApp>;
  let facility: Awaited<ReturnType<typeof registerScratchFacility>>;
  let token: string;

  const post = (url: string, payload: object, verified = true) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: {
        ...asDevice(facility.device.credential),
        ...(verified ? { 'x-staff-session': token } : {}),
      },
    });
  const tests = () => recordsInFacility(db.sql, facility.facility.id, 'service_definition');
  const publish = (prices: unknown[]) => post('/billing/catalogue/laboratory-prices', { prices });

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    facility = await registerScratchFacility(db.sql);
    const session = await staffSessionFor(app, facility.device.credential, facility.admin.id);
    assert.ok(session);
    token = session;
  });

  after(async () => {
    await app?.close();
    await db?.drop();
  });

  it('requires verified staff and explicit specimen rules', async () => {
    const input = {
      name: 'Paired sample example',
      department: 'Chemistry',
      catalogue: { pricingCategory: 'billable', specimenTypes: ['Serum', 'Plasma'] },
    };
    assert.equal(
      (await post('/investigations/catalogue', { tests: [input] }, false)).statusCode,
      403,
    );
    assert.equal((await post('/investigations/catalogue', { tests: [input] })).statusCode, 400);
    assert.equal((await tests()).length, 0);
  });

  it('saves non-billable tests as orderable and activates billable drafts once', async () => {
    const input = [
      {
        name: 'Paired sample example',
        department: 'Chemistry',
        catalogue: {
          pricingCategory: 'billable',
          specimenTypes: ['Serum', 'Plasma'],
          specimenRequirement: 'all',
        },
      },
      {
        name: 'Free screening',
        department: 'Chemistry',
        catalogue: { pricingCategory: 'non_billable', specimenTypes: ['Urine'] },
      },
    ];
    const saved = await post('/investigations/catalogue', { tests: input });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(
      (await post('/investigations/catalogue', { tests: input })).json().skipped.length,
      2,
    );

    const records = await tests();
    const draft = records.find(({ name }) => name === 'Paired sample example');
    const nonBillable = records.find(({ name }) => name === 'Free screening');
    assert.ok(draft && nonBillable);
    assert.equal(draft.orderable, false);
    assert.equal(draft.feeItemId, undefined);
    assert.equal(draft.investigation?.specimen, 'Serum + Plasma (all required)');
    assert.equal(nonBillable.orderable, true);
    assert.equal(nonBillable.feeItemId, undefined);

    const envelope = envelopeFor(facility);
    const patientId = `${facility.facility.code}-000001-K2`;
    const encounterId = 'encounter:classified-laboratory';
    await insertRecord(db.sql, 'patient', {
      ...envelope,
      id: patientId,
      patientId,
      fullName: 'Synthetic patient',
      ageYears: 30,
      sex: 'female',
      address: 'Synthetic address',
    });
    await insertRecord(db.sql, 'encounter', {
      ...envelope,
      id: encounterId,
      patientId,
      openedOn: envelope.createdOn,
      workflowVersion: 1,
    });
    await insertRecord(db.sql, 'encounter_entry', {
      ...envelope,
      id: 'entry:classified-complaint',
      patientId,
      encounterId,
      actorRole: facility.admin.role,
      step: 'complaint',
      values: { complaints: ['Synthetic complaint'] },
      workflowVersion: 1,
    });
    const orderIssues = (item: InvestigationItem) =>
      db.sql.begin((tx) =>
        careWorkflowIssues(
          tx,
          EncounterEntry.parse({
            ...envelope,
            id: 'entry:classified-order',
            type: 'encounter_entry',
            patientId,
            encounterId,
            actorRole: facility.admin.role,
            step: 'lab_order',
            workflowVersion: 1,
            values: { items: [item], tests: [item.name] },
          }),
        ),
      );
    const unpricedRequest = {
      id: 'order_item:classified',
      name: draft.name,
      custom: true,
      priority: 'routine' as const,
    };
    assert.deepEqual(await orderIssues(unpricedRequest), [
      'This Laboratory investigation is unavailable for ordering',
    ]);

    const price = {
      definitionId: draft.id,
      revision: draft.revision,
      amountMinor: 257500,
      currency: 'NGN',
    };
    const atomic = await publish([
      price,
      { ...price, definitionId: nonBillable.id, revision: nonBillable.revision },
    ]);
    assert.equal(atomic.statusCode, 409, atomic.body);
    assert.equal((await tests()).find(({ id }) => id === draft.id)?.orderable, false);
    assert.equal((await recordsInFacility(db.sql, facility.facility.id, 'fee_item')).length, 0);

    const activated = await publish([price]);
    assert.equal(activated.statusCode, 200, activated.body);
    assert.deepEqual(activated.json(), { activated: 1, alreadyActivated: 0 });
    assert.deepEqual((await publish([price])).json(), { activated: 0, alreadyActivated: 1 });
    assert.equal((await publish([{ ...price, amountMinor: 1 }])).statusCode, 409);

    const active = (await tests()).find(({ id }) => id === draft.id);
    assert.equal(active?.orderable, true);
    assert.ok(active?.feeItemId);
    const fee = await findRecord<FeeItem>(db.sql, 'fee_item', active.feeItemId);
    assert.equal(fee?.amountMinor, 257500);
    assert.ok(fee?.priceVersion);
    const [offering] =
      await db.sql`SELECT id, fee_item_id, revision FROM service_offerings WHERE service_definition_id=${draft.id}`;
    assert.equal(offering.fee_item_id, fee.id);
    assert.equal(offering.revision, 2);
    const pricedRequest: InvestigationItem = {
      id: 'order_item:classified',
      name: active.name,
      priority: 'routine',
      serviceDefinitionId: active.id,
      offeringId: offering.id,
      definitionRevision: active.revision,
      catalogueRevision: 2,
      feeItemId: fee.id,
      feePriceVersion: fee.priceVersion,
      priceMinor: fee.amountMinor,
      currency: fee.currency,
    };
    assert.deepEqual(await orderIssues(pricedRequest), []);

    const retired = await post('/investigations/catalogue/retire', {
      definitionId: active.id,
      revision: active.revision,
    });
    assert.equal(retired.statusCode, 200, retired.body);
    const nowRetired = (await tests()).find(({ id }) => id === active.id);
    assert.equal(nowRetired?.active, false);
    assert.equal(nowRetired?.orderable, false);
    assert.equal((await findRecord<FeeItem>(db.sql, 'fee_item', fee.id))?.active, false);
    assert.equal((await publish([price])).statusCode, 409);
    assert.deepEqual(await orderIssues(pricedRequest), [
      'This Laboratory investigation is unavailable for ordering',
    ]);
  });
});
