import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CACHE_DIR = mkdtempSync(join(tmpdir(), 'nbacache-'));
const { cached, cacheStats } = await import('../server/cache.mjs');

test('concurrent callers share one fetch; fresh values are served from cache', async () => {
  let calls = 0;
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { v: calls }; };
  const [a, b] = await Promise.all([cached('k1', 60, fn), cached('k1', 60, fn)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  await cached('k1', 60, fn);
  assert.equal(calls, 1);
});

test('expired + failing fetch serves stale value', async () => {
  await cached('k2', 0.001, async () => 'old');
  await new Promise((r) => setTimeout(r, 10));
  const v = await cached('k2', 60, async () => { throw new Error('down'); });
  assert.equal(v, 'old');
  assert.ok(cacheStats.stale >= 1);
});

test('failing fetch with nothing cached throws', async () => {
  await assert.rejects(cached('k3', 60, async () => { throw new Error('down'); }), /down/);
});
