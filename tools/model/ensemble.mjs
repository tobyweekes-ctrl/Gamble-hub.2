// Builds the model state from matches played before `asOf` and predicts fixtures.
// Used both by the walk-forward backtest and by the weekly build, so what is
// tested is exactly what is published.

import { GROUPS } from './data.mjs';
import { fitRatings, scoreGrid, marketsFromGrid, fitRho, runElo, eloProbs, fitEloLink } from './models.mjs';

const DAY = 864e5;

export const DEFAULT_CONFIG = {
  goals: { xi: 0.0025, sigma: 0.35 },
  shots: { xi: 0.004, sigma: 0.3 },
  elo: { k: 20, hfa: 60 },
  weights: { goals: 0.34, shots: 0.33, elo: 0.33 },
  context: {},       // multiplicative factors fitted by the backtest (see context.mjs)
};

export function buildState(matches, asOf, cfg = DEFAULT_CONFIG) {
  const past = matches.filter(m => m.date < asOf);
  const groups = {};
  for (const g of Object.keys(GROUPS)) {
    const gm = past.filter(m => m.group === g);
    const goals = fitRatings(gm, { asOf, ...cfg.goals, hKey: 'hg', aKey: 'ag' });
    const shots = fitRatings(gm, { asOf, ...cfg.shots, hKey: 'qh', aKey: 'qa' });
    // Goals per shot on target, per division, over the last year.
    const conv = {};
    for (const m of gm) {
      if (asOf - m.date > 365 * DAY || m.hst == null) continue;
      conv[m.div] = conv[m.div] || { g: 0, s: 0 };
      conv[m.div].g += m.hg + m.ag; conv[m.div].s += m.hst + m.ast;
    }
    for (const d of Object.keys(conv)) conv[d] = conv[d].g / conv[d].s;
    // Low-score correction from the last two years of this group's matches.
    const pairs = [];
    for (const m of gm) {
      if (asOf - m.date > 730 * DAY) continue;
      const e = goals.expected(m.div, m.home, m.away);
      if (e) pairs.push({ lh: e.h, la: e.a, hg: m.hg, ag: m.ag, w: 1 });
    }
    groups[g] = { goals, shots, conv, rho: fitRho(pairs) };
  }
  const elo = runElo(past, cfg.elo);
  const samples = [];
  for (const m of past) {
    if (asOf - m.date > 3 * 365 * DAY) continue;
    const r = elo.pre.get(m);
    samples.push({ x: (r.rh + cfg.elo.hfa - r.ra) / 100, o: m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2 });
  }
  return { asOf, cfg, groups, elo: elo.current, eloLink: fitEloLink(samples) };
}

// fixture: { group, div, home, away } with football-data team names; ctx: context
// multipliers already resolved for this fixture ({h, a} applied to both goal models).
export function predict(state, fx, ctx = { h: 1, a: 1 }) {
  const G = state.groups[fx.group];
  if (!G) return null;
  const eg = G.goals.expected(fx.div, fx.home, fx.away);
  const es = G.shots.expected(fx.div, fx.home, fx.away);
  const rh = state.elo.get(fx.home), ra = state.elo.get(fx.away);
  if (!eg || !es || rh == null || ra == null || !G.conv[fx.div]) return null;
  const goalsL = { h: eg.h * ctx.h, a: eg.a * ctx.a };
  const shotsL = { h: es.h * G.conv[fx.div] * ctx.h, a: es.a * G.conv[fx.div] * ctx.a };
  const gGrid = scoreGrid(goalsL.h, goalsL.a, G.rho);
  const sGrid = scoreGrid(shotsL.h, shotsL.a, G.rho);
  const goals = marketsFromGrid(gGrid), shots = marketsFromGrid(sGrid);
  const elo = eloProbs((rh + state.cfg.elo.hfa - ra) / 100, state.eloLink);
  const w = state.cfg.weights;
  const wsum = w.goals + w.shots + w.elo;
  const x3 = [0, 1, 2].map(i => (w.goals * [goals.h, goals.d, goals.a][i] + w.shots * [shots.h, shots.d, shots.a][i] + w.elo * elo[i]) / wsum);
  // Totals and BTTS come from the two goal models only (Elo has no score distribution).
  const wg = w.goals / (w.goals + w.shots || 1), ws = 1 - wg;
  const mix = k => wg * goals[k] + ws * shots[k];
  const grid = gGrid.map((row, x) => row.map((p, y) => wg * p + ws * sGrid[x][y]));
  return {
    h: x3[0], d: x3[1], a: x3[2],
    btts: mix('btts'), o15: mix('o15'), o25: mix('o25'), o35: mix('o35'), csH: mix('csH'), csA: mix('csA'),
    top: marketsFromGrid(grid).top,
    expH: wg * goalsL.h + ws * shotsL.h, expA: wg * goalsL.a + ws * shotsL.a,
    components: {
      goals: { h: goals.h, d: goals.d, a: goals.a, expH: goalsL.h, expA: goalsL.a },
      shots: { h: shots.h, d: shots.d, a: shots.a, expH: shotsL.h, expA: shotsL.a, sotH: es.h * ctx.h, sotA: es.a * ctx.a },
      elo: { h: elo[0], d: elo[1], a: elo[2], rh, ra },
    },
    rho: G.rho,
  };
}
