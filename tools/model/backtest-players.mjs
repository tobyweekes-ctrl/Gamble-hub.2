#!/usr/bin/env node
// Out-of-sample test of the player model (players.mjs) for outfield starters.
//
// Walk-forward, weekly: player rates use only matches before the week; the match
// context (team expected shots and fouls) comes from rating models fitted before
// the week (walkforward.mjs). Shrinkage k and dispersion r are chosen on the
// validation seasons (2023/24, 2024/25) by log-loss, then everything is scored on
// 2025/26 onwards against two simpler baselines:
//   position  - the position-group average for the competition, no player, no context
//   player    - the player's shrunk rate, no match context
//   model     - the player's shrunk rate x match context (what the site shows)
// Writes data/model/players.json (fitted parameters + test report).
//
// Usage: node tools/model/backtest-players.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMatches } from './data.mjs';
import { weeks, rateComponent } from './walkforward.mjs';
import { loadLineups, joinLineups } from './lineups.mjs';
import { playerTable, rateFor, atLeast, groupOf, MARKETS, STATS } from './players.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DAY = 864e5;
const matches = loadMatches(path.join(root, 'data/raw'));
const lineups = loadLineups(path.join(root, 'data/raw'));
const TEST_FROM = '2526';

// Weeks from October 2023, so every player has some history.
const wks = weeks(matches, '2324').filter(w => w.asOf >= Date.UTC(2023, 9, 1));
console.log(`Fitting team context models over ${wks.length} weeks...`);
const shotsL = rateComponent(matches, wks, { xi: 0.004, sigma: 0.6, hKey: 'hs', aKey: 'as' });
const foulsL = rateComponent(matches, wks, { xi: 0.004, sigma: 0.6, hKey: 'hf', aKey: 'af' });

// Team averages per match over the previous 365 days (football-data names).
function teamAvg(team, t, hk, ak) {
  let s = 0, n = 0;
  for (const m of matches) {
    if (m.date >= t || t - m.date > 365 * DAY || m[hk] == null) continue;
    if (m.home === team) { s += m[hk]; n++; } else if (m.away === team) { s += m[ak]; n++; }
  }
  return n >= 5 ? s / n : null;
}
const avgCache = new Map();
const avg = (team, t, hk, ak) => {
  const key = `${team}|${Math.floor(t / (7 * DAY))}|${hk}`;
  if (!avgCache.has(key)) avgCache.set(key, teamAvg(team, t, hk, ak));
  return avgCache.get(key);
};

const evalMatches = wks.flatMap(w => w.matches.map(m => ({ m, asOf: w.asOf })));
const joined = joinLineups(evalMatches.map(x => x.m), lineups);
const rows = []; // one per outfield starter per match, with the player table as of its week
const tables = new Map();
for (const { m, asOf } of evalMatches) {
  const l = joined.get(m);
  if (!l || !shotsL.has(m) || !foulsL.has(m)) continue;
  if (!tables.has(asOf)) tables.set(asOf, playerTable(lineups, asOf));
  const es = shotsL.get(m), ef = foulsL.get(m);
  const ratio = (e, a) => (e && a ? e / a : 1);
  const ctx = {
    home: { shots: ratio(es.lh, avg(m.home, asOf, 'hs', 'as')), fouls: ratio(ef.lh, avg(m.home, asOf, 'hf', 'af')), oppFouls: ratio(ef.la, avg(m.away, asOf, 'hf', 'af')) },
    away: { shots: ratio(es.la, avg(m.away, asOf, 'hs', 'as')), fouls: ratio(ef.la, avg(m.away, asOf, 'hf', 'af')), oppFouls: ratio(ef.lh, avg(m.home, asOf, 'hf', 'af')) },
  };
  for (const side of ['home', 'away']) for (const p of l[side].players) {
    if (!p.start || groupOf(p.pos) === 'G') continue;
    rows.push({ season: m.season, div: m.div, p, ctx: ctx[side], table: tables.get(asOf) });
  }
}
const valid = rows.filter(r => r.season < TEST_FROM), test = rows.filter(r => r.season >= TEST_FROM);
console.log(`${valid.length} validation and ${test.length} test player-matches`);

