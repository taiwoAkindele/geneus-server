import type { FastifyInstance } from 'fastify';
import { UploadRequest, type ApiErrorBody, type SyncTokenResponse } from '#shared';
import { authenticateDevice, touchDevice } from '../auth/deviceAuth.ts';
import { mintSyncToken } from '../auth/syncToken.ts';
import type { Sql } from '../db/client.ts';
import type { Config } from '../lib/config.ts';
import type { Signer } from '../lib/signing.ts';
import { processUpload } from '../sync/upload.ts';

/**
 * The two calls PowerSync's connector makes, plus the key it verifies with.
 * Both device calls authenticate with the device credential; the token they
 * get, and the mutations they send, are bound to that device's facility here.
 */
export const registerSyncRoutes = (app: FastifyInstance, sql: Sql, config: Config, signer: Signer) => {
  /** PowerSync fetches this to verify sync tokens (configured as `jwks_uri`). */
  app.get('/.well-known/jwks.json', async () => ({ keys: [signer.publicJwk()] }));

  app.post('/sync/token', async (request, reply) => {
    const identity = await authenticateDevice(sql, request, reply);
    if (!identity) return;

    const minted = mintSyncToken(signer, {
      deviceId: identity.deviceId,
      facilityId: identity.facilityId,
      audience: config.powerSyncAudience,
      ttlSeconds: config.syncTokenTtlSeconds,
    });
    await touchDevice(sql, identity.deviceId);

    const response: SyncTokenResponse = {
      token: minted.token,
      expiresOn: minted.expiresOn,
      syncEndpoint: config.powerSyncPublicUrl,
      serverTime: new Date().toISOString(),
    };
    return response;
  });

  /**
   * Business refusals come back as 200 with `rejected` entries (and a
   * `sync_rejection` record); only an unenrolled device (401) or a request our
   * own client could never produce (400) is an HTTP error — either of those
   * rightly stops the queue.
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

    const response = await processUpload(sql, identity, parsed.data);
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
