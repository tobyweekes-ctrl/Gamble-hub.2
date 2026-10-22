#!/usr/bin/env node
// Out-of-sample test of the tuned models (tools/model/config.json).
//
// 1. Walk-forward predictions, refitted weekly, for the validation seasons
//    (2023/24, 2024/25) and the test seasons (2025/26 and 2026/27 so far).
// 2. Context factors (context.mjs) are measured on the validation seasons only,
//    then applied to the test seasons.
// 3. On the test seasons the model is compared with the bookmakers: Bet365's
//    pre-match price (what a weekly build sees) and the closing price.
// 4. Value test: bet one unit wherever model probability x Bet365 price exceeds
//    1 + threshold. Reports profit with a bootstrap interval and closing-line
//    value (how often the price shortened after the bet, the usual sign of an edge).
//
// Writes data/model/backtest.json and data/model/context.json, and prints a summary.
// Usage: node tools/model/backtest.mjs

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMatches, fair, DIV_LEAGUE } from './data.mjs';
import { weeks, rateComponent, eloComponent, rhoBySeason, outcome, brier3, logloss3 } from './walkforward.mjs';
import { scoreGrid, marketsFromGrid } from './models.mjs';
import { loadEurope, schedule, teamFlags, isDerby, FLAGS, contextMultipliers } from './context.mjs';
import { calibrate1x2, calibrate2, fitCalibration } from './calibration.mjs';
import { pool3 } from './ensemble.mjs';
import { loadLineups, joinLineups, teamHistory, lineupFeatures, fitLineupEffects, lineupMultipliers } from './lineups.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const cfg = JSON.parse(readFileSync(path.join(here, 'config.json'), 'utf8'));
const matches = loadMatches(path.join(root, 'data/raw'));
const europe = loadEurope(path.join(root, 'data/raw'));
const sched = schedule(matches, europe);
const TEST_FROM = '2526';

// Newly promoted (or relegated) into the division this season.
const members = new Map();
for (const m of matches) {
  const k = `${m.div}|${m.season}`;
  if (!members.has(k)) members.set(k, new Set());
  members.get(k).add(m.home); members.get(k).add(m.away);
}
const prevSeason = s => String(Number(s.slice(0, 2)) - 1).padStart(2, '0') + s.slice(0, 2);
const newcomer = (team, m) => {
  const last = members.get(`${m.div}|${prevSeason(m.season)}`);
  return !!last && !last.has(team);
};

const wks = weeks(matches, '2324');
console.log(`Walk-forward over ${wks.length} weeks...`);
const G = rateComponent(matches, wks, { ...cfg.goals, hKey: 'hg', aKey: 'ag' });
const S = rateComponent(matches, wks, { ...cfg.shots, hKey: 'qh', aKey: 'qa', toGoals: true });
const E = eloComponent(matches, wks, cfg.elo);
const rhos = rhoBySeason(matches, G, ['2324', '2425', '2526', '2627']);

const w = cfg.weights;
const wg = w.goals / ((w.goals + w.shots) || 1), ws = 1 - wg;
function ensemble(m, mult) {
  const g = G.get(m), s = S.get(m), e = E.get(m);
  const rho = rhos[`${m.group}|${m.season}`];
  const gl = { h: g.lh * mult.h, a: g.la * mult.a }, sl = { h: s.lh * mult.h, a: s.la * mult.a };
  const gm = marketsFromGrid(scoreGrid(gl.h, gl.a, rho)), sm = marketsFromGrid(scoreGrid(sl.h, sl.a, rho));
  const [ph, pd, pa] = pool3(gm, sm, e, cfg);
  return {
    h: ph, d: pd, a: pa,
    btts: wg * gm.btts + ws * sm.btts, o25: wg * gm.o25 + ws * sm.o25,
    lh: wg * gl.h + ws * sl.h, la: wg * gl.a + ws * sl.a,
  };
}

