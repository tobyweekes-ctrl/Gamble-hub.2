// Runs the independent model for a round's fixtures (used by tools/build-seed.mjs).
// Fits on every result in data/raw/ played before the build, applies the context
// factors measured by the backtest, and returns per-fixture numbers for the app.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadMatches, LEAGUE_DIV, GROUPS, fdName } from './data.mjs';
import { buildState, predict, DEFAULT_CONFIG } from './ensemble.mjs';
import { fitRatings, marketsFromGrid } from './models.mjs';
import { calibrate1x2, calibrate2 } from './calibration.mjs';
import { lineupMultipliers, loadLineups } from './lineups.mjs';
import { playerTable, playerProps, groupOf, MARKETS } from './players.mjs';
import { loadEurope, schedule, teamFlags, isDerby, contextMultipliers, FLAGS } from './context.mjs';
import { loadCross, fitCross, probsFor, DIV_NAME } from './cross.mjs';

const DAY = 864e5;
const FLAG_TEXT = {
  shortRest: 'played within the last 3 days',
  europeBefore: 'played a European game in the previous 4 days',
  europeAfter: 'has a European game in the next 4 days (rotation risk)',
  newcomer: 'is new to this division this season',
};

export function modelForRound(root, fixtures) {
  const raw = path.join(root, 'data/raw');
  const warnings = [];
  if (!existsSync(raw)) return { byId: {}, info: {}, warnings: ['data/raw missing: run tools/model/fetch.sh; no model numbers built'], asOfLabel: '' };
  const cfgPath = path.join(root, 'tools/model/config.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : DEFAULT_CONFIG;
  if (!existsSync(cfgPath)) warnings.push('tools/model/config.json missing: using untuned defaults');
  const ctxPath = path.join(root, 'data/model/context.json');
  const ctxFile = existsSync(ctxPath) ? JSON.parse(readFileSync(ctxPath, 'utf8')) : {};
  const factors = ctxFile.factors || {};
  const calib = ctxFile.calibration || null;
  const lineupFit = ctxFile.lineup && ctxFile.lineup.enabled ? ctxFile.lineup : null;
  if (!calib) warnings.push('no calibration in data/model/context.json: run tools/model/backtest.mjs');
  const btPath = path.join(root, 'data/model/backtest.json');
  const bt = existsSync(btPath) ? JSON.parse(readFileSync(btPath, 'utf8')) : null;

  const matches = loadMatches(raw);
  const now = Date.now();
  const asOf = Math.min(now, ...fixtures.map(f => Date.parse(f.kickoff)));
  const state = buildState(matches, asOf, cfg);
  const europe = loadEurope(raw);
  const divOf = f => LEAGUE_DIV[f.league];
  const upcoming = fixtures.filter(divOf).map(f => ({ home: fdName(f.home), away: fdName(f.away), date: Date.parse(f.kickoff) }));
  const sched = schedule(matches.filter(m => m.date < asOf), europe, upcoming);

  // Division membership by season, for the "new to this division" flag.
  const seasons = [...new Set(matches.map(m => m.season))].sort();
  const cur = seasons[seasons.length - 1], prev = seasons[seasons.length - 2];
  const members = (div, season) => new Set(matches.filter(m => m.div === div && m.season === season).flatMap(m => [m.home, m.away]));

  // Match-stat models (shots, shots on target, corners, cards, fouls): the same
  // attack/defence rating model on counts. Settings are not tuned and there are no
  // bookmaker prices to compare against yet, so the app shows them as expectations only.
  const STAT_KEYS = { shots: ['hs', 'as'], shotsOnTarget: ['hst', 'ast'], corners: ['hc', 'ac'], cards: ['hy', 'ay'], fouls: ['hf', 'af'] };
  const statModels = {};
  for (const g of Object.keys(GROUPS)) {
    const gm = matches.filter(m => m.group === g && m.date < asOf && asOf - m.date < 1500 * DAY);
    statModels[g] = Object.fromEntries(Object.entries(STAT_KEYS).map(([k, [hk, ak]]) =>
      [k, fitRatings(gm.filter(m => m[hk] != null && m[ak] != null), { asOf, xi: 0.004, sigma: 0.6, hKey: hk, aKey: ak })]));
  }

  // Player markets (players.mjs), with the parameters the player backtest fitted.
  const plPath = path.join(root, 'data/model/players.json');
  const plReport = existsSync(plPath) ? JSON.parse(readFileSync(plPath, 'utf8')) : null;
  const plParams = plReport && {
    k: plReport.params.k,
    r: Object.fromEntries(Object.entries(plReport.params.r).map(([s, v]) => [s, v == null ? Infinity : v])),
    context: plReport.params.context || {},
  };
  const plTable = plParams ? playerTable(loadLineups(raw), asOf) : null;
  const teamAvg = (team, hk, ak) => {
    let s = 0, n = 0;
    for (const m of matches) {
      if (m.date >= asOf || asOf - m.date > 365 * DAY || m[hk] == null) continue;
      if (m.home === team) { s += m[hk]; n++; } else if (m.away === team) { s += m[ak]; n++; }
    }
    return n >= 5 ? s / n : null;
  };
  function playerMarkets(f, group, div, home, away) {
    const xi = f.lineups ? { status: 'confirmed', h: f.lineups.home.starters, a: f.lineups.away.starters, hx: f.lineups.home.bench, ax: f.lineups.away.bench }
      : f.probableXI ? { status: 'probable', h: f.probableXI.home, a: f.probableXI.away, hx: f.probableXI.homeExtra, ax: f.probableXI.awayExtra } : null;
    if (!plParams || !xi || !xi.h || !xi.a) return null;
    const es = statModels[group].shots.expected(div, home, away), ef = statModels[group].fouls.expected(div, home, away);
    const ratio = (e, a) => (e && a ? e / a : 1);
    const ctx = {
      h: { shots: ratio(es && es.h, teamAvg(home, 'hs', 'as')), fouls: ratio(ef && ef.h, teamAvg(home, 'hf', 'af')), oppFouls: ratio(ef && ef.a, teamAvg(away, 'hf', 'af')) },
      a: { shots: ratio(es && es.a, teamAvg(away, 'hs', 'as')), fouls: ratio(ef && ef.a, teamAvg(away, 'hf', 'af')), oppFouls: ratio(ef && ef.h, teamAvg(home, 'hf', 'af')) },
    };
    // A stat whose context didn't help in the backtest uses the plain player rate.
    const useCtx = c => ({ shots: c.shots, fouls: c.fouls, oppFouls: plParams.context.fw === false ? 1 : c.oppFouls });
    const side = (list, c) => list.filter(p => groupOf(p.pos) !== 'G').map(p => {
      const r = playerProps(plTable, p, div, useCtx(c), plParams);
      return {
        name: p.name, pos: p.pos, starts: r.starts,
        p: Object.fromEntries(MARKETS.map(mk => [mk.key, +(r.p[mk.key] * 100).toFixed(1)])),
        // Expected counts, so the site can price any line (2+ shots on target, 3+ shots...).
        exp: Object.fromEntries(Object.entries(r.exp).map(([k, v]) => [k, +v.toFixed(3)])),
      };
    });
    // homeExtra/awayExtra: squad players outside the XI (bench once team sheets are out).
    // Their chances assume they start, so the site flags them.
    return { status: xi.status, home: side(xi.h, ctx.h), away: side(xi.a, ctx.a), homeExtra: side(xi.hx || [], ctx.h), awayExtra: side(xi.ax || [], ctx.a) };
  }

  const byId = {};
  // European ties (Europa League, Conference League ...): the cross-league goals model
  // (cross.mjs), with the settings and calibration its own backtest chose
  // (data/model/cross-backtest.json). Goals only; no shots, Elo or player markets.
  let cross = null;
  const xbtPath = path.join(root, 'data/model/cross-backtest.json');
  const xbt = existsSync(xbtPath) ? JSON.parse(readFileSync(xbtPath, 'utf8')) : null;
  const crossPredict = f => {
    if (!xbt) { warnings.push(`${f.home} v ${f.away}: no cross-league backtest (run tools/model/backtest-cross.mjs)`); return; }
    if (!cross) {
      const data = loadCross(root);
      const xAsOf = Math.min(now, ...fixtures.filter(x => x.uefa).map(x => Date.parse(x.kickoff)));
      cross = { data, model: fitCross(data.rows, data.euro, { asOf: xAsOf, ...xbt.settings }), asOf: xAsOf };
    }
    const u = f.uefa, hk = cross.data.key(u.home, u.homeCountry), ak = cross.data.key(u.away, u.awayCountry);
    const e = cross.model.expected(hk, ak, !!u.neutral);
    if (!e) { warnings.push(`${f.home} v ${f.away}: a team has no results in the cross-league data`); return; }
    const q = probsFor(e.h, e.a, xbt.rho);
    const x3 = calibrate1x2([q.h, q.d, q.a], xbt.calibration.x12);
    const btts = calibrate2(q.btts, xbt.calibration.btts), o25 = calibrate2(q.o25, xbt.calibration.o25);
    const grid = calibratedGrid(q.grid, { h: x3[0], d: x3[1], a: x3[2], btts, o25 });
    const gm = marketsFromGrid(grid);
    const r1 = x => +(x * 100).toFixed(1);
    const th = cross.model.team(hk), ta = cross.model.team(ak);
    const domestic = t => !t.group.startsWith('U-');
    const context = ['Cross-league model: domestic league results from 27 divisions plus every European club result since 2021, so clubs from different countries are rated on one scale. Goals only (no shots, xG, Elo or lineups for most of these leagues).'];
    for (const [t, name] of [[th, f.home], [ta, f.away]]) {
      context.push(domestic(t)
        ? `${name}: rated from ${DIV_NAME[t.group] || t.group} results and ${t.euroGames} European games.`
        : `${name}: no domestic league data, so rated from ${t.euroGames} European games only (weaker rating).`);
    }
    const T = xbt.test;
    context.push(`Tested on ${T.n} European games it never saw (2024/25 to now): win/draw/loss log-loss ${T.x12.logloss} against ${T.x12.baseLogloss} for base rates, so it knows something; no bookmaker prices for these games, so it is not shown to beat the market. Over 2.5 ${T.o25.logloss < T.o25.base ? 'slightly better than' : 'no better than'} base rates; BTTS ${T.btts.logloss < T.btts.base ? 'slightly better than' : 'no better than'} base rates.`);
    byId[f.id] = {
      hw: r1(x3[0]), dw: r1(x3[1]), aw: r1(x3[2]), btts: r1(btts), ou25: r1(o25),
      over15: r1(gm.o15), over35: r1(gm.o35), cleanSheetH: r1(gm.csH), cleanSheetA: r1(gm.csA),
      grid, topScorelines: gm.top.map(s => ({ h: s.h, a: s.a, pct: r1(s.p) })),
      expH: +e.h.toFixed(3), expA: +e.a.toFixed(3),
      components: { goals: round3({ h: q.h, d: q.d, a: q.a }) },
      cross: true, context, teamGames: { h: th.euroGames, a: ta.euroGames },
      stats: {}, players: null,
    };
  };
  for (const f of fixtures) {
    const div = divOf(f);
    if (!div) { if (f.uefa) crossPredict(f); continue; } // European ties: cross-league model below
    const group = Object.keys(GROUPS).find(g => GROUPS[g].includes(div));
    const home = fdName(f.home), away = fdName(f.away);
    const t = Date.parse(f.kickoff);
    const last = members(div, prev);
    const fh = { ...teamFlags(sched, home, t), newcomer: !last.has(home) };
    const fa = { ...teamFlags(sched, away, t), newcomer: !last.has(away) };
    const derby = isDerby(home, away);
    const mult = contextMultipliers(factors, fh, fa, derby);
    // Confirmed lineups (tools/lineup-update.mjs), only when the backtest switched them on.
    if (lineupFit && f.lineups && f.lineups.home.reg != null && f.lineups.away.reg != null) {
      const asFeat = s => ({ reg: s.reg, gk: !!s.backupKeeper });
      const lm = lineupMultipliers(asFeat(f.lineups.home), asFeat(f.lineups.away), lineupFit);
      mult.h *= lm.h; mult.a *= lm.a;
      mult.applied.push(`confirmed lineups (x${lm.h.toFixed(3)} / x${lm.a.toFixed(3)} expected goals)`);
    }
    const p = predict(state, { group, div, home, away }, mult);
    if (!p) { warnings.push(`${f.home} v ${f.away}: team not found in the results data (check TEAM_ALIASES)`); continue; }
    const context = [];
    for (const k of FLAGS) for (const [side, flags, name] of [['h', fh, f.home], ['a', fa, f.away]]) {
      if (!flags[k]) continue;
      const fac = factors[k];
      context.push(fac
        ? `${name} ${FLAG_TEXT[k]} (applied: scores x${fac.att}, concedes x${fac.def}, measured on past seasons)`
        : `${name} ${FLAG_TEXT[k]} (noted only: no measurable effect on past seasons)`);
    }
    if (derby) context.push(factors.derby ? `Derby (applied: home goals x${factors.derby.h}, away goals x${factors.derby.a})` : 'Derby (noted only: no measurable effect on past seasons)');
    for (const a of mult.applied.filter(x => x.startsWith('confirmed lineups'))) context.push(`Applied: ${a}, sizes measured on past seasons`);
    const recent = team => matches.filter(m => m.date < asOf && asOf - m.date < 365 * DAY && (m.home === team || m.away === team)).length;
    const r1 = x => +(x * 100).toFixed(1);
    // Calibrated with the settings the backtest fitted on past seasons (calibration.mjs).
    const x3 = calib ? calibrate1x2([p.h, p.d, p.a], calib.x12) : [p.h, p.d, p.a];
    const btts = calib ? calibrate2(p.btts, calib.btts) : p.btts, o25 = calib ? calibrate2(p.o25, calib.o25) : p.o25;
    const grid = calibratedGrid(p.grid, { h: x3[0], d: x3[1], a: x3[2], btts, o25 });
    const gm = marketsFromGrid(grid);
    byId[f.id] = {
      hw: r1(x3[0]), dw: r1(x3[1]), aw: r1(x3[2]), btts: r1(btts), ou25: r1(o25),
      over15: r1(gm.o15), over35: r1(gm.o35), cleanSheetH: r1(gm.csH), cleanSheetA: r1(gm.csA),
      grid,
      topScorelines: gm.top.map(s => ({ h: s.h, a: s.a, pct: r1(s.p) })),
      expH: +p.expH.toFixed(3), expA: +p.expA.toFixed(3),
      components: {
        goals: round3(p.components.goals), shots: round3(p.components.shots), elo: round3(p.components.elo),
      },
      context, teamGames: { h: recent(home), a: recent(away) },
      stats: Object.fromEntries(Object.entries(statModels[group]).map(([k, r]) => {
        const e = r.expected(div, home, away);
        return [k, e ? { h: +e.h.toFixed(1), a: +e.a.toFixed(1) } : null];
      })),
      players: playerMarkets(f, group, div, home, away),
    };
  }
  const info = {
    version: 'independent-v4.1',
    fittedTo: new Date(asOf).toISOString().slice(0, 10),
    weights: cfg.weights, settings: { goals: cfg.goals, shots: cfg.shots, elo: cfg.elo },
    contextFactors: factors, calibration: calib, lineupEnabled: !!lineupFit,
    backtest: bt && summary(bt),
    players: plReport && { testSeasons: plReport.testSeasons, dispersion: plReport.params.r, markets: Object.fromEntries(Object.entries(plReport.markets).map(([k, v]) => [k, { label: v.label, model: v.model.logloss, position: v.position.logloss, n: v.model.n }])) },
  };
  return { byId, info, warnings, asOfLabel: new Date(asOf).toISOString().slice(0, 10) };
}

// Adjust the score grid (iterative proportional fitting) so it agrees with the
// calibrated win/draw/loss, BTTS and Over 2.5 shown on the site; scorelines,
// margins, totals and same-game combinations then all come from one distribution.
// Returned as rows 0-7 x columns 0-7 (home x away goals), the tail beyond 7 folded in.
export function calibratedGrid(grid, t) {
  const N = 8;
  const g = Array.from({ length: N }, (_, x) => Array.from({ length: N }, (_, y) => 0));
  grid.forEach((row, x) => row.forEach((p, y) => { g[Math.min(x, N - 1)][Math.min(y, N - 1)] += p; }));
  const parts = [
    [(x, y) => x > y, t.h], [(x, y) => x === y, t.d], [(x, y) => x < y, t.a],
    [(x, y) => x + y > 2, t.o25], [(x, y) => x + y <= 2, 1 - t.o25],
    [(x, y) => x > 0 && y > 0, t.btts], [(x, y) => !(x > 0 && y > 0), 1 - t.btts],
  ];
  for (let it = 0; it < 200; it++) {
    for (const [inPart, target] of parts) {
      let s = 0;
      for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) if (inPart(x, y)) s += g[x][y];
      if (s <= 0) continue;
      const k = target / s;
      for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) if (inPart(x, y)) g[x][y] *= k;
    }
  }
  const tot = g.flat().reduce((a, b) => a + b, 0);
  return g.map(row => row.map(p => +(p / tot).toFixed(5)));
}

function round3(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v]));
}

function summary(bt) {
  const o = bt.overall;
  const v = (bt.valueBets['1x2'] || []).find(x => x.threshold === 0.05) || bt.valueBets['1x2'][0];
  return {
    testSeasons: bt.testSeasons, n: o.model.n,
    modelBrier: o.model.brier, marketBrier: o.bet365PreMatch.brier, closingBrier: o.closing.brier,
    modelLogLoss: o.model.logloss, marketLogLoss: o.bet365PreMatch.logloss,
    blendWeight: bt.modelWeightInBlendWithMarket?.fittedOnValidation,
    value1x2: v, verdict: bt.verdict || '',
  };
}
