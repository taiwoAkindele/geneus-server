import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMigrations, migrate } from '../src/db/migrate.ts';
import { TABLE_FOR } from '../src/db/records.ts';
import { scratchDatabase, type ScratchDatabase } from './postgres.ts';

/**
 * The runner is the only thing standing between a deploy and a half-applied
 * schema, so what matters is the consequence: run it twice, get one schema.
 */
describe('migrate', () => {
  let db: ScratchDatabase;

  before(async () => {
    db = await scratchDatabase();
  });

  after(async () => {
    await db.drop();
  });

  it('records every file it applied, in order', async () => {
    const rows = await db.sql<{ version: number; name: string }[]>`
      SELECT version, name FROM schema_migrations ORDER BY version`;
    const files = await loadMigrations();

    assert.deepEqual(
      rows.map((row) => `${row.version}_${row.name}`),
      files.map((file) => `${file.version}_${file.name}`),
    );
  });

  it('is idempotent, so the server can run it at every boot', async () => {
    const outcomes = await migrate(db.sql);

    assert.ok(outcomes.length > 0);
    assert.ok(outcomes.every((outcome) => outcome.outcome === 'already_applied'));
  });

  it('creates a table for every record type in the contract', async () => {
    const tables = new Set(
      (await db.sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((row) => row.table_name),
    );

    for (const table of Object.values(TABLE_FOR)) {
      assert.ok(tables.has(table), `missing table ${table}`);
    }
    for (const serverOnly of ['device_credentials', 'applied_mutations', 'facility_invites', 'schema_migrations']) {
      assert.ok(tables.has(serverOnly), `missing table ${serverOnly}`);
    }
  });
});
