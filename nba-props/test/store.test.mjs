// End-to-end over the demo provider: league build, search, absences, slate and odds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATS_PROVIDER = 'demo';
process.env.TODAY = '2026-10-27';
process.env.CACHE_DIR = mkdtempSync(join(tmpdir(), 'nbacache-'));
const store = await import('../server/data/store.mjs');
const { demoInternals } = await import('../server/providers/demo.mjs');

const L = await store.getLeague();

test('league has two seasons and no future games', () => {
  assert.equal(L.current, '2026-27');
  assert.equal(L.previous, '2025-26');
  assert.ok(L.bySeason['2025-26'].rows.length > 15000);
  for (const r of L.bySeason['2026-27'].rows) assert.ok(r.date < '2026-10-27');
  const lg = L.bySeason['2025-26'].summary.league;
  assert.ok(lg.pace > 95 && lg.pace < 108, `pace ${lg.pace}`);
});

test('search finds by partial and multi-word names', () => {
  const p = [...L.players.values()][42];
  const [first, last] = p.name.split(' ');
  assert.equal(store.searchPlayers(L, `${first.slice(0, 3)} ${last.slice(0, 3)}`)[0].id, p.id);
  assert.deepEqual(store.searchPlayers(L, ''), []);
});

test('scripted returning players are flagged with games missed', () => {
  for (const s of demoInternals.STORY.filter((x) => x[2] === 'returning')) {
    const a = L.absence(demoInternals.storyPlayer(s).id);
    assert.equal(a.status, 'returned');
    assert.ok(a.gamesMissed >= 5);
  }
});

test('slate and lines: best over/under flagged once each', async () => {
  const slate = await store.getSlate();
  assert.ok(slate.length > 0);
  const team = slate[0].home;
  const starter = [...L.players.values()].find((p) => p.team === team && L.playerLogs(p.id).length > 40);
  const res = await store.getPlayerLines(starter, 'pts');
  assert.ok(res.lines.length >= 2);
  assert.equal(res.lines.filter((l) => l.bestOver).length, 1);
  assert.equal(res.lines.filter((l) => l.bestUnder).length, 1);
  const bo = res.lines.find((l) => l.bestOver);
  assert.equal(bo.line, Math.min(...res.lines.map((l) => l.line)));
});
