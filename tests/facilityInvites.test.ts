import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claimInvite, createInvite, findInvite, rejectionFor } from '../src/facilities/invites.ts';
import { scratchDatabase, scratchFacilityCode, type ScratchDatabase } from './postgres.ts';

const VALID_FOR_DAYS = 14;

/**
 * An invite is the only thing standing between the open internet and a
 * registered facility with an enrolled device, so "spent exactly once" is a
 * security property, not a convenience.
 */
describe('facility invites', () => {
  let db: ScratchDatabase;

  before(async () => {
    db = await scratchDatabase();
  });

  after(async () => {
    await db.drop();
  });

  it('finds a freshly minted invite and accepts it', async () => {
    const invite = await createInvite(db.sql, 'Test PHC', VALID_FOR_DAYS);

    const found = await findInvite(db.sql, invite.token);

    assert.equal(found?.token, invite.token);
    assert.equal(rejectionFor(found), undefined);
  });

  it('reports an unknown token rather than throwing', async () => {
    assert.equal(await findInvite(db.sql, 'NOTATOKEN'), undefined);
    assert.equal(rejectionFor(undefined), 'unknown');
  });

  it('is case-insensitive, because the code is read off a screen and typed by hand', async () => {
    const invite = await createInvite(db.sql, 'Test PHC', VALID_FOR_DAYS);

    assert.equal((await findInvite(db.sql, invite.token.toLowerCase()))?.token, invite.token);
  });

  /**
   * Two requests that both read the invite before either claimed it — the real
   * race. Both UPDATEs run; PostgreSQL's row lock lets exactly one see
   * `claimed_on IS NULL`.
   */
  it('can only be claimed once, even by two simultaneous requests', async () => {
    const invite = await createInvite(db.sql, 'Test PHC', VALID_FOR_DAYS);

    const outcomes = await Promise.all([
      claimInvite(db.sql, invite.token, scratchFacilityCode()),
      claimInvite(db.sql, invite.token, scratchFacilityCode()),
    ]);

    assert.deepEqual([...outcomes].sort(), [false, true]);
    assert.equal(rejectionFor(await findInvite(db.sql, invite.token)), 'already_used');
  });

  it('releases the claim when the transaction it ran in rolls back', async () => {
    const invite = await createInvite(db.sql, 'Test PHC', VALID_FOR_DAYS);

    await db.sql
      .begin(async (tx) => {
        assert.equal(await claimInvite(tx, invite.token, scratchFacilityCode()), true);
        throw new Error('provisioning failed after the claim');
      })
      .catch(() => undefined);

    assert.equal(rejectionFor(await findInvite(db.sql, invite.token)), undefined);
  });

  it('rejects an invite whose validity has run out, on read and on claim', async () => {
    const expired = await createInvite(db.sql, 'Test PHC', -1);

    assert.equal(rejectionFor(await findInvite(db.sql, expired.token)), 'expired');
    assert.equal(await claimInvite(db.sql, expired.token, scratchFacilityCode()), false);
  });
});
