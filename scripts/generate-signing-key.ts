import { generateKeyPairSync } from 'node:crypto';

/**
 * Mints the Ed25519 keypair that signs rosters and /time. Run once per
 * environment; the private half goes into the secret store, never the repo.
 *
 * Without it the server generates an ephemeral key at boot, so every restart
 * invalidates every signature it has issued — and the 7-day sync-or-freeze
 * window rests on those signatures (root §4.3).
 *
 *   node scripts/generate-signing-key.ts
 */
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

console.log('\n  SIGNING_PRIVATE_KEY (secret store only):');
console.log(`  ${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}`);
console.log('\n  Public key — ships in the PWA build so devices verify offline:');
console.log(`  ${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}\n`);
