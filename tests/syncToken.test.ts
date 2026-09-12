import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { SyncTokenResponse, type FacilityRegistrationResult } from '#shared';
import { mintSyncToken, verifySyncToken, type Jwk } from '../src/auth/syncToken.ts';
import { createSigner } from '../src/lib/signing.ts';
import { asDevice, config, registerScratchFacility, scratchDatabase, signer, testApp, type ScratchDatabase } from './postgres.ts';

const HOUR_S = 3600;

/**
 * The token is the only thing PowerSync sees. What matters is what it says
 * about the device — and that nothing but our key could have said it.
 */
describe('sync tokens', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let facility: FacilityRegistrationResult;
  let keys: Jwk[];

  const token = (credential: string) => app.inject({ method: 'POST', url: '/sync/token', headers: asDevice(credential) });

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    facility = await registerScratchFacility(db.sql);
    keys = (await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json().keys;
  });

  after(async () => {
    await app.close();
    await db.drop();
  });

  it('publishes the Ed25519 public key as a JWK PowerSync can fetch', () => {
    assert.equal(keys.length, 1);
    assert.deepEqual(
      { kty: keys[0].kty, crv: keys[0].crv, alg: keys[0].alg, use: keys[0].use, kid: keys[0].kid },
      { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid: signer.publicKeyFingerprint },
    );
  });

  it('mints a token whose subject is the device and whose facility claim is the device\'s facility', async () => {
    const response = await token(facility.device.credential);

    assert.equal(response.statusCode, 200);
    const minted = SyncTokenResponse.parse(response.json());
    const verified = verifySyncToken(minted.token, keys, config.powerSyncAudience);
    assert.ok('claims' in verified, JSON.stringify(verified));
    assert.equal(verified.claims.sub, facility.device.deviceId);
    assert.equal(verified.claims.facility_id, facility.facility.id);
    assert.equal(verified.claims.aud, config.powerSyncAudience);
    assert.equal(minted.syncEndpoint, config.powerSyncPublicUrl);
  });

  it('lives no longer than the configured hour, within PowerSync\'s 24-hour cap', async () => {
    const minted = SyncTokenResponse.parse((await token(facility.device.credential)).json());
    const verified = verifySyncToken(minted.token, keys, config.powerSyncAudience);
    assert.ok('claims' in verified);

    assert.equal(verified.claims.exp - verified.claims.iat, config.syncTokenTtlSeconds);
    assert.ok(config.syncTokenTtlSeconds <= HOUR_S);
    assert.equal(minted.expiresOn, new Date(verified.claims.exp * 1000).toISOString());
  });

  it('is refused once expired', () => {
    const now = Date.parse('2026-09-12T12:00:00Z');
    const minted = mintSyncToken(signer, { deviceId: 'd', facilityId: 'F', audience: 'powersync', ttlSeconds: 60, now });

    assert.ok('claims' in verifySyncToken(minted.token, keys, 'powersync', now + 59_000));
    assert.deepEqual(verifySyncToken(minted.token, keys, 'powersync', now + 60_000), { failure: 'expired' });
  });

  it('is refused when tampered with, signed by another key, or for another audience', () => {
    const minted = mintSyncToken(signer, { deviceId: 'd', facilityId: 'F', audience: 'powersync', ttlSeconds: 60 });
    const [header, claims, signature] = minted.token.split('.');
    const forgedClaims = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(claims, 'base64url').toString()), facility_id: 'OTHER' })).toString('base64url');
    const otherKeys = [createSigner(undefined).publicJwk()];

    assert.deepEqual(verifySyncToken(`${header}.${forgedClaims}.${signature}`, keys, 'powersync'), { failure: 'bad_signature' });
    assert.deepEqual(verifySyncToken(minted.token, otherKeys, 'powersync'), { failure: 'unknown_key' });
    assert.deepEqual(verifySyncToken(minted.token, keys, 'someone-else'), { failure: 'wrong_audience' });
    assert.deepEqual(verifySyncToken('not.a.jwt.at.all', keys, 'powersync'), { failure: 'malformed' });
  });

  it('is not issued to a device with the wrong secret, or to a revoked one', async () => {
    const revoked = await registerScratchFacility(db.sql);
    await db.sql`UPDATE devices SET status = 'revoked', revoked_on = now() WHERE id = ${revoked.device.deviceId}`;

    assert.equal((await token(`${facility.device.deviceId}.wrong`)).statusCode, 401);
    assert.equal((await token(revoked.device.credential)).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/sync/token' })).statusCode, 401);
  });

  /** The browser client used to send this header with no body, which Fastify turns into a 400 before the route runs. */
  it('is minted even when the client sends a JSON content-type with an empty body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sync/token',
      headers: { ...asDevice(facility.device.credential), 'content-type': 'application/json' },
    });

    assert.equal(response.statusCode, 200, response.body);
  });

  it('records the contact on the device', async () => {
    await token(facility.device.credential);

    const [row] = await db.sql<{ last_seen_on: string | null }[]>`SELECT last_seen_on FROM devices WHERE id = ${facility.device.deviceId}`;
    assert.ok(row.last_seen_on);
  });
});
