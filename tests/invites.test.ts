import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type nano from 'nano';
import {
  claimInvite,
  createInvite,
  ensureInvitesDatabase,
  findInvite,
  INVITES_DB,
  rejectionFor,
  releaseInvite,
  type Invite,
} from '../src/couch/invites.ts';
import { requireCouch, scratchFacilityCode } from './helpers.ts';

const VALID_FOR_DAYS = 14;

/**
 * An invite is the only thing standing between the open internet and a
 * provisioned database with a credential attached, so "spent exactly once" is a
 * security property, not a convenience.
 */
describe('facility invites', () => {
  const minted: string[] = [];
  let couch: nano.ServerScope;

  const mint = async (validForDays = VALID_FOR_DAYS): Promise<Invite> => {
    const invite = await createInvite(couch, 'Test PHC', validForDays);
    minted.push(invite._id);
    return invite;
  };

  before(async () => {
    couch = await requireCouch();
    await ensureInvitesDatabase(couch);
  });

  after(async () => {
    const database = couch.use<Invite>(INVITES_DB);
    for (const id of minted) {
      const existing = await database.get(id).catch(() => undefined);
      if (existing?._rev) await database.destroy(id, existing._rev).catch(() => undefined);
    }
  });

  it('finds a freshly minted invite and accepts it', async () => {
    const invite = await mint();

    const found = await findInvite(couch, invite.token);

    assert.equal(found?.token, invite.token);
    assert.equal(rejectionFor(found), undefined);
  });

  it('reports an unknown token rather than throwing', async () => {
    assert.equal(await findInvite(couch, 'NOTATOKEN'), undefined);
    assert.equal(rejectionFor(undefined), 'unknown');
  });

  it('is case-insensitive, because the code is read off a screen and typed by hand', async () => {
    const invite = await mint();

    assert.equal((await findInvite(couch, invite.token.toLowerCase()))?.token, invite.token);
  });

  /**
   * Two requests that both read the invite before either claimed it — the real
   * race. Both hold the same revision, and CouchDB's revision check decides.
   */
  it('can only be claimed once', async () => {
    const invite = await mint();
    const asBothRequestsRead = await findInvite(couch, invite.token);
    assert.ok(asBothRequestsRead);

    const first = await claimInvite(couch, asBothRequestsRead, scratchFacilityCode());
    const second = await claimInvite(couch, asBothRequestsRead, scratchFacilityCode());

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(rejectionFor(await findInvite(couch, invite.token)), 'already_used');
  });

  it('becomes claimable again when provisioning failed after the claim', async () => {
    const invite = await mint();
    const stored = await findInvite(couch, invite.token);
    assert.ok(stored);
    assert.equal(await claimInvite(couch, stored, scratchFacilityCode()), true);

    await releaseInvite(couch, invite.token);

    const released = await findInvite(couch, invite.token);
    assert.equal(rejectionFor(released), undefined);
    assert.equal(released?.facilityCode, undefined);
  });

  it('rejects an invite whose validity has run out', async () => {
    const expired = await mint(-1);

    assert.equal(rejectionFor(await findInvite(couch, expired.token)), 'expired');
  });
});
