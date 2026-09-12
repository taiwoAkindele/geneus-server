import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './client.ts';

/**
 * Plain numbered SQL files, applied once each, in order. Forty lines instead of
 * a migration framework: the schema is read as SQL, diffs are reviewed as SQL,
 * and the only state is the `schema_migrations` table — inspectable with one
 * SELECT. Runs at every server boot, so a deploy is a deploy; re-running is
 * free.
 */
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** `0001_initial_schema.sql` → version 1, name "initial_schema". */
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/**
 * Two processes booting at once (a redeploy overlapping the old instance) must
 * not both apply the same file. An advisory lock serialises them; the second
 * sees the first's rows and applies nothing.
 */
const MIGRATION_LOCK = 7_244_001;

export type Migration = { version: number; name: string; sql: string };
export type MigrationOutcome = { version: number; name: string; outcome: 'applied' | 'already_applied' };

export const loadMigrations = async (dir = MIGRATIONS_DIR): Promise<Migration[]> => {
  const files = (await readdir(dir)).filter((file) => FILE_PATTERN.test(file)).sort();
  const migrations = await Promise.all(
    files.map(async (file) => {
      const [, version, name] = FILE_PATTERN.exec(file) as RegExpExecArray;
      return { version: Number(version), name, sql: await readFile(path.join(dir, file), 'utf8') };
    }),
  );
  const versions = new Set(migrations.map((migration) => migration.version));
  if (versions.size !== migrations.length) {
    throw new Error(`two migration files share a version number in ${dir}`);
  }
  return migrations;
};

export const migrate = async (sql: Sql, migrations?: Migration[]): Promise<MigrationOutcome[]> => {
  const pending = migrations ?? (await loadMigrations());
  const outcomes: MigrationOutcome[] = [];

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     integer PRIMARY KEY,
        name        text NOT NULL,
        applied_on  timestamptz NOT NULL DEFAULT now()
      )`;
    const applied = new Set(
      (await tx<{ version: number }[]>`SELECT version FROM schema_migrations`).map((row) => row.version),
    );

    for (const migration of pending) {
      if (applied.has(migration.version)) {
        outcomes.push({ version: migration.version, name: migration.name, outcome: 'already_applied' });
        continue;
      }
      // `simple()` sends the file as one multi-statement script — what a
      // migration is — instead of a single prepared statement.
      await tx.unsafe(migration.sql).simple();
      await tx`INSERT INTO schema_migrations (version, name) VALUES (${migration.version}, ${migration.name})`;
      outcomes.push({ version: migration.version, name: migration.name, outcome: 'applied' });
    }
  });

  return outcomes;
};
