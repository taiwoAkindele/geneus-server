import { it } from 'node:test';
import assert from 'node:assert/strict';
import { recordClientVersion } from '../src/workforce/readiness.ts';
import {
  negotiateIntegrated,
  assertIntegratedUpload,
  integratedReadiness,
} from '../src/billing/integrated.ts';
import { registerScratchFacility, scratchDatabase } from './postgres.ts';

it('waits for drained fresh readers and every old token, including retired devices, without acknowledging old outboxes', async () => {
  const db = await scratchDatabase();

  try {
    const f = await registerScratchFacility(db.sql);
    const who = { facilityId: f.facility.id, deviceId: f.device.deviceId };
    const now = Date.now();

    const versions = {
      integratedBillingVersion: 1,
      billingCatalogueVersion: 1,
      facilityContractVersion: 1,
      schemaVersion: 7,
      policyVersion: 17,
      pendingMutationCount: 0,
    };

    await db.sql`UPDATE facilities SET billing_catalogue_version=1 WHERE id=${who.facilityId}`;
    await recordClientVersion(db.sql, who, versions, now);
    assert.equal(
      await db.sql.begin((tx) => negotiateIntegrated(tx as never, who, 1, 86400, now)),
      false,
      'initial maximum token lifetime must expire',
    );

    await db.sql`INSERT INTO devices(id,facility_id,schema_version,created_by,created_on,device_id,enrolled_by,status,enrolled_on,revoked_on) VALUES('old:retired',${who.facilityId},6,${f.admin.id},now(),${who.deviceId},${f.admin.id},'revoked',now(),now())`;
    await db.sql`INSERT INTO workforce_client_versions(device_id,facility_id,contract_version,schema_version,policy_version,pending_mutation_count,recorded_on,legacy_integrated_token_expires_on) VALUES('old:retired',${who.facilityId},1,6,16,0,now(),${new Date(now + 172800000).toISOString()})`;
    await recordClientVersion(db.sql, who, versions, now + 86401000);
    assert.equal(
      await db.sql.begin((tx) => negotiateIntegrated(tx as never, who, 1, 86400, now + 86401000)),
      false,
      'retired JWTs still reach replication until expiry',
    );

    assert.equal(
      Date.parse((await integratedReadiness(db.sql, who.facilityId, now)).legacyTokensUntil),
      now + 172800000,
    );

    await recordClientVersion(
      db.sql,
      who,
      { ...versions, pendingMutationCount: 1 },
      now + 172801000,
    );

    assert.equal(
      await db.sql.begin((tx) => negotiateIntegrated(tx as never, who, 1, 86400, now + 172801000)),
      false,
      'a queue cannot be silently discarded',
    );

    await recordClientVersion(db.sql, who, versions, now + 172801000);
    assert.equal(
      await db.sql.begin((tx) => negotiateIntegrated(tx as never, who, 1, 86400, now + 172801000)),
      true,
    );

    const request = {
      transactionId: null,
      mutations: [],
      billingCatalogueVersion: 1,
      facilityContractVersion: 1,
      schemaVersion: 6,
      policyVersion: 16,
    } as const;

    await assert.rejects(
      db.sql.begin((tx) => assertIntegratedUpload(tx as never, who.facilityId, request as never)),
      /queued work is retained/,
    );

    assert.equal((await db.sql`SELECT * FROM applied_mutations`).length, 0);
    assert.equal(
      await db.sql
        .begin((tx) => negotiateIntegrated(tx as never, who, undefined, 86400, now + 172801000))
        .catch(() => false),
      false,
    );
  } finally {
    await db.drop();
  }
});
