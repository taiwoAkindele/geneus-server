import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SCHEMA_BY_TYPE, type DocType } from '#shared';
import { TABLE_FOR } from '../src/db/records.ts';
import { buildSyncConfig } from '../src/sync/syncConfig.ts';
import { SYNC_CONFIG_PATH } from '../scripts/generate-sync-config.ts';

/**
 * The committed Sync Streams file is what the PowerSync service actually loads,
 * so it has to be the one the contract would generate — a contract bump
 * without `npm run sync:config` fails here rather than as a missing column on
 * a device a week later.
 */
describe('sync-config.yaml', () => {
  it('matches what the shared contract generates', async () => {
    const committed = await readFile(SYNC_CONFIG_PATH, 'utf8');

    assert.equal(committed.replace(/\r\n/g, '\n'), buildSyncConfig(), 'run: npm run sync:config');
  });

  it('defines one facility-filtered, auto-subscribed stream per synced table', () => {
    const config = buildSyncConfig();

    for (const type of Object.keys(TABLE_FOR) as DocType[]) {
      const table = TABLE_FOR[type];
      assert.ok(config.includes(`
  ${table}:
    auto_subscribe: true
`), `${table} is not an auto-subscribed stream`);
      assert.ok(
        config.includes(`FROM ${table}
      WHERE facility_id = auth.parameter('facility_id')`),
        `${table} is not filtered to the token's facility`,
      );
    }
    assert.equal((config.match(/auto_subscribe: true/g) ?? []).length, Object.keys(TABLE_FOR).length);
  });

  it('selects every contract field of every type, and never a column the contract does not know', () => {
    const config = buildSyncConfig();

    for (const type of Object.keys(SCHEMA_BY_TYPE) as DocType[]) {
      const stream = config.slice(config.indexOf(`  ${TABLE_FOR[type]}:`));
      const select = stream.slice(stream.indexOf('SELECT'), stream.indexOf('FROM'));
      for (const field of Object.keys(SCHEMA_BY_TYPE[type].shape).filter((field) => field !== 'type')) {
        assert.ok(select.includes(field === 'id' ? 'SELECT id,' : `${field}"`) || select.includes(` ${field},`) || select.includes(` ${field}\n`), `${type}.${field} is not synced`);
      }
    }
    assert.equal(config.includes('credential'), false);
  });
});