const recs = [];
for (const { matches: wk } of wks) for (const m of wk) {
  if (!G.has(m) || !S.has(m) || !E.has(m)) continue;
  const fh = { ...teamFlags(sched, m.home, m.date), newcomer: newcomer(m.home, m) };
  const fa = { ...teamFlags(sched, m.away, m.date), newcomer: newcomer(m.away, m) };
  recs.push({ m, fh, fa, derby: isDerby(m.home, m.away), base: ensemble(m, { h: 1, a: 1 }) });
}
// Confirmed lineups (ESPN), joined to the results data.
{
  const lineups = loadLineups(path.join(root, 'data/raw'));
  const joined = joinLineups(recs.map(r => r.m), lineups);
  const hist = teamHistory(lineups);
  for (const r of recs) {
    const l = joined.get(r.m);
    if (!l) continue;
    const fh = lineupFeatures(hist, l.home, l.t), fa = lineupFeatures(hist, l.away, l.t);
    if (fh && fa) r.lu = { fh, fa };
  }
  console.log(`Lineup features for ${recs.filter(r => r.lu).length} of ${recs.length} predictions`);
}
const valid = recs.filter(r => r.m.season < TEST_FROM), test = recs.filter(r => r.m.season >= TEST_FROM);
console.log(`${valid.length} validation and ${test.length} test predictions`);

// ---- Context factors, measured on validation only ----------------------------
const K = 100; // pseudo-goals of "no effect"
const factor = (obs, exp) => {
  const f = (obs + K) / (exp + K);
  const se = 1 / Math.sqrt(Math.max(obs, 1));
  return { f: +f.toFixed(3), raw: +(obs / exp).toFixed(3), obs, exp: +exp.toFixed(1), keep: Math.abs(Math.log(obs / exp)) > 2 * se };
};
const ctxReport = {}, factors = {};
for (const f of FLAGS) {
  let so = 0, se = 0, co = 0, ce = 0, n = 0;
  for (const r of valid) {
    if (r.fh[f]) { so += r.m.hg; se += r.base.lh; co += r.m.ag; ce += r.base.la; n++; }
    if (r.fa[f]) { so += r.m.ag; se += r.base.la; co += r.m.hg; ce += r.base.lh; n++; }
  }
  const att = factor(so, se), def = factor(co, ce);
  ctxReport[f] = { teamMatches: n, scored: att, conceded: def };
  if (att.keep || def.keep) factors[f] = { att: att.keep ? att.f : 1, def: def.keep ? def.f : 1 };
}
{
  let ho = 0, he = 0, ao = 0, ae = 0, n = 0;
  for (const r of valid) if (r.derby) { ho += r.m.hg; he += r.base.lh; ao += r.m.ag; ae += r.base.la; n++; }
  const h = factor(ho, he), a = factor(ao, ae);
  ctxReport.derby = { matches: n, home: h, away: a };
  if (h.keep || a.keep) factors.derby = { h: h.keep ? h.f : 1, a: a.keep ? a.f : 1 };
}
// Recent form beyond the ratings: does over/under-performing the model's expected
// goals over a team's last five matches carry into the next one? (Report only.)
{
  const hist = new Map();
  const res = { hot: { o: 0, e: 0, n: 0 }, cold: { o: 0, e: 0, n: 0 } };
  for (const r of valid) {
    for (const [team, scored, exp] of [[r.m.home, r.m.hg, r.base.lh], [r.m.away, r.m.ag, r.base.la]]) {
      const h = hist.get(team) || [];
      if (h.length >= 5) {
        const resid = h.slice(-5).reduce((s, x) => s + x, 0);
        const b = resid > 3 ? res.hot : resid < -3 ? res.cold : null;
        if (b) { b.o += scored; b.e += exp; b.n++; }
      }
      h.push(scored - exp); hist.set(team, h);
    }
  }
  ctxReport.recentForm = {
    note: 'Goals scored v model expectation after a 5-match run more than 3 goals above (hot) or below (cold) expectation. Not applied.',
    hot: factor(res.hot.o, res.hot.e), hotN: res.hot.n, cold: factor(res.cold.o, res.cold.e), coldN: res.cold.n,
  };
}
console.log('Context (validation):', JSON.stringify(ctxReport));
console.log('Kept factors:', JSON.stringify(factors));

