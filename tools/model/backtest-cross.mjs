#!/usr/bin/env node
// Walk-forward test of the cross-league model (cross.mjs) on European club matches:
// refit every 14 days on everything before, predict the next 14 days' European games.
// Validation 2023/24 (rho and settings), test 2024/25, 2025/26 and 2026/27 so far.
// Baseline: the base rates of home win/draw/away win, BTTS and over 2.5 in European
// matches before each refit. No bookmaker prices are available for these games, so
// this shows whether the model knows anything, not whether it beats the market.
// Writes data/model/cross-backtest.json.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCross, fitCross, probsFor, fitRho, loadEspnShots, goalsPerSot, linkEspn } from './cross.mjs';
import { calibrate1x2, calibrate2 } from './calibration.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { rows, euro } = loadCross(root);
// Goals component settings, chosen on the validation season (22-23 Oct 2026 grid:
// xi 0.0007-0.0025, seasonDiscount 0.5-1, sigma 0.3-1.5).
const cfg = { xi: +(process.env.XI || 0.001), sigma: +(process.env.SIGMA || 0.4), seasonDiscount: +(process.env.SD || 1) };
// Shots component (ESPN team shots on target), its own settings.
const shotsCfg = { xi: +(process.env.SXI || 0.002), sigma: +(process.env.SSIGMA || 0.4), seasonDiscount: +(process.env.SSD || 0.7), hKey: 'hst', aKey: 'ast' };
const S = process.env.NOSHOTS ? null : loadEspnShots(root);
const link = S ? linkEspn(euro, S.eur) : new Map();
const STEP = 14 * 864e5;
const done = euro.filter(m => m.hg != null);
const start = Date.parse('2023-07-01'), end = Date.now();
const preds = [];
for (let t = start; t < end; t += STEP) {
  const next = done.filter(m => m.date >= t && m.date < t + STEP);
  if (!next.length) continue;
  const model = fitCross(rows, euro, { asOf: t, ...cfg });
  const shots = S ? fitCross(S.dom, S.eur, { asOf: t, ...shotsCfg }) : null, conv = S ? goalsPerSot(S.eur, t) : null;
  const past = done.filter(m => m.date < t);
  const base = { h: 0, d: 0, a: 0, btts: 0, o25: 0 };
  for (const m of past) { base[m.hg > m.ag ? 'h' : m.hg === m.ag ? 'd' : 'a']++; base.btts += m.hg > 0 && m.ag > 0; base.o25 += m.hg + m.ag > 2; }
  for (const k in base) base[k] /= past.length;
  for (const m of next) {
    const e = model.expected(m.home, m.away, m.neutral);
    if (!e) continue;
    const th = model.team(m.home), ta = model.team(m.away);
    // Shots expectation when both clubs are linked to ESPN and rated there.
    const hid = link.get(m.home), aid = link.get(m.away);
    const se = shots && conv && hid && aid ? shots.expected(hid, aid, m.neutral) : null;
    preds.push({ m, lh: e.h, la: e.a, slh: se ? se.h * conv : null, sla: se ? se.a * conv : null, base, season: m.season, euroOnly: th.group.startsWith('U-') || ta.group.startsWith('U-') });
  }
}
const val = preds.filter(p => p.season === '2324');
const rho = fitRho(val.map(p => ({ lh: p.lh, la: p.la, hg: p.m.hg, ag: p.m.ag, w: 1 })));
// Calibration, fitted on the validation season only (wider ranges than the domestic
// fit: this model is overconfident rather than cautious).
// Goals and shots components blended (weight W on goals, chosen on validation);
// goals only when a club has no shots rating.
const mix = (p, w) => {
  const g = probsFor(p.lh, p.la, rho);
  if (p.slh == null || w >= 1) return g;
  const s = probsFor(p.slh, p.sla, rho);
  const out = {};
  for (const k of ['h', 'd', 'a', 'btts', 'o25']) out[k] = w * g[k] + (1 - w) * s[k];
  out.grid = g.grid.map((row, x) => row.map((v, y) => w * v + (1 - w) * s.grid[x][y]));
  return out;
};
const outcome0 = m => (m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2);
let W = 1;
if (process.env.W != null) W = +process.env.W;
else {
  let best = null;
  for (let w = 0; w <= 1.0001; w += 0.1) {
    let ll = 0;
    for (const p of val) { const q = mix(p, w); ll -= Math.log([q.h, q.d, q.a][outcome0(p.m)]); }
    if (!best || ll < best.ll) best = { w: +w.toFixed(1), ll };
  }
  W = best.w;
}
const raw = p => mix(p, W);
const outcome = m => (m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2);
let x12 = null;
const valP = val.map(p => ({ q: raw(p), m: p.m }));
for (let T = 0.5; T <= 1.3001; T += 0.02) for (let kd = 0.8; kd <= 1.3001; kd += 0.02) {
  let ll = 0;
  for (const r of valP) ll -= Math.log(calibrate1x2([r.q.h, r.q.d, r.q.a], { T, kd })[outcome(r.m)]);
  if (!x12 || ll < x12.ll) x12 = { T: +T.toFixed(2), kd: +kd.toFixed(2), ll };
}
const two = (get, won) => {
  let best = null;
  for (let a = -0.5; a <= 0.5001; a += 0.02) for (let b = 0; b <= 1.5001; b += 0.02) {
    let ll = 0;
    for (const r of valP) { const q = calibrate2(get(r.q), { a, b }); ll -= Math.log(won(r.m) ? q : 1 - q); }
    if (!best || ll < best.ll) best = { a: +a.toFixed(2), b: +b.toFixed(2), ll };
  }
  return { a: best.a, b: best.b };
};
const calib = { x12: { T: x12.T, kd: x12.kd }, btts: two(q => q.btts, m => m.hg > 0 && m.ag > 0), o25: two(q => q.o25, m => m.hg + m.ag > 2) };
export const calibrated = (p, c = calib) => {
  const q = raw(p), x = calibrate1x2([q.h, q.d, q.a], c.x12);
  return { h: x[0], d: x[1], a: x[2], btts: calibrate2(q.btts, c.btts), o25: calibrate2(q.o25, c.o25) };
};
const score = list => {
  let ll = 0, br = 0, llb = 0, brb = 0, bt = 0, btb = 0, ou = 0, oub = 0;
  const bins = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const p of list) {
    const q = calibrated(p), y = p.m.hg > p.m.ag ? 0 : p.m.hg === p.m.ag ? 1 : 2;
    const P = [q.h, q.d, q.a], B = [p.base.h, p.base.d, p.base.a];
    ll -= Math.log(P[y]); llb -= Math.log(B[y]);
    br += P.reduce((s, x, i) => s + (x - (i === y)) ** 2, 0); brb += B.reduce((s, x, i) => s + (x - (i === y)) ** 2, 0);
    const yb = p.m.hg > 0 && p.m.ag > 0, yo = p.m.hg + p.m.ag > 2;
    bt -= Math.log(yb ? q.btts : 1 - q.btts); btb -= Math.log(yb ? p.base.btts : 1 - p.base.btts);
    ou -= Math.log(yo ? q.o25 : 1 - q.o25); oub -= Math.log(yo ? p.base.o25 : 1 - p.base.o25);
    const b = bins[Math.min(9, Math.floor(q.h * 10))]; b.p += q.h; b.y += y === 0; b.n++;
  }
  const n = list.length, r = x => +(x / n).toFixed(4);
  return { n, x12: { logloss: r(ll), baseLogloss: r(llb), brier: r(br), baseBrier: r(brb) }, btts: { logloss: r(bt), base: r(btb) }, o25: { logloss: r(ou), base: r(oub) },
    homeWinCalibration: bins.filter(b => b.n >= 10).map(b => ({ predicted: +(b.p / b.n * 100).toFixed(1), actual: +(b.y / b.n * 100).toFixed(1), n: b.n })) };
};
const test = preds.filter(p => p.season !== '2324');
const out = {
  generatedAt: new Date().toISOString(), settings: cfg, shotsSettings: S ? shotsCfg : null, goalsWeight: W,
  shotsCoverage: { validation: +(val.filter(p => p.slh != null).length / val.length).toFixed(3), test: +(preds.filter(p => p.season !== '2324' && p.slh != null).length / Math.max(1, preds.filter(p => p.season !== '2324').length)).toFixed(3) },
  rho, calibration: calib,
  validation: { seasons: ['2023/24'], ...score(val) },
  test: { seasons: ['2024/25', '2025/26', '2026/27 so far'], ...score(test) },
  testTeamsRatedFromEuropeOnly: score(test.filter(p => p.euroOnly)),
  testBothWithDomesticData: score(test.filter(p => !p.euroOnly)),
};
if (!process.env.NOWRITE) writeFileSync(path.join(root, 'data/model/cross-backtest.json'), JSON.stringify(out, null, 1) + '\n');
console.log('goals weight', W, 'shots coverage', JSON.stringify(out.shotsCoverage), 'linked clubs', link.size);
console.log(JSON.stringify({ rho, calib, val: out.validation.x12, test: out.test.x12, btts: out.test.btts, o25: out.test.o25, euroOnly: out.testTeamsRatedFromEuropeOnly.x12, nEuroOnly: out.testTeamsRatedFromEuropeOnly.n, domestic: out.testBothWithDomesticData.x12 }, null, 1));
console.log('calibration (test):', JSON.stringify(out.test.homeWinCalibration));
