import { SCHEMA_BY_TYPE, type DocType } from '#shared';
import { snakeCase, TABLE_FOR } from '../db/records.ts';

/**
 * The PowerSync Sync Streams definition, generated from the contract so the
 * two can never drift: one stream per synced record type, every column the
 * contract names, filtered to the facility in the device's token. This is the
 * download half of facility isolation (the upload half is src/sync/upload.ts).
 *
 * Generated rather than hand-written for the same reason the CouchDB guard
 * was: a column added to the contract that a stream forgot would surface as
 * "missing on the device" days later. `scripts/generate-sync-config.ts`
 * writes it; a test asserts the committed file matches.
 */

/** The JWT claim geneus-server puts in every sync token (src/auth/syncToken.ts). */
export const FACILITY_CLAIM = 'facility_id';

/** Sync Streams (config.edition 3) — Sync Rules are deprecated. */
const EDITION = 3;

/**
 * Columns come back to the device under their contract names: PostgreSQL is
 * snake_case, SQLite and the repositories are camelCase, and the alias is the
 * one place that mapping happens on the way down. `id` and `type` need no
 * alias: `id` is `id`, and `type` is the table, not a column.
 */
const selectListFor = (type: DocType): string[] =>
  Object.keys(SCHEMA_BY_TYPE[type].shape)
    .filter((field) => field !== 'type')
    .map((field) => {
      const column = snakeCase(field);
      return column === field ? column : `${column} AS "${field}"`;
    });

export const streamNameFor = (type: DocType): string => TABLE_FOR[type];

export const buildSyncConfig = (): string => {
  const lines: string[] = [
    '# GENERATED from the shared contract by `npm run sync:config` — do not edit by hand.',
    '# One stream per synced record type, every contract column aliased to its',
    '# contract name, filtered to the facility in the device\'s sync token. See',
    '# src/sync/syncConfig.ts for why it is generated and SCHEMA.md §6 for the rule.',
    'config:',
    `  edition: ${EDITION}`,
    '',
    'streams:',
  ];

  for (const type of Object.keys(TABLE_FOR) as DocType[]) {
    const columns = selectListFor(type);
    lines.push(`  ${streamNameFor(type)}:`);
    lines.push('    auto_subscribe: true');
    lines.push('    query: |');
    lines.push(`      SELECT ${columns.join(', ')}`);
    lines.push(`      FROM ${TABLE_FOR[type]}`);
    lines.push(`      WHERE facility_id = auth.parameter('${FACILITY_CLAIM}')`);
  }

  return `${lines.join('\n')}\n`;
};
