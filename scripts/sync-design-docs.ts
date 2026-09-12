import nano from 'nano';
import { syncDesignDocs } from '../src/couch/provision.ts';

/**
 * Pushes the generated guard into every facility database, so a contract change
 * reaches the facilities that already exist — not only the ones registered
 * after it. Run it as part of deploying a contract change; re-running costs
 * nothing, since unchanged databases are left at their current revision.
 *
 *   node scripts/sync-design-docs.ts
 */
// Legacy (removed in Phase F): reads CouchDB straight from the environment.
const couch = nano({
  url: process.env.COUCHDB_URL ?? 'http://127.0.0.1:5984',
  requestDefaults: {
    auth: { username: process.env.COUCHDB_USER ?? 'admin', password: process.env.COUCHDB_PASSWORD ?? 'devpassword' },
  },
});

const results = await syncDesignDocs(couch);

for (const result of results) {
  console.log(`  ${result.outcome.padEnd(10)} ${result.database}`);
}

const counted = (outcome: string) => results.filter((result) => result.outcome === outcome).length;
console.log(
  `\n  ${results.length} facility databases · ${counted('created')} created · ` +
    `${counted('updated')} updated · ${counted('unchanged')} unchanged\n`,
);

/**
 * A database that could not be identified still holds whatever guard it had, so
 * this is not a failure to roll back — but it is the one outcome a deploy must
 * not scroll past, because that facility is now on an older contract.
 */
const unresolved = results.filter((result) => result.outcome === 'unresolved');
if (unresolved.length > 0) {
  console.error(
    `  ${unresolved.length} database(s) have no facility document and were skipped:\n` +
      unresolved.map((result) => `    ${result.database}`).join('\n'),
  );
  process.exit(1);
}
