import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SCHEMA_BY_TYPE, RESTRICTED_FACILITY_DOCUMENT_TYPES } from '#shared';
import { TABLE_FOR } from '../src/db/records.ts';
import { buildSyncConfig, syncedTypes } from '../src/sync/syncConfig.ts';
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

    for (const type of syncedTypes()) {
      const table = TABLE_FOR[type];
      assert.ok(config.includes(`
  ${table}:
    auto_subscribe: true
`), `${table} is not an auto-subscribed stream`);
      assert.ok(
        new RegExp(`FROM ${table}\\n\\s+WHERE facility_id = auth.parameter\\('facility_id'\\)`).test(config),
        `${table} is not filtered to the token's facility`,
      );
    }
    assert.equal((config.match(/auto_subscribe: true/g) ?? []).length, syncedTypes().length);
  });

  it('selects every contract field of every type, and never a column the contract does not know', () => {
    const config = buildSyncConfig();

    for (const type of syncedTypes()) {
      const stream = config.slice(config.indexOf(`  ${TABLE_FOR[type]}:`));
      const select = stream.slice(stream.indexOf('SELECT'), stream.indexOf('FROM'));
      for (const field of Object.keys(SCHEMA_BY_TYPE[type].shape).filter((field) => field !== 'type')) {
        assert.ok(select.includes(field === 'id' ? 'SELECT id,' : `${field}"`) || select.includes(` ${field},`) || select.includes(` ${field}\n`), `${type}.${field} is not synced`);
      }
    }
    for (const type of RESTRICTED_FACILITY_DOCUMENT_TYPES) assert.equal(config.includes(`FROM ${TABLE_FOR[type]}\n`),false);
    assert.ok(config.includes("AND (visibility IS NULL OR visibility = 'facility')"));
    assert.ok(config.includes('AND is_current = true'));
    assert.ok(config.includes("AND auth.parameter('facility_contract') = 1"));
    assert.ok(config.includes("auth.parameter('facility_contract') IS NULL"));
    assert.ok(config.includes("AND auth.parameter('inpatient_workflow') = 1"));
    assert.ok(config.includes("entity_type <> 'inpatient_event' AND entity_type <> 'bed_ready_event'"));
  });
});
