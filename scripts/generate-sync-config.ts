import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSyncConfig } from '../src/sync/syncConfig.ts';

/**
 * Regenerates powersync/sync-config.yaml from the shared contract. Run after
 * bumping the contract; the test suite fails if the committed file is stale.
 *
 *   npm run sync:config
 */
export const SYNC_CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'powersync', 'sync-config.yaml');

await writeFile(SYNC_CONFIG_PATH, buildSyncConfig());
console.log(`  wrote ${path.relative(process.cwd(), SYNC_CONFIG_PATH)}`);
