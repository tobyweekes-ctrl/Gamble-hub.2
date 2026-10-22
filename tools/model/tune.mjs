#!/usr/bin/env node
// Chooses every model setting on the VALIDATION seasons (2023/24 and 2024/25)
// and writes tools/model/config.json. The test seasons (2025/26 onwards) are not
// touched here, so the backtest report on them is an honest out-of-sample test.
//
// 1. Component settings (time decay, between-season discount, shrinkage; Elo K,
//    home advantage, between-season carry) by 1X2 log-loss.
// 2. How to combine them: a fixed weighted average (then calibrated) or an
//    ordered-logistic stacker on the components' outputs. Chosen by two-fold
//    cross-validation across the two validation seasons.
//
// Usage: node tools/model/tune.mjs   (takes about 20-30 minutes)

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMatches } from './data.mjs';
import { weeks, rateComponent, eloComponent, probsFromL, outcome, logloss3 } from './walkforward.mjs';
import { fitOrdered, orderedProbs } from './models.mjs';
import { fitCalibration, calibrate1x2 } from './calibration.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const matches = loadMatches(path.join(root, 'data/raw'));
const testStart = Math.min(...matches.filter(m => m.season === '2526').map(m => m.date));
const wks = weeks(matches, '2324', testStart);
console.log(`Validation: ${wks.length} weeks, ${wks.reduce((s, w) => s + w.matches.length, 0)} matches (2023/24-2024/25)`);

const RHO = -0.05;
const meanLL = map => {
  let s = 0, n = 0;
  for (const [m, l] of map) { s += logloss3(l.h !== undefined ? l : probsFromL(l, RHO), outcome(m)); n++; }
  return { ll: s / n, n };
};

const GRID = {
  goals: { xi: [0.0015, 0.0025, 0.004], seasonDiscount: [1, 0.7, 0.5], sigma: 1.5 },
  shots: { xi: [0.0025, 0.004, 0.006], seasonDiscount: [1, 0.7, 0.5], sigma: 1.5 },
};
const best = {};
for (const [name, hKey, aKey, toGoals] of [['goals', 'hg', 'ag', false], ['shots', 'qh', 'qa', true]]) {
  let top = null;
  for (const xi of GRID[name].xi) {
    for (const seasonDiscount of GRID[name].seasonDiscount) {
      const sigma = GRID[name].sigma;
      const r = meanLL(rateComponent(matches, wks, { xi, sigma, seasonDiscount, hKey, aKey, toGoals }));
      console.log(`${name} xi=${xi} seasonDiscount=${seasonDiscount}: log-loss ${r.ll.toFixed(4)}`);
      if (!top || r.ll < top.ll) top = { xi, sigma, seasonDiscount, ll: r.ll };
    }
  }
  best[name] = top;
}
let topElo = null;
for (const k of [20, 30]) {
  for (const carry of [1, 0.8, 0.6]) {
    const r = meanLL(eloComponent(matches, wks, { k, hfa: 80, carry }));
    console.log(`elo k=${k} carry=${carry}: log-loss ${r.ll.toFixed(4)}`);
    if (!topElo || r.ll < topElo.ll) topElo = { k, hfa: 80, carry, ll: r.ll };
  }
}
best.elo = topElo;

// Validation predictions from the chosen components.
const pick = ({ ll, ...rest }) => rest;
const G = rateComponent(matches, wks, { ...pick(best.goals), hKey: 'hg', aKey: 'ag' });
const S = rateComponent(matches, wks, { ...pick(best.shots), hKey: 'qh', aKey: 'qa', toGoals: true });
const E = eloComponent(matches, wks, pick(best.elo));
const rows = [];
for (const [m, g] of G) {
  if (!S.has(m) || !E.has(m)) continue;
  const s = S.get(m), e = E.get(m);
  rows.push({
    m, season: m.season, o: outcome(m), g: probsFromL(g, RHO), s: probsFromL(s, RHO), e,
    x: stackFeatures(g, s, e),
  });
}
function stackFeatures(g, s, e) {
  return [Math.log(g.lh / g.la), Math.log(s.lh / s.la), e.x];
}

