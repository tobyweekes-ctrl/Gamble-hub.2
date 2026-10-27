import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countPmf, mixturePmf, lineProbs, normCdf } from '../server/model/distributions.mjs';
import { parsePrice, noVig, expectedValue } from '../server/model/odds.mjs';
import { evaluateLine, hitRates } from '../server/model/evaluate.mjs';
import { DEFAULTS, mergeConfig, parseOverride } from '../server/model/config.mjs';
import { seasonWeight } from '../server/model/blend.mjs';

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('count pmfs sum to 1 with the right mean and variance', () => {
  const pois = countPmf(4, 0, 60);
  assert.ok(Math.abs(sum(pois) - 1) < 1e-9);
  assert.ok(Math.abs(sum(pois.map((p, x) => p * x)) - 4) < 1e-9);
  const nb = countPmf(20, 0.05, 200); // var = mu + mu^2/k = 20 + 400*0.05 = 40
  const m = sum(nb.map((p, x) => p * x));
  const v = sum(nb.map((p, x) => p * (x - m) ** 2));
  assert.ok(Math.abs(m - 20) < 1e-6 && Math.abs(v - 40) < 1e-4);
});

test('minutes mixture: mean = rate x minutes, wider than fixed minutes', () => {
  const fixed = mixturePmf({ ratePerMin: 0.6, minMean: 32, minSd: 0.001, invK: 0.03 });
  const mixed = mixturePmf({ ratePerMin: 0.6, minMean: 32, minSd: 6, invK: 0.03 });
  assert.ok(Math.abs(fixed.mean - 19.2) < 0.01);
  assert.ok(Math.abs(mixed.mean - 19.2) < 0.1);
  assert.ok(mixed.sd > fixed.sd);
});

test('line probabilities: half lines have no push, integer lines do', () => {
  const pmf = countPmf(10, 0, 60);
  const h = lineProbs(pmf, 9.5);
  assert.equal(h.push, 0);
  assert.ok(Math.abs(h.over + h.under - 1) < 1e-9);
  const i = lineProbs(pmf, 10);
  assert.ok(i.push > 0.1 && Math.abs(i.over + i.under + i.push - 1) < 1e-9);
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7 && Math.abs(normCdf(1.96) - 0.975) < 1e-3);
});

test('price parsing: decimal, fractional, American, evens', () => {
  assert.equal(parsePrice('1.91'), 1.91);
  assert.ok(Math.abs(parsePrice('10/11') - 1.90909) < 1e-4);
  assert.equal(parsePrice('5/4'), 2.25);
  assert.ok(Math.abs(parsePrice('-110') - 1.90909) < 1e-4);
  assert.equal(parsePrice('+150'), 2.5);
  assert.equal(parsePrice('evens'), 2);
  assert.equal(parsePrice('0.9'), null);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('abc'), null);
});

test('no-vig removes the margin; one-sided uses the assumed margin', () => {
  const f = noVig(1.91, 1.91);
  assert.ok(Math.abs(f.over - 0.5) < 1e-9 && f.margin > 0.04);
  const p = noVig(1.5, 2.6, { method: 'power' });
  assert.ok(Math.abs(p.over + p.under - 1) < 1e-6);
  const one = noVig(2.0, null, { assumedMargin: 0.05 });
  assert.ok(one.estimated && Math.abs(one.over - 0.5 / 1.05) < 1e-9 && one.under === null);
  assert.ok(Math.abs(expectedValue(0.55, 0, 1.91) - (0.55 * 0.91 - 0.45)) < 1e-12);
});

test('verdict respects the threshold and EV; confidence scales with edge', () => {
  const sp = { pmf: countPmf(25, 0.03, 120) }; // mean 25
  const q = { score: 1, notes: [] };
  const cfg = DEFAULTS;
  const over = evaluateLine(sp, { line: 20.5, over: 1.91, under: 1.91 }, q, cfg);
  assert.equal(over.verdict, 'OVER');
  assert.equal(over.confidence, 'HIGH');
  const pass = evaluateLine(sp, { line: 24.5, over: 1.91, under: 1.91 }, q, cfg);
  assert.equal(pass.verdict, 'PASS');
  const under = evaluateLine(sp, { line: 30.5, over: '10/11', under: '10/11' }, q, cfg);
  assert.equal(under.verdict, 'UNDER');
  // big edge vs no-vig but a huge margin (1.25 both sides) -> EV < 0 -> no bet
  const bad = evaluateLine(sp, { line: 20.5, over: 1.25, under: 1.25 }, q, cfg);
  assert.ok(bad.edge.over > 0.04 && bad.ev.over < 0);
  assert.equal(bad.verdict, 'PASS');
  // higher threshold turns a bet into a pass
  assert.equal(evaluateLine(sp, { line: 22.5, over: 1.91, under: 1.91 }, q, mergeConfig(cfg, { threshold: 0.5 })).verdict, 'PASS');
});

