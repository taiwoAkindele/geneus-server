import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mintSyncToken, verifySyncToken } from '../src/auth/syncToken.ts';
import { createSigner } from '../src/lib/signing.ts';
import { buildSyncConfig } from '../src/sync/syncConfig.ts';

describe('safe provisional-patient sync compatibility', () => {
  it('requires an explicit registration capability in signed device claims', () => {
    const signer = createSigner(undefined);
    const options = { deviceId: 'synthetic-device', facilityId: 'TEST-PHC', audience: 'test-sync', ttlSeconds: 3600 };
    const legacy = verifySyncToken(mintSyncToken(signer, options).token, [signer.publicJwk()], options.audience);
    const current = verifySyncToken(mintSyncToken(signer, { ...options, patientRegistrationVersion: 1 }).token, [signer.publicJwk()], options.audience);
    assert.ok('claims' in legacy && !legacy.claims.patient_registration);
    assert.ok('claims' in current && current.claims.patient_registration === 1);
  });
  it('protects old screens from provisional patients and referrals with unknown sex', () => {
    const config = buildSyncConfig();
    assert.equal((config.match(/OR identity_status = 'identified'/g) ?? []).length, 4);
    assert.equal((config.match(/OR json_extract\(tier1, '\$\.sex'\) IS NOT NULL/g) ?? []).length, 8);
  });
});