const CTXKEY = { sh: 'shots', sot: 'shots', fc: 'fouls', yc: 'fouls', fw: 'oppFouls' };
function prob(r, mk, k, rr, variant) {
  if (r.p[mk.stat] === undefined) return null;
  let mu;
  if (variant === 'position') mu = rateFor(r.table, null, r.div, r.p.pos, mk.stat, 1e9).rate;
  else mu = rateFor(r.table, r.p.id, r.div, r.p.pos, mk.stat, k).rate;
  if (variant === 'model' && (!params.context || params.context[mk.stat] !== false)) mu *= r.ctx[CTXKEY[mk.stat]];
  return atLeast(mu, mk.atLeast, rr);
}
const score = (set, mk, k, rr, variant) => {
  let ll = 0, br = 0, n = 0;
  for (const r of set) {
    const q = prob(r, mk, k, rr, variant);
    if (q == null) continue;
    const y = r.p[mk.stat] >= mk.atLeast ? 1 : 0;
    const c = Math.min(Math.max(q, 1e-6), 1 - 1e-6);
    ll -= y ? Math.log(c) : Math.log(1 - c); br += (q - y) ** 2; n++;
  }
  return { n, logloss: +(ll / n).toFixed(4), brier: +(br / n).toFixed(4) };
};

const params = { k: {}, r: {}, context: {} };
for (const s of STATS) {
  const mk = MARKETS.find(x => x.stat === s);
  let best = null;
  for (const k of [2, 5, 10, 20, 40]) for (const rr of [1, 2, 4, 8, Infinity]) {
    const v = score(valid, mk, k, rr, 'model');
    if (!best || v.logloss < best.v.logloss) best = { k, rr, v };
  }
  params.k[s] = best.k; params.r[s] = best.rr === Infinity ? null : best.rr;
  // Use the match context for this stat only if it beat the plain player rate on validation.
  const noCtx = score(valid, mk, best.k, best.rr, 'player');
  params.context[s] = best.v.logloss < noCtx.logloss;
  console.log(`${s}: k=${best.k} r=${best.rr} (validation log-loss ${best.v.logloss}, without context ${noCtx.logloss}, context ${params.context[s] ? 'used' : 'not used'})`);
}
const R = s => (params.r[s] == null ? Infinity : params.r[s]);

const report = { generatedAt: new Date().toISOString(), testSeasons: '2025/26 and 2026/27 to date', params, markets: {} };
for (const mk of MARKETS) {
  const k = params.k[mk.stat], rr = R(mk.stat);
  const res = { position: score(test, mk, k, rr, 'position'), player: score(test, mk, k, rr, 'player'), model: score(test, mk, k, rr, 'model') };
  // Calibration of the model on the test seasons.
  const bins = [];
  for (let lo = 0; lo < 1; lo += 0.1) {
    let n = 0, ps = 0, ys = 0;
    for (const r of test) {
      const q = prob(r, mk, k, rr, 'model');
      if (q == null || q < lo || q >= lo + 0.1) continue;
      n++; ps += q; ys += r.p[mk.stat] >= mk.atLeast ? 1 : 0;
    }
    if (n >= 50) bins.push({ bin: `${Math.round(lo * 100)}-${Math.round(lo * 100 + 10)}%`, n, predicted: +(ps / n).toFixed(3), actual: +(ys / n).toFixed(3) });
  }
  res.calibration = bins;
  report.markets[mk.key] = { label: mk.label, ...res };
  console.log(`${mk.label}: position ${res.position.logloss}, player ${res.player.logloss}, model ${res.model.logloss} (n=${res.model.n})`);
}
report.note = 'No historical bookmaker prices for player markets were available, so this tests accuracy and calibration only, not profit.';
mkdirSync(path.join(root, 'data/model'), { recursive: true });
writeFileSync(path.join(root, 'data/model/players.json'), JSON.stringify(report, null, 1) + '\n');
