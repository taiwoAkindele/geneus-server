import type { FastifyInstance } from 'fastify';
import { UploadRequest, type ApiErrorBody, type SyncTokenResponse } from '#shared';
import { authenticateDevice, touchDevice } from '../auth/deviceAuth.ts';
import { mintSyncToken } from '../auth/syncToken.ts';
import type { Sql } from '../db/client.ts';
import type { Config } from '../lib/config.ts';
import type { Signer } from '../lib/signing.ts';
import { processUpload } from '../sync/upload.ts';
import { FACILITY_FEATURE_SUPPORT } from '../workforce/compatibility.ts';
import { assertWorkforceCompatibility } from '../workforce/compatibility.ts';
import { recordClientVersion } from '../workforce/readiness.ts';
import { z } from 'zod';

/**
 * The two calls PowerSync's connector makes, plus the key it verifies with.
 * Both device calls authenticate with the device credential; the token they
 * get, and the mutations they send, are bound to that device's facility here.
 */
export const registerSyncRoutes = (app: FastifyInstance, sql: Sql, config: Config, signer: Signer) => {
  /** Transport receipts reveal outcomes only for this device, never refused evidence. */
  app.post('/sync/receipts', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply); if (!identity) return;
    const parsed = z.strictObject({ clientIds: z.array(z.number().int().nonnegative()).min(1).max(1000) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Provide between one and one thousand mutation identities' } satisfies ApiErrorBody);
    const rows = await sql`SELECT client_id,outcome FROM applied_mutations WHERE device_id=${identity.deviceId} AND client_id IN ${sql(parsed.data.clientIds)}`;
    reply.header('cache-control','no-store');
    return { applied: rows.filter((r)=>r.outcome==='applied').map((r)=>Number(r.client_id)), rejected: rows.filter((r)=>r.outcome==='rejected').map((r)=>Number(r.client_id)) };
  });
  /** PowerSync fetches this to verify sync tokens (configured as `jwks_uri`). */
  app.get('/.well-known/jwks.json', async () => {
    const rows = await sql`SELECT public_jwk FROM workforce_signing_keys WHERE trusted`;
    return { keys: [...new Map([signer.publicJwk(), ...rows.map((r) => r.public_jwk as ReturnType<Signer['publicJwk']>)].map((key) => [key.kid,key])).values()] };
  });

  app.post('/sync/token', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;

    const version = z.object({ clinicalWorkflowVersion: z.literal(1).optional(), facilityContractVersion: z.number().int().optional(), schemaVersion: z.number().int().optional(), policyVersion: z.number().int().optional(), pendingMutationCount: z.number().int().nonnegative().optional() }).safeParse(request.body ?? {});
    if (!version.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid client compatibility metadata' } satisfies ApiErrorBody);
    if (version.data.clinicalWorkflowVersion === 1 && (version.data.facilityContractVersion !== 1 || (version.data.schemaVersion ?? 0) < 4 || (version.data.policyVersion ?? 0) < 10)) return reply.code(409).send({ error: 'upgrade_required', message: 'The current clinical workflow requires facility contract 1, schema 4 and policy 10' } satisfies ApiErrorBody);
    if (version.data.facilityContractVersion !== undefined && version.data.facilityContractVersion !== 1) return reply.code(409).send({ error: 'upgrade_required', message: 'This server supports facility contract version one' } satisfies ApiErrorBody);
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM facilities WHERE id=${identity.facilityId} FOR UPDATE`;
      await assertWorkforceCompatibility(tx, identity.facilityId, { transactionId: null, mutations: [], ...version.data, facilityContractVersion: version.data.facilityContractVersion === 1 ? 1 : undefined }, Date.now());
      await recordClientVersion(tx, identity, version.data, Date.now());
    });

    const minted = mintSyncToken(signer, {
      deviceId: identity.deviceId,
      facilityId: identity.facilityId,
      audience: config.powerSyncAudience,
      ttlSeconds: config.syncTokenTtlSeconds,
      facilityContractVersion: version.data.facilityContractVersion === 1 ? 1 : undefined,
      clinicalWorkflowVersion: version.data.clinicalWorkflowVersion,
      patientRegistrationVersion: version.data.schemaVersion === 5 ? 1 : undefined,
    });
    await touchDevice(sql, identity.deviceId);

    const response: SyncTokenResponse = {
      token: minted.token,
      expiresOn: minted.expiresOn,
      syncEndpoint: config.powerSyncPublicUrl,
      serverTime: new Date().toISOString(),
      facilityFeature: FACILITY_FEATURE_SUPPORT,
    };
    return response;
  });

  /**
   * Business refusals come back as 200 with `rejected` entries (and a
   * `sync_rejection` record); only an unenrolled device (401) or a request our
   * own client could never produce (400) is an HTTP error — either of those
   * rightly stops the queue. Incompatible clients receive 409 before ledger
   * claims, preserving their queued mutations until the client is upgraded.
   */
  app.post('/sync/upload', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;

    const parsed = UploadRequest.safeParse(request.body);
    if (!parsed.success) {
      request.log.error({ deviceId: identity.deviceId, issues: parsed.error.issues }, 'malformed upload — client bug');
      return reply.code(400).send({
        error: 'invalid_upload',
        message: 'The upload is malformed',
        issues: parsed.error.issues,
      } satisfies ApiErrorBody);
    }

    const response = await processUpload(sql, identity, parsed.data, Date.now(), signer);
    await touchDevice(sql, identity.deviceId);

    if (response.rejected.length > 0) {
      request.log.warn(
        {
          deviceId: identity.deviceId,
          facilityId: identity.facilityId,
          rejected: response.rejected.map(({ clientId, table, category }) => ({ clientId, table, category })),
        },
        'upload mutations rejected',
      );
    }
    request.log.info(
      { deviceId: identity.deviceId, applied: response.applied, duplicates: response.duplicates, rejected: response.rejected.length },
      'upload processed',
    );
    return response;
  });
};
