import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createSigner } from '../src/lib/signing.ts';

const privateKeyBase64 = (): string =>
  generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

/**
 * Verification is done the way a device does it: from the exported public key
 * alone, with no access to the signer. That is the whole point of the key —
 * a phone with no signal must be able to check a roster it replicated down.
 */
const verifyAsDevice = (payload: unknown, signature: string, publicKeyBase64: string): boolean =>
  verify(
    null,
    Buffer.from(JSON.stringify(payload)),
    createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' }),
    Buffer.from(signature, 'base64'),
  );

describe('signing', () => {
  it('produces a signature a device can verify offline', () => {
    const signer = createSigner(privateKeyBase64());
    const payload = { now: '2026-09-08T09:30:00+01:00' };

    assert.ok(verifyAsDevice(payload, signer.sign(payload), signer.publicKeyBase64));
  });

  it('rejects a payload that was altered after signing', () => {
    const signer = createSigner(privateKeyBase64());
    const signature = signer.sign({ now: '2026-09-08T09:30:00+01:00' });

    assert.equal(verifyAsDevice({ now: '2026-09-09T09:30:00+01:00' }, signature, signer.publicKeyBase64), false);
  });

  it('keeps the same public key across restarts when the private key is configured', () => {
    const configured = privateKeyBase64();

    assert.equal(createSigner(configured).publicKeyBase64, createSigner(configured).publicKeyBase64);
  });

  /**
   * The ephemeral fallback is why an unset SIGNING_PRIVATE_KEY is dangerous
   * rather than merely inconvenient: it signs perfectly well, so nothing looks
   * broken until a restart silently invalidates every signature already issued.
   */
  it('signs with an ephemeral key that changes on every restart', () => {
    const first = createSigner(undefined);
    const second = createSigner(undefined);
    const payload = { now: '2026-09-08T09:30:00+01:00' };

    assert.ok(verifyAsDevice(payload, first.sign(payload), first.publicKeyBase64));
    assert.notEqual(first.publicKeyBase64, second.publicKeyBase64);
    assert.equal(verifyAsDevice(payload, first.sign(payload), second.publicKeyBase64), false);
  });

  it('signs key order as written, since the verifier reproduces the same canonical JSON', () => {
    const signer = createSigner(privateKeyBase64());
    const signature = signer.sign({ now: 'a', facilityId: 'b' });

    assert.equal(verifyAsDevice({ facilityId: 'b', now: 'a' }, signature, signer.publicKeyBase64), false);
  });
});
