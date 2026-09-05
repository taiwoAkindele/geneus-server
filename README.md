# geneus-server

The one process that sits beside CouchDB. It is **not** the clinical write path — the PWA
replicates directly with CouchDB — so this repo holds only what CouchDB cannot do alone:
facility provisioning, roster signing, the server clock, device enrollment, and later
referral routing. Read [PLAN.md](PLAN.md) before changing anything; the architecture, the
debug map and the deliberately deferred pieces are decided there.

## Local development

```
npm install
npm run couch:up     # CouchDB 3.4 in Docker on :5984
npm run dev          # the server on :8080, watching sources
```

`docker-compose.yml` supplies CouchDB and `.env.example` lists every variable with its
local default. There is no manual CouchDB setup step: the server creates `_users`,
`_replicator` and the invites database at boot, and writes CouchDB's CORS configuration
itself.

## Deploying to Render

`render.yaml` is the entire deployment — CouchDB and one Node process, nothing else.
CouchDB is the **official `couchdb:3.4` image** run as a disk-backed web service (public,
because browsers replicate against it directly); the Node process is built from this
repo's `Dockerfile`.

1. **Create a Blueprint instance** pointed at this repo. Render reads `render.yaml`,
   creates the `geneus-couch-admin` environment group — generating the CouchDB admin
   password once and sharing it with both services so they cannot drift apart — and creates
   both services.
2. **Let CouchDB finish starting.** `geneus-server` restarts until CouchDB is reachable:
   configuration is validated at boot, so an unreachable database fails loudly instead of
   on the first request.
3. **Set the three variables Render cannot derive** (they are marked `sync: false`):

   | Variable | Where it comes from |
   | --- | --- |
   | `COUCHDB_PUBLIC_URL` | The CouchDB service's public URL, which exists only once that service does. It is written into every facility's sync credential at registration, so it must be the address **devices** can reach, never the internal one. |
   | `APP_ORIGINS` | Comma-separated origins where the PWA is served. Both the server's own CORS check and the CORS configuration it pushes into CouchDB are built from this. |
   | `SIGNING_PRIVATE_KEY` | `node scripts/generate-signing-key.ts`, run once per environment. Without it the server mints an ephemeral key at boot, so every restart invalidates every signature it has issued. |

4. **Restart `geneus-server`**, then confirm `GET /health` reports CouchDB reachable and
   `GET /time` returns a signature.
5. **Mint an invite** — `npm run invite -- "<facility name>" [valid-for-days]` — run
   anywhere that can reach CouchDB with the admin credentials (a shell on the Render
   service, or locally with `COUCHDB_URL` / `COUCHDB_USER` / `COUCHDB_PASSWORD` pointed at
   the deployment). Hand the code to the facility: registration is impossible without one.

### Operating rules

- **Redeploy CouchDB → restart `geneus-server`.** Only `/opt/couchdb/data` is on the
  persistent disk; CouchDB's runtime configuration is not, so redeploying it drops the CORS
  settings the PWA replicates through. The server re-applies them at every boot, so a
  restart is the whole fix. Skip it and the app stops syncing with a browser error that
  nothing in the CouchDB log explains.
- **Every CouchDB redeploy is downtime** — a disk-backed service is stopped before its
  replacement starts. Devices queue offline by design, so image upgrades are planned, not
  feared.
- **`autoDeployTrigger: off` on CouchDB is deliberate.** Nothing in this repo changes that
  image, and a code push must never restart the database.
- **Render's disk snapshots are not a database backup.** A real backup is continuous
  replication to a second CouchDB plus a restore drill that has actually been run — still
  to be built (PLAN.md §8).
- **Fauxton is public at `/_utils`** on the CouchDB service, admin-authenticated, and is
  part of the debug map (PLAN.md §5). Treat the admin password accordingly.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` · `npm start` | The server, watching sources · plain |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run couch:up` · `couch:down` | Local CouchDB in Docker |
| `npm run invite -- "<label>" [days]` | Mint a single-use facility registration code |
| `node scripts/generate-signing-key.ts` | Mint the Ed25519 signing keypair (once per environment) |
