import { createSql } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { loadConfig } from '../src/lib/config.ts';

/**
 * Applies pending migrations and exits. The server does the same at every boot,
 * so this exists for the cases where you want the schema without the process:
 * preparing a database before a deploy, or checking what a deploy would apply.
 *
 *   npm run db:migrate
 */
const sql = createSql(loadConfig().postgresUrl);
const outcomes = await migrate(sql);
await sql.end();

for (const outcome of outcomes) {
  console.log(`  ${outcome.outcome.padEnd(16)} ${String(outcome.version).padStart(4, '0')}_${outcome.name}`);
}
console.log(`\n  ${outcomes.filter((outcome) => outcome.outcome === 'applied').length} applied\n`);
