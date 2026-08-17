import { z } from 'zod';

/**
 * Configuration is validated once at boot: a server that cannot reach CouchDB
 * should fail immediately and loudly, not on the first request.
 */
const Config = z.object({
  couchUrl: z.url(),
  couchUser: z.string().min(1),
  couchPassword: z.string().min(1),
  couchPublicUrl: z.url(),
  port: z.coerce.number().int().positive(),
  corsOrigins: z.array(z.url()).min(1),
  signingPrivateKey: z.string().optional(),
});

export type Config = z.infer<typeof Config>;

export const loadConfig = (): Config =>
  Config.parse({
    couchUrl: process.env.COUCHDB_URL ?? 'http://127.0.0.1:5984',
    couchUser: process.env.COUCHDB_USER ?? 'admin',
    couchPassword: process.env.COUCHDB_PASSWORD ?? 'devpassword',
    couchPublicUrl: process.env.COUCHDB_PUBLIC_URL ?? process.env.COUCHDB_URL ?? 'http://127.0.0.1:5984',
    port: process.env.PORT ?? 8080,
    corsOrigins: (process.env.APP_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((origin) => origin.trim()),
    signingPrivateKey: process.env.SIGNING_PRIVATE_KEY,
  });
