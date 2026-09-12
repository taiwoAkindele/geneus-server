import { createPublicKey, verify } from 'node:crypto';
import { SyncTokenClaims } from '#shared';
import type { Signer } from '../lib/signing.ts';

/**
 * The short-lived JWT a device presents to the PowerSync service. Its subject
 * is the device and its `facility_id` claim is what every Sync Stream filters
 * on — so the facility a device syncs is decided here, from the authenticated
 * credential, and never by the device.
 *
 * Minted with `node:crypto` rather than a JWT library: a JWS is two base64url
 * JSON segments and a signature over them, and Ed25519 is what the project
 * already signs with. PowerSync verifies against /.well-known/jwks.json.
 */
export type SyncTokenOptions = {
  deviceId: string;
  facilityId: string;
  audience: string;
  ttlSeconds: number;
  now?: number;
};

const base64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

export const mintSyncToken = (signer: Signer, options: SyncTokenOptions): { token: string; expiresOn: string } => {
  const issuedAt = Math.floor((options.now ?? Date.now()) / 1000);
  const claims = SyncTokenClaims.parse({
    sub: options.deviceId,
    aud: options.audience,
    iat: issuedAt,
    exp: issuedAt + options.ttlSeconds,
    facility_id: options.facilityId,
  });
  const header = { alg: 'EdDSA', typ: 'JWT', kid: signer.publicKeyFingerprint };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = base64url(signer.signBytes(Buffer.from(signingInput)));
  return { token: `${signingInput}.${signature}`, expiresOn: new Date(claims.exp * 1000).toISOString() };
};

export type Jwk = ReturnType<Signer['publicJwk']>;

export type TokenVerification = { claims: SyncTokenClaims } | { failure: 'malformed' | 'unknown_key' | 'bad_signature' | 'expired' | 'wrong_audience' };

/**
 * What PowerSync does with the token, reproduced here so the tests prove the
 * whole round trip — key published, signature checked, expiry honoured — and
 * so a future server-side consumer of the token has one place to verify it.
 */
export const verifySyncToken = (token: string, keys: Jwk[], audience: string, now = Date.now()): TokenVerification => {
  const parts = token.split('.');
  if (parts.length !== 3) return { failure: 'malformed' };
  const [encodedHeader, encodedClaims, encodedSignature] = parts;

  let header: { alg?: string; kid?: string };
  let claims: SyncTokenClaims;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString());
    claims = SyncTokenClaims.parse(JSON.parse(Buffer.from(encodedClaims, 'base64url').toString()));
  } catch {
    return { failure: 'malformed' };
  }

  const key = keys.find((candidate) => candidate.kid === header.kid);
  if (!key || header.alg !== 'EdDSA') return { failure: 'unknown_key' };

  const publicKey = createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: 'jwk' });
  const valid = verify(null, Buffer.from(`${encodedHeader}.${encodedClaims}`), publicKey, Buffer.from(encodedSignature, 'base64url'));
  if (!valid) return { failure: 'bad_signature' };

  if (claims.aud !== audience) return { failure: 'wrong_audience' };
  if (claims.exp * 1000 <= now) return { failure: 'expired' };
  return { claims };
};
