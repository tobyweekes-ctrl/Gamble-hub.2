#!/usr/bin/env node
// Season simulator: plays out the rest of each league season many times with our
// model and writes data/model/season.json (embedded in the site by build-seed).
//
// - Current table: this season's results in data/raw (football-data.co.uk), plus
//   any finished BBC Sport results newer than that file.
// - Remaining fixtures: BBC Sport.
// - Each fixture's expected goals come from the fitted model (ensemble.mjs, no
//   lineups, no bookmaker input). Scores are drawn from Poisson distributions.
// - Uncertainty in team strength: in each simulated season every team gets one
//   random shift in strength, normal with sd TAU on the log scale, applied to its
//   goals for and (inversely) against. Without it, the model's ratings would be
//   treated as exactly right and the projections would be overconfident. TAU is a
//   judgement, not fitted.
// - Ties on points are split by goal difference, then goals scored.
//
// Usage: node tools/model/season-sim.mjs [--sims 10000]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMatches, LEAGUE_DIV, GROUPS, fdName } from './data.mjs';
import { buildState, predict, DEFAULT_CONFIG } from './ensemble.mjs';
import { bbcFixtures } from '../research/sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const SIMS = arg('--sims', 10000);
const TAU = 0.08;
const cfgPath = path.join(root, 'tools/model/config.json');
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : DEFAULT_CONFIG;

// Zones reported per league: [label, from position, to position].
const ZONES = {
  'Premier League': [['Title', 1, 1], ['Top 4', 1, 4], ['Down', 18, 20]],
  Championship: [['Title', 1, 1], ['Top 2', 1, 2], ['Top 6', 1, 6], ['Down', 22, 24]],
  Bundesliga: [['Title', 1, 1], ['Top 4', 1, 4], ['Bottom 3', 16, 18]],
  'Serie A': [['Title', 1, 1], ['Top 4', 1, 4], ['Down', 18, 20]],
  'Ligue 1': [['Title', 1, 1], ['Top 4', 1, 4], ['Bottom 3', 16, 18]],
};
// What each zone means, shown under the table.
const ZONE_NOTES = {
  'Premier League': 'Top 4: Champions League places. Down: bottom three, relegated.',
  Championship: 'Top 2: automatic promotion. Top 6: play-offs or better. Down: bottom three, relegated.',
  Bundesliga: 'Top 4: Champions League places. Bottom 3: 17th and 18th go down, 16th plays off.',
  'Serie A': 'Top 4: Champions League places. Down: bottom three, relegated.',
  'Ligue 1': 'Top 4: Champions League places. Bottom 3: 17th and 18th go down, 16th plays off.',
};

const matches = loadMatches(path.join(root, 'data/raw'));
const now = Date.now();
const state = buildState(matches, now, cfg);
const season = [...new Set(matches.map(m => m.season))].sort().pop();

// Seeded random numbers, so a rerun on the same data gives the same table.
let seed = 20261022;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const normal = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
function poisson(l) {
  const L = Math.exp(-l);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

const out = { generatedAt: new Date(now).toISOString(), sims: SIMS, tau: TAU, season, leagues: {}, warnings: [] };
for (const [league, div] of Object.entries(LEAGUE_DIV)) {
  const group = Object.keys(GROUPS).find(g => GROUPS[g].includes(div));
  const played = matches.filter(m => m.div === div && m.season === season);
  const teams = new Set(played.flatMap(m => [m.home, m.away]));
  const lastPlayed = Math.max(...played.map(m => m.date));
  const fromBBC = bbcFixtures(league, lastPlayed - 864e5, Date.UTC(2027, 6, 1));
  const toFd = n => fdName(n);
  const table = new Map([...teams].map(t => [t, { pts: 0, gd: 0, gf: 0, p: 0 }]));
  const add = (h, a, hg, ag) => {
    const H = table.get(h), A = table.get(a);
    H.p++; A.p++; H.gf += hg; A.gf += ag; H.gd += hg - ag; A.gd += ag - hg;
    if (hg > ag) H.pts += 3; else if (hg < ag) A.pts += 3; else { H.pts++; A.pts++; }
  };
  for (const m of played) add(m.home, m.away, m.hg, m.ag);
  const seen = new Set(played.map(m => `${m.home}|${m.away}`));
  const remaining = [];
  for (const f of fromBBC) {
    const h = toFd(f.home), a = toFd(f.away);
    if (!teams.has(h) || !teams.has(a)) { out.warnings.push(`${league}: ${f.home} v ${f.away} not matched to the results data`); continue; }
    if (seen.has(`${h}|${a}`)) continue;
    if (f.status === 'PostEvent' && f.hg != null) { add(h, a, f.hg, f.ag); seen.add(`${h}|${a}`); continue; }
    const p = predict(state, { group, div, home: h, away: a });
    if (!p) { out.warnings.push(`${league}: no model for ${f.home} v ${f.away}`); continue; }
    remaining.push({ h, a, lh: p.expH, la: p.expA });
    seen.add(`${h}|${a}`);
  }
  const names = [...teams];
  const idx = new Map(names.map((t, i) => [t, i]));
  const n = names.length;
  const posCount = names.map(() => new Float64Array(n + 1));
  const ptsSum = new Float64Array(n);
  const base = names.map(t => table.get(t));
  for (let s = 0; s < SIMS; s++) {
    const shift = names.map(() => normal() * TAU);
    const pts = base.map(b => b.pts), gd = base.map(b => b.gd), gf = base.map(b => b.gf);
    for (const r of remaining) {
      const i = idx.get(r.h), j = idx.get(r.a);
      const hg = poisson(r.lh * Math.exp(shift[i] - shift[j])), ag = poisson(r.la * Math.exp(shift[j] - shift[i]));
      gf[i] += hg; gf[j] += ag; gd[i] += hg - ag; gd[j] += ag - hg;
      if (hg > ag) pts[i] += 3; else if (hg < ag) pts[j] += 3; else { pts[i]++; pts[j]++; }
    }
    const order = names.map((_, i) => i).sort((x, y) => pts[y] - pts[x] || gd[y] - gd[x] || gf[y] - gf[x]);
    order.forEach((i, k) => { posCount[i][k + 1]++; });
    for (let i = 0; i < n; i++) ptsSum[i] += pts[i];
  }
  const rows = names.map((t, i) => {
    const zone = {};
    for (const [label, a, b] of ZONES[league]) {
      let c = 0;
      for (let k = a; k <= b; k++) c += posCount[i][k];
      zone[label] = +(c / SIMS * 100).toFixed(1);
    }
    const avgPos = posCount[i].reduce((s, c, k) => s + c * k, 0) / SIMS;
    return { team: t, played: base[i].p, points: base[i].pts, gd: base[i].gd, projectedPoints: +(ptsSum[i] / SIMS).toFixed(1), averagePosition: +avgPos.toFixed(1), zones: zone };
  }).sort((x, y) => y.projectedPoints - x.projectedPoints);
  out.leagues[league] = { remainingFixtures: remaining.length, zones: ZONES[league].map(z => z[0]), zoneNote: ZONE_NOTES[league], table: rows };
  console.log(`${league}: ${remaining.length} remaining fixtures simulated ${SIMS} times; top: ${rows.slice(0, 3).map(r => `${r.team} ${r.zones.Title}%`).join(', ')}`);
}
for (const w of out.warnings) console.warn('warning:', w);
mkdirSync(path.join(root, 'data/model'), { recursive: true });
writeFileSync(path.join(root, 'data/model/season.json'), JSON.stringify(out, null, 1) + '\n');
