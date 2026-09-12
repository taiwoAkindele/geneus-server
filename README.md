# geneus-server

The one Node process (Fastify) beside PostgreSQL and the PowerSync service. It owns
what synchronisation must never decide for itself: facility registration, device
enrollment and credentials, the server clock, and — as of Phase C of the migration —
authorising every mutation a device uploads before it reaches PostgreSQL. Clinical
reads and writes happen on the device against SQLite; PowerSync moves them.

> **Migration in progress (CouchDB → PostgreSQL + PowerSync).** PostgreSQL is the source
> of truth from Phase B onward. `src/couch/`, its tests and `render.yaml` remain only
> until Phase F removes them; the server no longer uses CouchDB. [PLAN.md](PLAN.md) is
> rewritten in Phase F; until then its CouchDB sections describe the previous
> architecture.

## Local development

```
npm install
npm run db:up        # PostgreSQL 17 in Docker on :5433 (wal_level=logical, for PowerSync)
npm run dev          # the server on :8080, watching sources; migrates at boot
```

`docker-compose.yml` supplies PostgreSQL and `.env.example` lists every variable with
its local default. There is no manual database setup: the server applies pending
migrations from `src/db/migrations/` at every boot (`npm run db:migrate` does the same
without starting the process).

## Tests

```
npm test             # against the PostgreSQL from db:up
```

Suites that touch persistence run against real PostgreSQL, never a mock: each test file
creates its own database, migrates it, and drops it afterwards, so files run in
parallel. The contract's own suites (`shared/tests`) run as part of the same command.
The legacy CouchDB suites still run too and need `npm run couch:up`; they go in Phase F.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | PostgreSQL reachability, signing-key source and fingerprint, schema version |
| `GET /time` | Ed25519-signed server clock — the anchor of the 7-day offline window |
| `GET /invites/:token` | Check a facility invite before the admin fills anything in |
| `POST /facilities` | Register a facility, its first admin, and enrol the registering device (returns the device credential, once) |

Every shape is in the shared contract (`shared/src/api.ts`).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` · `npm start` | The server, watching sources · plain |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | The suite, against the PostgreSQL from `db:up` |
| `npm run db:up` · `db:down` | Local PostgreSQL in Docker |
| `npm run db:migrate` | Apply pending migrations and exit |
| `npm run invite -- "<label>" [days]` | Mint a single-use facility registration code |
| `node scripts/generate-signing-key.ts` | Mint the Ed25519 signing keypair (once per environment) |
| `npm run couch:up` · `sync:design` | Legacy — CouchDB for the suites that still need it (Phase F removes both) |

## Configuration

| Variable | Meaning |
| --- | --- |
| `POSTGRES_URL` | The source of truth. Local default points at `db:up`. |
| `POWERSYNC_PUBLIC_URL` | Where **devices** connect PowerSync to; handed out at enrollment, so never an internal address. |
| `APP_ORIGINS` | Comma-separated origins allowed to call this server. |
| `PORT` | Listening port. |
| `SIGNING_PRIVATE_KEY` | Ed25519 private key (PKCS#8, base64). Optional in development (an ephemeral key is minted at boot); **required in production** — the server refuses to start without it, because an ephemeral key invalidates every signature at the next restart. |
| `NODE_ENV` | `production` switches to JSON logs and enforces the above. |

Deployment (Docker Compose as the reference, provider-agnostic in production) is
documented in Phase F, once the PowerSync service is part of the stack.
