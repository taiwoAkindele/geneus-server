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
    assert.equal((config.match(/auto_subscribe: true/g) ?? []).length, syncedTypes().length + 4);
    assert.ok(config.includes('  sync_rejections_legacy:'));
    for (const type of ['audit_events','sync_rejections']) {
      assert.ok(config.includes(`  ${type}_ward_care:`));
    }
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
    assert.ok(config.includes("ifnull(entity_type, '') <> 'inpatient_event' AND ifnull(entity_type, '') <> 'bed_ready_event'"));
  });

  // PowerSync expands each query's inner ORs into separate branches and
  // refuses the whole config at startup when one query needs more than 100
  // (sync-rules compiler/parser.js) — the service then restarts in a loop.
  it('keeps every query within PowerSync\'s 100-branch OR expansion limit', () => {
    /** Top-level OR alternatives in one filter line, e.g. `(a OR b OR (c AND d))` is 3. */
    const disjuncts = (filter: string): number => {
      // A parenthesis that wraps the whole filter opens at depth 0 and closes only at the last character.
      let depth = 0, wrapped = filter.startsWith('('), count = 1;
      for (let i = 0; i < filter.length; i++) {
        if (filter[i] === '(') depth++;
        else if (filter[i] === ')' && --depth === 0 && i < filter.length - 1) wrapped = false;
      }
      const body = wrapped ? filter.slice(1, -1) : filter;
      depth = 0;
      for (let i = 0; i < body.length; i++) {
        if (body[i] === '(') depth++;
        else if (body[i] === ')') depth--;
        else if (depth === 0 && body.startsWith(' OR ', i)) count++;
      }
      return count;
    };
    let stream = '';
    const queries: { stream: string; branches: number }[] = [];
    for (const line of buildSyncConfig().split('\n')) {
      const name = line.match(/^  ([a-z_]+):$/)?.[1];
      if (name) stream = name;
      else if (line === '      - |') queries.push({ stream, branches: 1 });
      else if (/^\s+(WHERE|AND) /.test(line)) queries[queries.length - 1].branches *= disjuncts(line.trim().replace(/^(WHERE|AND) /, ''));
    }
    assert.ok(queries.length > 0);
    const totals = new Map<string, number>();
    for (const { stream, branches } of queries) totals.set(stream, (totals.get(stream) ?? 0) + branches);
    for (const [stream, branches] of totals) assert.ok(branches <= 100, `the ${stream} stream expands to ${branches} OR branches across all its queries`);
  });
});
