#!/usr/bin/env node
// Chooses every model setting on the VALIDATION seasons (2023/24 and 2024/25)
// and writes tools/model/config.json. The test seasons (2025/26 onwards) are not
// touched here, so the backtest report on them is an honest out-of-sample test.
//
// Usage: node tools/model/tune.mjs   (takes several minutes)

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMatches } from './data.mjs';
import { weeks, rateComponent, eloComponent, probsFromL, outcome, logloss3 } from './walkforward.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const matches = loadMatches(path.join(root, 'data/raw'));
const testStart = Math.min(...matches.filter(m => m.season === '2526').map(m => m.date));
const wks = weeks(matches, '2324', testStart);
const evalN = wks.reduce((s, w) => s + w.matches.length, 0);
console.log(`Validation: ${wks.length} weeks, ${evalN} matches (2023/24-2024/25)`);

const RHO = -0.05;
const meanLL = map => {
  let s = 0, n = 0;
  for (const [m, l] of map) { s += logloss3(l.h !== undefined ? l : probsFromL(l, RHO), outcome(m)); n++; }
  return { ll: s / n, n };
};

const best = {};
const GRID = {
  goals: { xi: [0.0015, 0.0025, 0.004], sigma: [0.45, 0.6, 0.9, 1.5] },
  shots: { xi: [0.004, 0.006, 0.009, 0.013], sigma: [0.45, 0.6, 0.9, 1.5] },
};
for (const [name, hKey, aKey, toGoals] of [['goals', 'hg', 'ag', false], ['shots', 'hst', 'ast', true]]) {
  let top = null;
  for (const xi of GRID[name].xi) {
    for (const sigma of GRID[name].sigma) {
      const r = meanLL(rateComponent(matches, wks, { xi, sigma, hKey, aKey, toGoals }));
      console.log(`${name} xi=${xi} sigma=${sigma}: log-loss ${r.ll.toFixed(4)} (n=${r.n})`);
      if (!top || r.ll < top.ll) top = { xi, sigma, ll: r.ll };
    }
  }
  best[name] = top;
}
let topElo = null;
for (const k of [15, 20, 30]) {
  for (const hfa of [40, 60, 80]) {
    const r = meanLL(eloComponent(matches, wks, { k, hfa }));
    console.log(`elo k=${k} hfa=${hfa}: log-loss ${r.ll.toFixed(4)} (n=${r.n})`);
    if (!topElo || r.ll < topElo.ll) topElo = { k, hfa, ll: r.ll };
  }
}
best.elo = topElo;

// Ensemble weights on the same validation predictions.
const G = rateComponent(matches, wks, { xi: best.goals.xi, sigma: best.goals.sigma, hKey: 'hg', aKey: 'ag' });
const S = rateComponent(matches, wks, { xi: best.shots.xi, sigma: best.shots.sigma, hKey: 'hst', aKey: 'ast', toGoals: true });
const E = eloComponent(matches, wks, { k: best.elo.k, hfa: best.elo.hfa });
const rows = [];
for (const [m, l] of G) {
  if (!S.has(m) || !E.has(m)) continue;
  rows.push({ o: outcome(m), g: probsFromL(l, RHO), s: probsFromL(S.get(m), RHO), e: E.get(m) });
}
let topW = null;
for (let wg = 0; wg <= 1.0001; wg += 0.05) {
  for (let ws = 0; ws <= 1.0001 - wg; ws += 0.05) {
    const we = 1 - wg - ws;
    let s = 0;
    for (const r of rows) {
      const p = { h: wg * r.g.h + ws * r.s.h + we * r.e.h, d: wg * r.g.d + ws * r.s.d + we * r.e.d, a: wg * r.g.a + ws * r.s.a + we * r.e.a };
      s += logloss3(p, r.o);
    }
    const ll = s / rows.length;
    if (!topW || ll < topW.ll) topW = { goals: +wg.toFixed(2), shots: +ws.toFixed(2), elo: +we.toFixed(2), ll };
  }
}
console.log('Best:', JSON.stringify(best), 'weights', JSON.stringify(topW));

const config = {
  tunedOn: '2023/24 and 2024/25 seasons, walk-forward weekly refits, 1X2 log-loss',
  tunedAt: new Date().toISOString(),
  goals: { xi: best.goals.xi, sigma: best.goals.sigma },
  shots: { xi: best.shots.xi, sigma: best.shots.sigma },
  elo: { k: best.elo.k, hfa: best.elo.hfa },
  weights: { goals: topW.goals, shots: topW.shots, elo: topW.elo },
  validationLogLoss: { goals: best.goals.ll, shots: best.shots.ll, elo: best.elo.ll, ensemble: topW.ll },
  context: {},
};
writeFileSync(path.join(here, 'config.json'), JSON.stringify(config, null, 1) + '\n');
console.log('Wrote tools/model/config.json');
