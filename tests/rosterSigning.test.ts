import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { rosterSignaturePayload, RosterShift, type FacilityRegistrationResult, type Staff } from '#shared';
import { findRecord, insertRecord } from '../src/db/records.ts';
import { signPendingShifts } from '../src/roster/rosterSigning.ts';
import { addStaff, clientId, envelopeFor, registerScratchFacility, scratchDatabase, signer, testApp, upload, type ScratchDatabase } from './postgres.ts';

/**
 * Roster signing is what lets a device tell, offline, a genuine shift from one
 * edited on the phone (PLAN.md §4.5). Proven here with the same public key and
 * payload a device uses, and through the upload path that clears a signature
 * when a signed field changes.
 */
describe('roster signing', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let a: FacilityRegistrationResult;
  let nurse: Staff;

  const publicKey = createPublicKey({ key: Buffer.from(signer.publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
  const isValid = (shift: RosterShift) =>
    Boolean(shift.signature) &&
    verify(null, Buffer.from(rosterSignaturePayload(shift), 'utf8'), publicKey, Buffer.from(shift.signature as string, 'base64'));

  const addShift = async (id: string) => {
    const shift = RosterShift.parse({
      ...envelopeFor(a),
      id,
      type: 'roster_shift',
      staffId: nurse.id,
      startsAt: '2026-09-12T08:00:00Z',
      endsAt: '2026-09-12T16:00:00Z',
    });
    await insertRecord(db.sql, 'roster_shift', shift);
    return shift;
  };

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    a = await registerScratchFacility(db.sql);
    nurse = await addStaff(db.sql, a, { role: 'nurse' });
  });

  after(async () => {
    await app.close();
    await db.drop();
  });

  it('signs an unsigned shift so the device can verify it with the public key', async () => {
    await addShift('roster_shift:one');

    assert.ok((await signPendingShifts(db.sql, signer)) >= 1);

    const signed = await findRecord<RosterShift>(db.sql, 'roster_shift', 'roster_shift:one');
    assert.ok(signed && isValid(signed));
  });

  it('leaves signed shifts alone', async () => {
    assert.equal(await signPendingShifts(db.sql, signer), 0);
  });

  it('does not verify once a signed field is altered', async () => {
    const signed = await findRecord<RosterShift>(db.sql, 'roster_shift', 'roster_shift:one');
    assert.ok(signed);

    assert.equal(isValid({ ...signed, endsAt: '2026-09-12T22:00:00Z' }), false);
    assert.equal(isValid({ ...signed, extendedUntil: '2026-09-12T22:00:00Z' }), false);
  });

  it('clears the signature when an upload extends the shift, and signs the new values', async () => {
    const extendedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const response = await upload(app, a.device.credential, {
      transactionId: null,
      mutations: [
        {
          clientId: clientId(),
          op: 'patch',
          table: 'roster_shift',
          id: 'roster_shift:one',
          data: { extendedUntil, updatedBy: a.admin.id, updatedOn: new Date().toISOString() },
        },
      ],
    });
    assert.equal(response.applied, 1, JSON.stringify(response.rejected));

    const cleared = await findRecord<RosterShift>(db.sql, 'roster_shift', 'roster_shift:one');
    assert.equal(cleared?.signature, undefined);

    await signPendingShifts(db.sql, signer);
    const resigned = await findRecord<RosterShift>(db.sql, 'roster_shift', 'roster_shift:one');
    assert.ok(resigned && isValid(resigned));
    assert.equal(resigned.extendedUntil, extendedUntil);
  });
});
