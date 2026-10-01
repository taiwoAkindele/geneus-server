import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { PinSetupCode, PinSetupCodeIssued, type FacilityRegistrationResult, type Staff } from '#shared';
import { fromRow } from '../src/db/records.ts';
import { hashPinSetupCode } from '../src/staff/pinSetupCodes.ts';
import { addStaff, asDevice, clientId, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

/**
 * A PIN setup code is how a member of staff gets approval to set their PIN on
 * a facility phone when no admin is standing beside them (SCHEMA.md §10). The
 * code is the secret, so the server keeps only its hash, and only the person it
 * names may use it.
 */
describe('PIN setup codes', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let a: FacilityRegistrationResult;
  let b: FacilityRegistrationResult;
  let nurse: Staff;
  let chew: Staff;

  const issue = (credential: string, staffId: string, issuedBy: string) =>
    app.inject({ method: 'POST', url: `/staff/${staffId}/pin-codes`, headers: asDevice(credential), payload: { issuedBy } });

  const codesFor = async (staffId: string): Promise<PinSetupCode[]> => {
    const rows = await db.sql<Record<string, unknown>[]>`SELECT * FROM pin_setup_codes WHERE staff_id = ${staffId} ORDER BY created_on`;
    return rows.map((row) => fromRow<PinSetupCode>('pin_setup_code', row));
  };

  const claim = (code: PinSetupCode, by: Staff, usedOn = new Date().toISOString()) =>
    upload(app, a.device.credential, {
      transactionId: null,
      mutations: [
        {
          clientId: clientId(),
          op: 'patch',
          table: 'pin_setup_code',
          id: code.id,
          data: { usedOn, usedOnDevice: a.device.deviceId, updatedBy: by.id, updatedOn: usedOn },
        },
      ],
    });

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    [a, b] = await Promise.all([registerScratchFacility(db.sql), registerScratchFacility(db.sql)]);
    nurse = await addStaff(db.sql, a, { role: 'nurse' });
    chew = await addStaff(db.sql, a, { role: 'chew' });
  });

  after(async () => {
    await app.close();
    await db.drop();
  });

  it('gives the admin a one-time code and stores only its hash', async () => {
    const response = await issue(a.device.credential, nurse.id, a.admin.id);

    assert.equal(response.statusCode, 201, response.body);
    const issued = PinSetupCodeIssued.parse(response.json());
    assert.match(issued.code, /^[A-HJ-NP-Z2-9]{8}$/);

    const [stored] = await codesFor(nurse.id);
    assert.ok(stored);
    assert.notEqual(stored.codeHash, issued.code);
    assert.equal(hashPinSetupCode(issued.code.toLowerCase(), stored.codeSalt, stored.codeIterations), stored.codeHash);
    assert.equal(stored.createdBy, a.admin.id);
  });

  it('revokes the earlier code when a new one is issued', async () => {
    await issue(a.device.credential, chew.id, a.admin.id);
    await issue(a.device.credential, chew.id, a.admin.id);

    const [first, second] = await codesFor(chew.id);
    assert.ok(first?.revokedOn);
    assert.equal(second?.revokedOn, undefined);
  });

  it('refuses a nurse — issuing a code needs staff:manage', async () => {
    const response = await issue(a.device.credential, chew.id, nurse.id);

    assert.equal(response.statusCode, 403);
    assert.match(response.json().message, /staff:manage is not granted/);
  });

  it('does not find staff of another facility', async () => {
    assert.equal((await issue(a.device.credential, b.admin.id, a.admin.id)).statusCode, 404);
  });

  it('lets the person it was issued for mark it used', async () => {
    const [code] = await codesFor(nurse.id);
    assert.ok(code);

    const response = await claim(code, nurse);

    assert.equal(response.applied, 1, JSON.stringify(response.rejected));
    const [used] = await codesFor(nurse.id);
    assert.equal(used?.usedOnDevice, a.device.deviceId);
  });

  it('refuses a second use of the same code', async () => {
    const [code] = await codesFor(nurse.id);
    assert.ok(code);

    const response = await claim(code, nurse);

    assert.equal(response.rejected[0]?.category, 'conflict');
  });

  it('refuses a claim by anyone other than the person it names', async () => {
    const codes = await codesFor(chew.id);
    const live = codes.find((code) => !code.revokedOn);
    assert.ok(live);

    const response = await claim(live, nurse);

    assert.equal(response.rejected[0]?.category, 'authorization');
    assert.match(response.rejected[0]?.reason ?? '', /only be used by the person it was issued for/);
  });

  it('refuses a device inserting a code of its own', async () => {
    const [code] = await codesFor(nurse.id);
    assert.ok(code);
    const response = await upload(app, a.device.credential, {
      transactionId: null,
      mutations: [{ clientId: clientId(), op: 'put', table: 'pin_setup_code', id: 'pin_setup_code:forged', data: { ...code, id: 'pin_setup_code:forged' } }],
    });

    assert.equal(response.rejected[0]?.category, 'authorization');
  });
});
