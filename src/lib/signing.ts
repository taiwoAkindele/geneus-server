import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';

/**
 * One Ed25519 keypair signs the roster and the server clock. Devices carry the
 * public key and verify offline, which is what lets shift login be evaluated
 * with no network (root §4.3).
 */
export type Signer = {
  publicKeyBase64: string;
  /** Short hash of the public key: enough to see at a glance that it changed. */
  publicKeyFingerprint: string;
  /** True when no key was configured and one was minted at boot — see below. */
  isEphemeral: boolean;
  sign: (payload: unknown) => string;
};

const FINGERPRINT_LENGTH = 16;

const fingerprintOf = (publicKeyBase64: string): string =>
  createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, FINGERPRINT_LENGTH);

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
  const publicKeyBase64 = publicKeyOf(privateKey);

  return {
    publicKeyBase64,
    publicKeyFingerprint: fingerprintOf(publicKeyBase64),
    isEphemeral: !privateKeyBase64,
    sign: (payload) => sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64'),
  };
};
