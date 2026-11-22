import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  POLICY_VERSION,
  type FacilityRegistrationResult,
  type Staff,
  type UploadMutation,
} from '#shared';
import { insertRecord } from '../src/db/records.ts';
import { buildSyncConfig } from '../src/sync/syncConfig.ts';
import {
  addStaff,
  clientId,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
  testApp,
  upload,
  type ScratchDatabase,
} from './postgres.ts';

/** Where a patient receives bills and receipts (docs/PATIENT-BILL-DELIVERY-PLAN-2026-11-21.md, step 1). Synthetic data only. */
describe('patient contact details', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let f: FacilityRegistrationResult;
  let desk: Staff;
  let cashier: Staff;

  const VERSIONS = {
    facilityContractVersion: 1,
    schemaVersion: 5,
    policyVersion: POLICY_VERSION,
  } as const;

  const patient = (n: string) => `${f.facility.id}-${n}-K2`;
  let seq = 0;

  const contact = (by: Staff, extra: Record<string, unknown>): UploadMutation => {
    const id = String(extra.id ?? `contact:${++seq}`);

    return {
      clientId: clientId(),
      op: 'put',
      table: 'patient_contact',
      id,
      data: {
        ...envelopeFor(f),
        schemaVersion: 5,
        createdBy: by.id,
        id,
        type: 'patient_contact',
        createdOn: new Date(Date.now() + seq * 1000).toISOString(),
        patientId: patient('000001'),
        smsStopped: false,
        emailStopped: false,
        source: 'staff',
        ...extra,
      },
    };
  };

  const send = async (m: UploadMutation) =>
    upload(app, f.device.credential, { ...VERSIONS, transactionId: 1, mutations: [m] } as never);

  const reason = async (m: UploadMutation) => (await send(m)).rejected[0]?.reason;

  before(async () => {
    db = await scratchDatabase();
    f = await registerScratchFacility(db.sql);
    app = testApp(db.sql);
    desk = await addStaff(db.sql, f, { role: 'records_officer' });
    cashier = await addStaff(db.sql, f, { role: 'cashier' });
    const admin = { ...envelopeFor(f), schemaVersion: 5 };

    for (const n of ['000001', '000002']) {
      await insertRecord(db.sql, 'patient', {
        ...admin,
        id: patient(n),
        patientId: patient(n),
        type: 'patient',
        fullName: `Synthetic patient ${n}`,
        address: 'Synthetic address',
        sex: 'female',
        ageYears: 30,
      });
    }
  });

  after(async () => {
    if (app) {
      await app.close();
    }

    if (db) {
      await db.drop();
    }
  });

  it('front desk records an email; it is kept tidy and the record can never be edited', async () => {
    const result = await send(contact(desk, { id: 'contact:first', email: ' Ada@Example.ORG ' }));
    assert.deepEqual(result.rejected, []);

    const [row] =
      await db.sql`SELECT email, sms_stopped, source FROM patient_contacts WHERE id = 'contact:first'`;

    assert.deepEqual({ ...row }, { email: 'ada@example.org', sms_stopped: false, source: 'staff' });
    await assert.rejects(
      db.sql`UPDATE patient_contacts SET email = 'x@example.org' WHERE id = 'contact:first'`,
    );

    await assert.rejects(db.sql`DELETE FROM patient_contacts WHERE id = 'contact:first'`);
  });

  it('keeps one chain per patient', async () => {
    assert.match(
      (await reason(contact(desk, { email: 'other@example.org' })))!,
      /changed on another device/,
    );

    assert.deepEqual(
      (
        await send(
          contact(desk, {
            id: 'contact:second',
            replaces: 'contact:first',
            email: 'ada@example.org',
            smsStopped: true,
          }),
        )
      ).rejected,
      [],
    );

    assert.match(
      (await reason(contact(desk, { replaces: 'contact:first', email: 'ada@example.org' })))!,
      /changed on another device/,
    );

    assert.match(
      (await reason(contact(desk, { replaces: 'contact:second', patientId: patient('000002') })))!,
      /this patient's own/,
    );
  });

  it('only the patient can start a channel they stopped, and a device cannot speak for the patient', async () => {
    assert.match(
      (await reason(contact(desk, { replaces: 'contact:second', email: 'ada@example.org' })))!,
      /Only the patient can start it again/,
    );

    assert.match(
      (await reason(
        contact(desk, { replaces: 'contact:second', email: 'ada@example.org', source: 'patient' }),
      ))!,
      /Only the patient can record/,
    );
  });

  it('needs permission to update patients', async () => {
    const result = await send(
      contact(cashier, { replaces: 'contact:second', email: 'ada@example.org', smsStopped: true }),
    );

    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]!.category, 'authorization');
  });

  it('syncs to devices', () => {
    assert.match(buildSyncConfig(), /FROM patient_contacts/);
  });
});