test('hit rates vs exact line', () => {
  const logs = [10, 20, 30, 25, 15, 22].map((pts, i) => ({ pts, season: i < 2 ? '2025-26' : '2026-27' }));
  const h = hitRates(logs, 'pts', 20.5, '2026-27');
  assert.deepEqual([h.last5.n, h.last5.over], [5, 3]);
  assert.deepEqual([h.season.n, h.season.over], [4, 3]);
  assert.deepEqual([h.lastSeason.n, h.lastSeason.over], [2, 0]);
});

test('config overrides and season weight', () => {
  assert.deepEqual(parseOverride('recency.last5=0.3'), { recency: { last5: 0.3 } });
  const c = mergeConfig(DEFAULTS, parseOverride('blend.rateK=6'));
  assert.equal(c.blend.rateK, 6);
  assert.equal(c.blend.minutesK, DEFAULTS.blend.minutesK);
  assert.equal(seasonWeight(0, 12), 0);
  assert.ok(Math.abs(seasonWeight(12, 12) - 0.5) < 1e-12);
});

// ---- integration on the demo league ----
process.env.STATS_PROVIDER = 'demo';
process.env.TODAY = '2026-10-27';
process.env.CACHE_DIR = mkdtempSync(join(tmpdir(), 'nbacache-'));
process.env.USERDATA_DIR = mkdtempSync(join(tmpdir(), 'nbaud-'));
const store = await import('../server/data/store.mjs');
const { analyse, buildContext, projectPlayer } = await import('../server/model/index.mjs');
const { demoInternals } = await import('../server/providers/demo.mjs');
const L = await store.getLeague();

test('analyse: full output for a player on tonight\'s slate', async () => {
  const slate = await store.getSlate();
  const team = slate[0].home;
  const p = [...L.players.values()].find((x) => x.team === team && L.playerLogs(x.id).length > 40);
  const lines = (await store.getPlayerLines(p, 'pra')).lines;
  const a = analyse({ L, playerId: p.id, game: { date: L.today, team, opp: slate[0].away, home: true }, stat: 'pra', lines });
  assert.ok(a.projection.mean > 5 && a.projection.minutes.proj > 10);
  assert.equal(a.evals.length, lines.length);
  for (const e of a.evals) assert.ok(['OVER', 'UNDER', 'PASS'].includes(e.verdict));
  assert.ok(a.hitRates.last10.n === 10);
  assert.ok(Math.abs(a.projection.pmf.reduce((x, y) => x + y, 0) - 1) < 0.01);
});

test('minutes: teammate out raises minutes; return ramp lowers them', () => {
  const p = [...L.players.values()].find((x) => L.playerLogs(x.id).length > 60 && L.groupOf(x.id) === 'G');
  const game = { date: L.today, team: p.team, opp: p.team === 'BOS' ? 'NYK' : 'BOS', home: true };
  const base = projectPlayer(buildContext(L, p.id, game), DEFAULTS).minutes.proj;
  const ctx0 = buildContext(L, p.id, game);
  const mate = ctx0.availableMates.sort((a, b) => b.min - a.min)[0];
  const withOut = projectPlayer(buildContext(L, p.id, game, { teammatesOut: [mate.id] }), DEFAULTS).minutes;
  assert.ok(withOut.proj > base, `${withOut.proj} > ${base}`);
  assert.ok(withOut.steps.some((s) => s.key === `mate:${mate.id}`));

  const ret = demoInternals.storyPlayer(demoInternals.STORY.find((s) => s[2] === 'returning'));
  const m = projectPlayer(buildContext(L, ret.id, { date: L.today, team: ret.team, opp: 'BOS', home: true }), DEFAULTS).minutes;
  assert.ok(m.restricted && m.steps.some((s) => s.key === 'restriction'));
});
