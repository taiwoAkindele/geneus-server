import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSql } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { config } from './postgres.ts';

test('hospital billing migration creates immutable ledgers and private connection tables', async (t) => {
  const admin = createSql(config.postgresUrl);
  const name = `geneus_test_billing_${randomBytes(4).toString('hex')}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(config.postgresUrl); url.pathname = `/${name}`;
  const sql = createSql(url.toString());
  t.after(async () => { await sql.end(); await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await migrate(sql);
  const tables = await sql<{ tablename: string }[]>`SELECT tablename FROM pg_publication_tables WHERE pubname = 'powersync'`;
  assert(tables.some((row) => row.tablename === 'incoming_transfers'));
  assert(tables.some((row) => row.tablename === 'billing_departments'));
  assert(!tables.some((row) => row.tablename === 'billing_connections'));
});
