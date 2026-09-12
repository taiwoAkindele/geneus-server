import { z } from 'zod';

/**
 * Configuration is validated once at boot: a server that cannot reach
 * PostgreSQL, or that would sign with a key it will forget on restart, should
 * fail immediately and loudly, not on the first request.
 */
const Config = z
  .object({
    postgresUrl: z.url(),
    /**
     * Where devices connect PowerSync to. Handed to every device at enrollment,
     * so it must be the address devices can reach, never an internal one.
     */
    powerSyncPublicUrl: z.url(),
    /**
     * Where this process reaches the PowerSync service for its health probe —
     * the internal address (compose: http://powersync:8080). Falls back to the
     * public one when unset.
     */
    powerSyncInternalUrl: z.url(),
    /** The `aud` claim of sync tokens; the PowerSync service is configured to expect it. */
    powerSyncAudience: z.string().min(1),
    /**
     * How long a sync token lives. PowerSync caps this at 24 hours and
     * recommends an hour or less; a device only needs one while online, so a
     * short life costs offline work nothing.
     */
    syncTokenTtlSeconds: z.coerce.number().int().positive().max(86_400),
    port: z.coerce.number().int().positive(),
    corsOrigins: z.array(z.url()).min(1),
    signingPrivateKey: z.string().optional(),
    isProduction: z.boolean(),
  })
  .refine((config) => !config.isProduction || Boolean(config.signingPrivateKey), {
    message:
      'SIGNING_PRIVATE_KEY is required in production: an ephemeral key would invalidate every signature at the next restart (node scripts/generate-signing-key.ts)',
    path: ['signingPrivateKey'],
  });

export type Config = z.infer<typeof Config>;

export const loadConfig = (): Config =>
  Config.parse({
    postgresUrl: process.env.POSTGRES_URL ?? 'postgres://geneus:devpassword@127.0.0.1:5433/geneus',
    powerSyncPublicUrl: process.env.POWERSYNC_PUBLIC_URL ?? 'http://127.0.0.1:8090',
    powerSyncInternalUrl: process.env.POWERSYNC_INTERNAL_URL ?? process.env.POWERSYNC_PUBLIC_URL ?? 'http://127.0.0.1:8090',
    powerSyncAudience: process.env.POWERSYNC_JWT_AUDIENCE ?? 'powersync',
    syncTokenTtlSeconds: process.env.SYNC_TOKEN_TTL_SECONDS ?? 3600,
    port: process.env.PORT ?? 8080,
    corsOrigins: (process.env.APP_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((origin) => origin.trim()),
    signingPrivateKey: process.env.SIGNING_PRIVATE_KEY,
    isProduction: process.env.NODE_ENV === 'production',
  });