const linear = (r, w) => ({
  h: w.goals * r.g.h + w.shots * r.s.h + w.elo * r.e.h,
  d: w.goals * r.g.d + w.shots * r.s.d + w.elo * r.e.d,
  a: w.goals * r.g.a + w.shots * r.s.a + w.elo * r.e.a,
});
function fitLinear(train) {
  let top = null;
  for (let wg = 0; wg <= 1.0001; wg += 0.05) for (let ws = 0; ws <= 1.0001 - wg; ws += 0.05) {
    const w = { goals: +wg.toFixed(2), shots: +ws.toFixed(2), elo: +(1 - wg - ws).toFixed(2) };
    const ll = train.reduce((s, r) => s + logloss3(linear(r, w), r.o), 0) / train.length;
    if (!top || ll < top.ll) top = { w, ll };
  }
  const cal = fitCalibration(train.map(r => ({ p: { ...linear(r, top.w), btts: 0.5, o25: 0.5 }, m: r.m }))).x12;
  return { w: top.w, cal };
}
const linearProbs = (r, f) => { const p = linear(r, f.w); const q = calibrate1x2([p.h, p.d, p.a], f.cal); return { h: q[0], d: q[1], a: q[2] }; };
const stackProbs = (r, f) => { const q = orderedProbs(r.x, f); return { h: q[0], d: q[1], a: q[2] }; };

// Two-fold cross-validation across the two validation seasons.
const cv = { linear: [], stack: [] };
for (const [trainS, testS] of [['2324', '2425'], ['2425', '2324']]) {
  const tr = rows.filter(r => r.season === trainS), te = rows.filter(r => r.season === testS);
  const fl = fitLinear(tr), fs = fitOrdered(tr.map(r => ({ x: r.x, o: r.o })));
  cv.linear.push(te.reduce((s, r) => s + logloss3(linearProbs(r, fl), r.o), 0) / te.length);
  cv.stack.push(te.reduce((s, r) => s + logloss3(stackProbs(r, fs), r.o), 0) / te.length);
}
const cvMean = k => (cv[k][0] + cv[k][1]) / 2;
console.log(`Two-fold CV log-loss: linear ${cvMean('linear').toFixed(4)}, stacker ${cvMean('stack').toFixed(4)}`);
// The published model (ensemble.mjs, backtest.mjs) implements the weighted average.
// If the stacker ever wins the cross-validation, say so: it must be implemented in
// both before it can be used.
const method = 'linear';
if (cvMean('stack') < cvMean('linear')) console.log('NOTE: the stacker beat the weighted average in cross-validation; implement it in ensemble.mjs and backtest.mjs to use it.');
const finalLinear = fitLinear(rows);
const finalStack = fitOrdered(rows.map(r => ({ x: r.x, o: r.o })));
console.log('Chosen:', method, method === 'stack' ? JSON.stringify(finalStack) : JSON.stringify(finalLinear));

const config = {
  tunedOn: '2023/24 and 2024/25 seasons, walk-forward weekly refits, 1X2 log-loss; combination method by two-fold CV across those seasons',
  tunedAt: new Date().toISOString(),
  goals: pick(best.goals),
  shots: pick(best.shots),
  elo: pick(best.elo),
  method,
  weights: finalLinear.w,
  stacker: { features: ['log goals-model home/away expected goals', 'log shots-model home/away expected goals', 'Elo gap /100'], ...finalStack },
  validationLogLoss: { goals: best.goals.ll, shots: best.shots.ll, elo: best.elo.ll, cvLinear: cvMean('linear'), cvStack: cvMean('stack') },
};
writeFileSync(path.join(here, 'config.json'), JSON.stringify(config, null, 1) + '\n');
console.log('Wrote tools/model/config.json');
