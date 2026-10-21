#!/usr/bin/env node
// Fit the market/model blend weight on graded fixtures, with a chronological hold-out.
//
// Usage: node tools/fit-blend.mjs graded.json [--min 300] [--holdout 0.3] [--current 0.7]
//
// Input: a JSON array of graded fixtures, one per game, logged BEFORE kick-off:
//   { "id": "pl-ars-che", "kickoff": "2026-10-18T15:00:00+01:00",
//     "market":    { "h": 52, "d": 25, "a": 23 },   // margin-free market probabilities
//     "goalModel": { "h": 48, "d": 27, "a": 25 },   // the goal-rate model ALONE (the 30% part), not the blend
//     "result":    { "home": 2, "away": 1 } }
// Percentages or 0-1 probabilities both work; each triple is renormalised to sum to 1.
// Rows without both triples and a result are skipped and counted.
//
// The script never changes the app. It reports whether the hold-out supports a different
// weight; below --min graded games it refuses to recommend anything.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const file = args.find(a => !a.startsWith('--') && !/^\d/.test(a));
if (!file) {
  console.error('Usage: node tools/fit-blend.mjs graded.json [--min 300] [--holdout 0.3] [--current 0.7]');
  process.exit(2);
}
const MIN_GAMES = opt('--min', 300);
const HOLDOUT = opt('--holdout', 0.3);
const CURRENT_W = opt('--current', 0.7);
const BOOTSTRAPS = 2000;

function triple(t) {
  if (!t) return null;
  const v = [Number(t.h), Number(t.d), Number(t.a)];
  if (v.some(x => !Number.isFinite(x) || x < 0)) return null;
  const s = v[0] + v[1] + v[2];
  return s > 0 ? v.map(x => x / s) : null;
}

function outcome(r) {
  if (!r || !Number.isInteger(r.home) || !Number.isInteger(r.away)) return null;
  return r.home > r.away ? 0 : r.home === r.away ? 1 : 2;
}

// 3-way Brier: sum of squared errors over home/draw/away (know-nothing 1/3 each = 0.667).
function brier(p, o) {
  return p.reduce((s, x, i) => s + (x - (i === o ? 1 : 0)) ** 2, 0);
}
function logLoss(p, o) {
  return -Math.log(Math.max(p[o], 1e-12));
}
function blend(row, w) {
  return row.m.map((x, i) => w * x + (1 - w) * row.g[i]);
}
function mean(rows, w, score) {
  return rows.reduce((s, r) => s + score(blend(r, w), r.o), 0) / rows.length;
}
function bestWeight(rows) {
  let best = { w: 1, b: Infinity };
  for (let k = 0; k <= 100; k++) {
    const w = k / 100;
    const b = mean(rows, w, brier);
    if (b < best.b - 1e-12) best = { w, b };
  }
  return best;
}

// Seeded so repeated runs on the same file give the same interval.
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
// 95% bootstrap interval for mean Brier(wA) - Brier(wB); negative favours wA.
function diffInterval(rows, wA, wB) {
  const d = rows.map(r => brier(blend(r, wA), r.o) - brier(blend(r, wB), r.o));
  const rand = rng(12345);
  const means = [];
  for (let b = 0; b < BOOTSTRAPS; b++) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[Math.floor(rand() * d.length)];
    means.push(s / d.length);
  }
  means.sort((x, y) => x - y);
  return {
    mean: d.reduce((s, x) => s + x, 0) / d.length,
    lo: means[Math.floor(0.025 * BOOTSTRAPS)],
    hi: means[Math.floor(0.975 * BOOTSTRAPS)],
  };
}

const raw = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(raw)) throw new Error('Expected a JSON array of graded fixtures');

let skipped = 0;
const rows = [];
for (const r of raw) {
  const m = triple(r.market), g = triple(r.goalModel), o = outcome(r.result);
  const t = Date.parse(r.kickoff);
  if (!m || !g || o === null || !Number.isFinite(t)) { skipped++; continue; }
  rows.push({ id: r.id, t, m, g, o });
}
rows.sort((a, b) => a.t - b.t);

const f = x => x.toFixed(3);
console.log(`Graded games usable: ${rows.length} (skipped ${skipped} without market, goal-model and result)`);
if (rows.length === 0) process.exit(1);

console.log('\nWhole sample (in-sample, for description only):');
for (const [label, w] of [['market only', 1], [`current blend ${CURRENT_W}`, CURRENT_W], ['goal model only', 0]]) {
  console.log(`  ${label.padEnd(22)} Brier ${f(mean(rows, w, brier))}  log-loss ${f(mean(rows, w, logLoss))}`);
}
console.log(`  ${'know-nothing'.padEnd(22)} Brier 0.667`);

if (rows.length < MIN_GAMES) {
  console.log(`\nNOT ENOUGH DATA: ${rows.length} < ${MIN_GAMES} graded games. No weight change recommended.`);
  console.log('Keep logging every fixture before kick-off and re-run later.');
  process.exit(0);
}

const cut = Math.floor(rows.length * (1 - HOLDOUT));
const train = rows.slice(0, cut), test = rows.slice(cut);
const fit = bestWeight(train);
console.log(`\nFit on earliest ${train.length} games: best market weight ${fit.w.toFixed(2)} (train Brier ${f(fit.b)})`);
console.log(`Hold-out: latest ${test.length} games`);
for (const [label, w] of [['fitted', fit.w], [`current ${CURRENT_W}`, CURRENT_W], ['market only', 1]]) {
  console.log(`  ${label.padEnd(14)} w=${w.toFixed(2)}  Brier ${f(mean(test, w, brier))}  log-loss ${f(mean(test, w, logLoss))}`);
}

const vsCurrent = diffInterval(test, fit.w, CURRENT_W);
const vsMarket = diffInterval(test, CURRENT_W, 1);
console.log(`\nHold-out Brier difference, fitted minus current: ${f(vsCurrent.mean)} (95% CI ${f(vsCurrent.lo)} to ${f(vsCurrent.hi)})`);
console.log(`Hold-out Brier difference, current minus market: ${f(vsMarket.mean)} (95% CI ${f(vsMarket.lo)} to ${f(vsMarket.hi)})`);

if (vsMarket.lo > 0) {
  console.log('\nVerdict: the current blend is WORSE than the market alone on the hold-out. Consider weight 1.0 (market only).');
} else if (vsCurrent.hi < 0) {
  console.log(`\nVerdict: fitted weight ${fit.w.toFixed(2)} beats ${CURRENT_W} on the hold-out with an interval below zero. A change is supported.`);
} else {
  console.log(`\nVerdict: no clear hold-out gain over ${CURRENT_W}. Keep the current weight.`);
}
