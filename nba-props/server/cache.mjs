// Two-level cache: in-memory map in front of JSON files on disk.
// - cached(key, ttlSec, fn): returns a fresh value or calls fn once (concurrent callers share the call)
// - if fn throws and a stale value exists, the stale value is served (stale-if-error)
// - ttlSec = Infinity for immutable data (e.g. completed past seasons)
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { config } from './env.mjs';

const mem = new Map();
const inflight = new Map();
export const cacheStats = { hits: 0, misses: 0, stale: 0, errors: 0 };

mkdirSync(config.cacheDir, { recursive: true });
const fileFor = (key) => join(config.cacheDir, createHash('sha1').update(key).digest('hex') + '.json');

function readEntry(key) {
  if (mem.has(key)) return mem.get(key);
  const f = fileFor(key);
  if (!existsSync(f)) return null;
  try {
    const entry = JSON.parse(readFileSync(f, 'utf8'));
    mem.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

function writeEntry(key, value, ttlSec) {
  const entry = { key, storedAt: Date.now(), ttlSec: Number.isFinite(ttlSec) ? ttlSec : null, value };
  mem.set(key, entry);
  writeFileSync(fileFor(key), JSON.stringify(entry));
  return entry;
}

const isFresh = (e) => e && (e.ttlSec == null || Date.now() - e.storedAt < e.ttlSec * 1000);

export async function cached(key, ttlSec, fn) {
  const entry = readEntry(key);
  if (isFresh(entry)) {
    cacheStats.hits++;
    return entry.value;
  }
  if (inflight.has(key)) return inflight.get(key);
  cacheStats.misses++;
  const p = (async () => {
    try {
      const value = await fn();
      writeEntry(key, value, ttlSec);
      return value;
    } catch (err) {
      cacheStats.errors++;
      if (entry) {
        cacheStats.stale++;
        console.warn(`[cache] serving stale "${key}": ${err.message}`);
        return entry.value;
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Age in seconds of a cached key, or null. */
export function cacheAge(key) {
  const e = readEntry(key);
  return e ? Math.round((Date.now() - e.storedAt) / 1000) : null;
}

export function cacheInfo() {
  const files = readdirSync(config.cacheDir).filter((f) => f.endsWith('.json'));
  const bytes = files.reduce((s, f) => s + statSync(join(config.cacheDir, f)).size, 0);
  return { entries: files.length, bytes, ...cacheStats };
}

export function clearCache() {
  mem.clear();
  for (const f of readdirSync(config.cacheDir)) rmSync(join(config.cacheDir, f), { force: true });
}