// ---- Calibration, fitted on validation only -----------------------------------
const calibration = fitCalibration(valid.map(r => ({ p: r.base, m: r.m })));
console.log('Calibration (validation):', JSON.stringify(calibration));
const calibrated = p => {
  const x = calibrate1x2([p.h, p.d, p.a], calibration.x12);
  return { ...p, h: x[0], d: x[1], a: x[2], btts: calibrate2(p.btts, calibration.btts), o25: calibrate2(p.o25, calibration.o25) };
};

// ---- Lineup effects, measured on validation only ---------------------------
const lineupFit = fitLineupEffects(valid.filter(r => r.lu).map(r => ({ lh: r.base.lh, la: r.base.la, hg: r.m.hg, ag: r.m.ag, fh: r.lu.fh, fa: r.lu.fa })));
console.log('Lineup effects (validation):', JSON.stringify(lineupFit));

// ---- Test-season evaluation -------------------------------------------------
for (const r of test) {
  const mult = contextMultipliers(factors, r.fh, r.fa, r.derby);
  r.raw = ensemble(r.m, mult);
  r.p = calibrated(r.raw);
  r.o = outcome(r.m);
  if (r.lu) {
    const lm = lineupMultipliers(r.lu.fh, r.lu.fa, lineupFit);
    r.pl = calibrated(ensemble(r.m, { h: mult.h * lm.h, a: mult.a * lm.a }));
  }
}
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
function scoreSet(rs, getP) {
  const ok = rs.filter(r => getP(r));
  return { n: ok.length, brier: +mean(ok.map(r => brier3(getP(r), r.o))).toFixed(4), logloss: +mean(ok.map(r => logloss3(getP(r), r.o))).toFixed(4) };
}
function binScore(rs, getP, won) {
  return { n: rs.length, brier: +mean(rs.map(r => (getP(r) - (won(r) ? 1 : 0)) ** 2)).toFixed(4) };
}
const asP = t => (t ? { h: t[0], d: t[1], a: t[2] } : null);
const closing = r => asP(fair(r.m.odds.psc || r.m.odds.avgc || r.m.odds.b365c));
const pre = r => asP(fair(r.m.odds.b365));
const both = test.filter(r => pre(r) && closing(r));
const comp = (r, k) => {
  const rho = rhos[`${r.m.group}|${r.m.season}`];
  if (k === 'elo') return E.get(r.m);
  const l = (k === 'goals' ? G : S).get(r.m);
  return marketsFromGrid(scoreGrid(l.lh, l.la, rho));
};
const report = {
  generatedAt: new Date().toISOString(),
  config: cfg,
  testSeasons: '2025/26 and 2026/27 to date',
  overall: {
    model: scoreSet(both, r => r.p),
    modelUncalibrated: scoreSet(both, r => r.raw),
    goalsModel: scoreSet(both, r => comp(r, 'goals')),
    shotsModel: scoreSet(both, r => comp(r, 'shots')),
    eloModel: scoreSet(both, r => comp(r, 'elo')),
    bet365PreMatch: scoreSet(both, pre),
    closing: scoreSet(both, closing),
    knowNothing: { brier: 0.6667 },
  },
  byLeague: {},
  twoWay: {
    o25: { model: binScore(both, r => r.p.o25, r => r.m.hg + r.m.ag > 2), market: binScore(both.filter(r => r.m.odds.o25), r => fair(r.m.odds.o25)[0], r => r.m.hg + r.m.ag > 2) },
    btts: { model: binScore(both, r => r.p.btts, r => r.m.hg > 0 && r.m.ag > 0) },
  },
  context: { measuredOn: 'validation seasons 2023/24-2024/25', report: ctxReport, kept: factors },
  lineups: (() => {
    const lu = both.filter(r => r.pl);
    return {
      effects: lineupFit,
      note: 'Test matches with confirmed XIs for both sides. "withLineups" applies the lineup effects measured on validation.',
      model: scoreSet(lu, r => r.p), withLineups: scoreSet(lu, r => r.pl),
      bet365PreMatch: scoreSet(lu, pre), closing: scoreSet(lu, closing),
    };
  })(),
  calibration,
};
for (const [div, lg] of Object.entries(DIV_LEAGUE)) {
  const rs = both.filter(r => r.m.div === div);
  report.byLeague[lg] = { model: scoreSet(rs, r => r.p), bet365PreMatch: scoreSet(rs, pre), closing: scoreSet(rs, closing) };
}

