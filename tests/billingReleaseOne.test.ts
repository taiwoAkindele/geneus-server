import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  POLICY_VERSION,
  type FeeItem,
  type Payment,
  type FacilityRegistrationResult,
  type Staff,
} from '#shared';
import { findRecord, insertRecord } from '../src/db/records.ts';
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
  type ScratchDatabase,
} from './postgres.ts';

describe('Release 1 verified financial actors and safe catalogue writes', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let f: FacilityRegistrationResult;
  let other: FacilityRegistrationResult;
  let cashier: Staff;
  const versions = {
    facilityContractVersion: 1,
    schemaVersion: 5,
    policyVersion: POLICY_VERSION,
  } as const;
  const raw = (url: string, payload: object, token?: string, actor?: string, credential?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: {
        ...asDevice(credential ?? f.device.credential),
        ...(token ? { 'x-staff-session': token } : {}),
        ...(actor ? { 'x-actor-staff-id': actor } : {}),
      },
    });
  const fee = (id: string, chargeWhen = 'when_ordered') => ({
    clientId: clientId(),
    op: 'put' as const,
    table: 'fee_item' as const,
    id,
    data: {
      ...envelopeFor(f),
      createdBy: f.admin.id,
      id,
      type: 'fee_item',
      name: 'Synthetic catalogue item',
      category: 'consultation',
      amountMinor: 10000,
      currency: 'NGN',
      chargeWhen,
      exemptions: [],
    },
  });
  const patch = (id: string, changes: Record<string, unknown>) => ({
    clientId: clientId(),
    op: 'patch' as const,
    table: 'fee_item' as const,
    id,
    data: { ...changes, updatedBy: f.admin.id, updatedOn: new Date().toISOString() },
  });
  const save = async (
    mutation: ReturnType<typeof fee> | ReturnType<typeof patch>,
    policy = false,
  ) =>
    raw(
      policy ? '/config/save?billingPolicy=1' : '/config/save',
      { ...versions, transactionId: null, mutations: [mutation] },
      await staffSessionFor(app, f.device.credential, f.admin.id),
    );
  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    f = await registerScratchFacility(db.sql);
    other = await registerScratchFacility(db.sql);
    cashier = await addStaff(db.sql, f, { role: 'cashier' });
    // Existing intentional automation is historical configuration, not a new automatic fee request.
    for (const chargeWhen of ['first_visit', 'every_visit']) {
      await insertRecord(db.sql, 'fee_item', {
        ...fee('legacy:' + chargeWhen, chargeWhen).data,
        category: chargeWhen === 'first_visit' ? 'registration' : 'consultation',
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

  it('refuses asserted staff identities on every staff-operated billing route and financial configuration', async () => {
    for (const path of [
      'connection/status',
      'connection',
      'accounts/list',
      'accounts/discover',
      'accounts/link',
      'accounts/create-terminal',
      'transfers/import',
      'transfers/source/match',
    ]) {
      const response = await raw(
        '/billing/' + path,
        { actorStaffId: f.admin.id },
        undefined,
        f.admin.id,
      );
      assert.equal(response.statusCode, 403, path);
      assert.equal(response.json().error, 'staff_session_required', path);
    }
    const configuration = await raw(
      '/config/save',
      { ...versions, transactionId: null, mutations: [fee('spoofed:fee')] },
      undefined,
      f.admin.id,
    );
    assert.equal(configuration.json().error, 'staff_session_required');
    assert.equal(await findRecord(db.sql, 'fee_item', 'spoofed:fee'), undefined);
    const department = {
      clientId: clientId(),
      op: 'put',
      table: 'billing_department',
      id: 'spoofed:department',
      data: {
        ...envelopeFor(f),
        createdBy: f.admin.id,
        name: 'Synthetic department',
        type: 'billing_department',
      },
    };
    assert.equal(
      (
        await raw(
          '/config/save',
          { ...versions, transactionId: null, mutations: [department, fee('spoofed:mixed')] },
          undefined,
          f.admin.id,
        )
      ).json().error,
      'staff_session_required',
    );
    assert.equal(
      await findRecord(db.sql, 'billing_department', 'spoofed:department'),
      undefined,
      'a mixed financial batch has no partially accepted configuration',
    );
    const insurance = await raw('/insurance/contracts/list', {}, undefined, f.admin.id);
    assert.equal(insurance.json().error, 'staff_session_required');
    const refund = await raw('/billing/refunds', {}, undefined, f.admin.id);
    assert.equal(refund.json().error, 'staff_session_required');
  });

  it('rejects a wrong actor, cross-facility session, ended/expired session and deactivated staff', async () => {
    const token = await staffSessionFor(app, f.device.credential, f.admin.id);
    assert.equal(
      (await raw('/billing/connection/status', { actorStaffId: cashier.id }, token)).json().error,
      'attribution_mismatch',
    );
    assert.equal(
      (
        await raw('/billing/connection/status', { actorStaffId: f.admin.id }, token, cashier.id)
      ).json().error,
      'attribution_mismatch',
    );
    assert.equal(
      (
        await raw('/billing/connection/status', {}, token, undefined, other.device.credential)
      ).json().error,
      'staff_session_required',
    );
    const code = await issueEnrollmentCode(db.sql, f.facility.id, f.admin.id, f.device.deviceId);
    const second = await enrollDevice(
      db.sql,
      { code: code.code, deviceId: 'billing-r1:second-device' },
      'http://localhost:8080',
    );
    assert.ok(second.ok);
    assert.equal(
      (
        await raw('/billing/connection/status', {}, token, undefined, second.credential.credential)
      ).json().error,
      'staff_session_required',
      'a session cannot move to another device in the same facility',
    );
    await db.sql`UPDATE staff_sessions SET expires_on=now() - interval '1 second' WHERE staff_id=${f.admin.id}`;
    assert.equal(
      (
        await raw('/billing/connection/status', { actorStaffId: f.admin.id }, token, f.admin.id)
      ).json().error,
      'staff_session_required',
    );
    const refreshed = await staffSessionFor(app, f.device.credential, f.admin.id);
    await raw('/staff/session/end', {}, refreshed);
    assert.equal(
      (await raw('/billing/connection/status', {}, refreshed, f.admin.id)).json().error,
      'staff_session_required',
    );
    const cashierToken = await staffSessionFor(app, f.device.credential, cashier.id);
    assert.equal(
      (await raw('/billing/connection/status', {}, cashierToken)).json().error,
      'forbidden',
    );
    await db.sql`UPDATE staff SET permission='read_only' WHERE id=${cashier.id}`;
    assert.equal(
      (await raw('/billing/transfers/import', { reference: 'synthetic' }, cashierToken)).json()
        .error,
      'forbidden',
      'permission revocation applies to an existing session',
    );
    await db.sql`UPDATE staff SET permission='read_write' WHERE id=${cashier.id}`;
    await db.sql`UPDATE staff SET active=false WHERE id=${cashier.id}`;
    assert.equal(
      (await raw('/billing/accounts/list', {}, cashierToken, cashier.id)).json().error,
      'staff_session_required',
    );
  });

  it('blocks new automatic fees from old or current clients, even with a valid administrator session', async () => {
    for (const mode of ['first_visit', 'every_visit']) {
      const response = await save(fee('unsafe:' + mode, mode));
      assert.equal(response.statusCode, 409);
      assert.match(response.json().message, /only when selected/);
      assert.equal(await findRecord(db.sql, 'fee_item', 'unsafe:' + mode), undefined);
    }
    const safe = await save(fee('safe:fee'));
    assert.equal(safe.statusCode, 200, safe.body);
    assert.equal(
      (await findRecord<FeeItem>(db.sql, 'fee_item', 'safe:fee'))?.chargeWhen,
      'when_ordered',
    );
  });

  it('protects categories and policies on ordinary saves, including older full-fee patches', async () => {
    for (const policy of [false, true]) {
      const response = await save(patch('safe:fee', { category: 'laboratory' }), policy);
      assert.equal(response.statusCode, 409);
      assert.match(response.json().message, /insurance impact/);
    }
    const unsafe = await save(
      patch('safe:fee', { chargeWhen: 'every_visit', name: 'Old full form' }),
    );
    assert.equal(unsafe.statusCode, 409);
    assert.match(unsafe.json().message, /separate policy editor/);
    const mixed = await save(
      patch('safe:fee', { chargeWhen: 'every_visit', name: 'Mixed form' }),
      true,
    );
    assert.equal(mixed.statusCode, 409);
    assert.equal(
      (await findRecord<FeeItem>(db.sql, 'fee_item', 'safe:fee'))?.chargeWhen,
      'when_ordered',
    );
  });

  it('allows intentional narrow policy saves and preserves legacy automatic fees during price edits', async () => {
    const policy = await save(
      patch('safe:fee', {
        chargeWhen: 'every_visit',
        exemptions: [{ reason: 'Under five', ageUnderYears: 5 }],
      }),
      true,
    );
    assert.equal(policy.statusCode, 200, policy.body);
    for (const mode of ['first_visit', 'every_visit']) {
      const id = 'legacy:' + mode;
      const before = await findRecord<FeeItem>(db.sql, 'fee_item', id);
      assert.equal((await save(patch(id, { amountMinor: 20000 }))).statusCode, 200);
      const after = await findRecord<FeeItem>(db.sql, 'fee_item', id);
      assert.equal(after?.chargeWhen, mode);
      assert.equal(after?.category, before?.category);
      assert.deepEqual(after?.exemptions, before?.exemptions);
    }
    assert.equal(
      (await findRecord<FeeItem>(db.sql, 'fee_item', 'safe:fee'))?.exemptions[0].reason,
      'Under five',
    );
  });

  it('does not turn operational cash uploads into session-gated online actions', async () => {
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
    await insertRecord(db.sql, 'charge', {
      ...envelopeFor(f),
      createdBy: f.admin.id,
      id: 'offline:charge',
      type: 'charge',
      patientId,
      feeItemId: 'safe:fee',
      description: 'Original charge',
      category: 'consultation',
      listPriceMinor: 10000,
      amountMinor: 10000,
      currency: 'NGN',
    });
    await db.sql`UPDATE staff SET active=true WHERE id=${cashier.id}`;
    const payment = {
      ...envelopeFor(f),
      createdBy: cashier.id,
      id: 'offline:cash',
      type: 'payment',
      patientId,
      receiptNumber: f.facility.id + '-R-000001-K2',
      method: 'cash',
      amountMinor: 5000,
      currency: 'NGN',
      allocations: [{ chargeId: 'offline:charge', amountMinor: 5000 }],
    };
    const response = await raw('/sync/upload', {
      ...versions,
      transactionId: 1,
      mutations: [
        { clientId: clientId(), op: 'put', table: 'payment', id: payment.id, data: payment },
      ],
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().rejected.length, 0, response.body);
    assert.equal((await findRecord<Payment>(db.sql, 'payment', payment.id))?.amountMinor, 5000);
  });
});
