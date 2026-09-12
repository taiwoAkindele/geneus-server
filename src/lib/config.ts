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
    port: process.env.PORT ?? 8080,
    corsOrigins: (process.env.APP_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((origin) => origin.trim()),
    signingPrivateKey: process.env.SIGNING_PRIVATE_KEY,
    isProduction: process.env.NODE_ENV === 'production',
  });