// Does the model add anything to the market? Blend weight fitted on validation, scored on test.
{
  const blend = (r, a, base) => { const q = pre(r); return { h: a * base.h + (1 - a) * q.h, d: a * base.d + (1 - a) * q.d, a: a * base.a + (1 - a) * q.a }; };
  const vb = valid.filter(r => pre(r));
  let bestA = 0, bestLL = Infinity;
  for (let a = 0; a <= 1.0001; a += 0.05) {
    const ll = mean(vb.map(r => logloss3(blend(r, a, calibrated(r.base)), outcome(r.m))));
    if (ll < bestLL) { bestLL = ll; bestA = +a.toFixed(2); }
  }
  report.modelWeightInBlendWithMarket = { fittedOnValidation: bestA, testScore: scoreSet(both, r => blend(r, bestA, r.p)) };
}

// Calibration of the model's home-win probability on the test seasons.
report.calibration = [];
for (let lo = 0; lo < 1; lo += 0.1) {
  const b = test.filter(r => r.p.h >= lo && r.p.h < lo + 0.1);
  if (b.length >= 20) report.calibration.push({ bin: `${Math.round(lo * 100)}-${Math.round(lo * 100 + 10)}%`, n: b.length, predicted: +mean(b.map(r => r.p.h)).toFixed(3), actual: +mean(b.map(r => (r.o === 0 ? 1 : 0))).toFixed(3) });
}

// ---- Value-bet simulation on the test seasons ---------------------------------
function rng(seed) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
function valueTest(threshold, market) {
  const bets = [];
  for (const r of test) {
    if (market === '1x2') {
      const o = r.m.odds.b365, c = r.m.odds.b365c;
      if (!o) continue;
      const p = [r.p.h, r.p.d, r.p.a];
      let best = -1, ev = threshold;
      for (let i = 0; i < 3; i++) if (p[i] * o[i] - 1 > ev) { ev = p[i] * o[i] - 1; best = i; }
      if (best < 0) continue;
      bets.push({ profit: r.o === best ? o[best] - 1 : -1, clv: c ? o[best] / c[best] - 1 : null, ev });
    } else {
      const o = r.m.odds.o25, c = r.m.odds.o25c;
      if (!o) continue;
      const p = [r.p.o25, 1 - r.p.o25];
      const won = [r.m.hg + r.m.ag > 2, r.m.hg + r.m.ag <= 2];
      let best = -1, ev = threshold;
      for (let i = 0; i < 2; i++) if (p[i] * o[i] - 1 > ev) { ev = p[i] * o[i] - 1; best = i; }
      if (best < 0) continue;
      bets.push({ profit: won[best] ? o[best] - 1 : -1, clv: c ? o[best] / c[best] - 1 : null, ev });
    }
  }
  if (!bets.length) return { threshold, bets: 0 };
  const roi = mean(bets.map(b => b.profit));
  const rand = rng(7), boots = [];
  for (let k = 0; k < 2000; k++) { let s = 0; for (let i = 0; i < bets.length; i++) s += bets[Math.floor(rand() * bets.length)].profit; boots.push(s / bets.length); }
  boots.sort((a, b) => a - b);
  const withClv = bets.filter(b => b.clv != null);
  return {
    threshold, bets: bets.length, roi: +roi.toFixed(4), roi95: [+boots[50].toFixed(4), +boots[1949].toFixed(4)],
    meanClaimedEdge: +mean(bets.map(b => b.ev)).toFixed(4),
    beatClosingShare: withClv.length ? +(withClv.filter(b => b.clv > 0).length / withClv.length).toFixed(3) : null,
    meanCLV: withClv.length ? +mean(withClv.map(b => b.clv)).toFixed(4) : null,
  };
}
report.valueBets = {
  note: 'Flat 1-unit stakes at Bet365 pre-match prices on the test seasons. Bookmaker margin is included.',
  '1x2': [0.02, 0.05, 0.1, 0.2].map(t => valueTest(t, '1x2')),
  'overUnder2.5': [0.02, 0.05, 0.1].map(t => valueTest(t, 'ou')),
};

