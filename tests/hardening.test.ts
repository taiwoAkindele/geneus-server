import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createRateLimiter } from '../src/lib/rateLimit.ts';
import { config, scratchDatabase, signer, type ScratchDatabase } from './postgres.ts';

/**
 * What every response promises regardless of route: security headers, no
 * internal detail in a 5xx, a limit on guessing codes, and a health status an
 * uptime check can read from the status line alone.
 */
describe('server hardening', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;

  before(async () => {
    db = await scratchDatabase();
    // PowerSync is pointed somewhere nothing listens, so /health is degraded.
    app = buildApp({ config: { ...config, powerSyncInternalUrl: 'http://127.0.0.1:9' }, sql: db.sql, signer }, { logger: false });
    app.get('/test-failure', async () => {
      throw new Error('relation "secret_table" does not exist');
    });
  });

  after(async () => {
    await app.close();
    await db.drop();
  });

  it('sends security headers and forbids caching', async () => {
    const response = await app.inject({ method: 'GET', url: '/time' });

    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  it('answers a server failure with a plain sentence, not the internal error', async () => {
    const response = await app.inject({ method: 'GET', url: '/test-failure' });

    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error, 'internal_error');
    assert.doesNotMatch(response.body, /secret_table/);
  });

  it('reports a degraded dependency as 503', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().status, 'degraded');
    assert.equal(response.json().powerSync, 'unreachable');
  });

  it('stops an address guessing invite codes after ten tries a minute', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await app.inject({ method: 'GET', url: `/invites/GUESS${attempt}` })).statusCode);
    }

    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404));
    assert.equal(statuses[10], 429);
  });
});

describe('rate limiter', () => {
  it('opens a fresh window once the old one has passed', () => {
    const limiter = createRateLimiter(1, 1000);

    assert.equal(limiter.hit('a', 0), undefined);
    assert.equal(limiter.hit('a', 10), 1);
    assert.equal(limiter.hit('b', 10), undefined);
    assert.equal(limiter.hit('a', 1000), undefined);
  });
});
