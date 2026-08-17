import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

/**
 * One Ed25519 keypair signs the roster and the server clock. Devices carry the
 * public key and verify offline, which is what lets shift login be evaluated
 * with no network (root §4.3).
 */
export type Signer = {
  publicKeyBase64: string;
  sign: (payload: unknown) => string;
};

const toPkcs8 = (base64: string): KeyObject =>
  createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' });

const publicKeyOf = (privateKey: KeyObject): string =>
  createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');

/**
 * Signs the canonical JSON of the payload. Key order therefore matters, so
 * callers must build the object in a fixed order — the verifier reproduces it.
 */
export const createSigner = (privateKeyBase64: string | undefined): Signer => {
  const privateKey = privateKeyBase64
    ? toPkcs8(privateKeyBase64)
    : generateKeyPairSync('ed25519').privateKey;

  return {
    publicKeyBase64: publicKeyOf(privateKey),
    sign: (payload) => sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64'),
  };
};