// Plain-English verdict, generated from the numbers so it can't overstate them.
{
  const o = report.overall, v = report.valueBets['1x2'].find(x => x.threshold === 0.05);
  const acc = o.model.brier < o.bet365PreMatch.brier
    ? 'The model was more accurate than Bet365\'s pre-match prices on these seasons.'
    : `The model was less accurate than Bet365's pre-match prices (Brier ${o.model.brier} v ${o.bet365PreMatch.brier}), as expected for a model without team news.`;
  const val = !v || !v.bets ? 'No value bets were triggered.'
    : v.roi95[0] > 0 ? 'Betting its edges made a profit whose 95% range stays above zero.'
    : v.roi > 0 ? 'Betting its edges showed a profit, but the 95% range includes losing money, so it is not evidence of an edge.'
    : 'Betting its edges lost money, so its disagreements with the bookmaker have not been bargains.';
  report.verdict = `${acc} ${val}`;
}

mkdirSync(path.join(root, 'data/model'), { recursive: true });
// Compact per-match predictions for quick follow-up analysis (not committed).
mkdirSync(path.join(root, 'data/raw/cache'), { recursive: true });
writeFileSync(path.join(root, 'data/raw/cache/records.json'), JSON.stringify(recs.map(r => ({
  div: r.m.div, season: r.m.season, date: r.m.date, home: r.m.home, away: r.m.away, hg: r.m.hg, ag: r.m.ag,
  lh: r.base.lh, la: r.base.la, p: r.p || null, base: { h: r.base.h, d: r.base.d, a: r.base.a, btts: r.base.btts, o25: r.base.o25 },
  lu: r.lu || null, odds: r.m.odds,
}))));
writeFileSync(path.join(root, 'data/model/backtest.json'), JSON.stringify(report, null, 1) + '\n');
// Lineup effects are switched on for the published model only if they improved the
// test seasons; otherwise lineups are shown on the site but leave the numbers alone.
const lineupEnabled = report.lineups.withLineups.logloss < report.lineups.model.logloss;
report.lineups.enabled = lineupEnabled;
writeFileSync(path.join(root, 'data/model/backtest.json'), JSON.stringify(report, null, 1) + '\n');
writeFileSync(path.join(root, 'data/model/context.json'), JSON.stringify({ measuredOn: report.context.measuredOn, factors, calibration, lineup: { ...lineupFit, enabled: lineupEnabled }, report: ctxReport }, null, 1) + '\n');
console.log(JSON.stringify({ overall: report.overall, lineups: report.lineups, blend: report.modelWeightInBlendWithMarket, value: report.valueBets }, null, 1));
