// Stat projection = per-minute rate x projected minutes, then a count distribution around it.
//
// Per-minute rate for each base stat (pts, reb, ast, fg3m):
//   season rate  = w * this season + (1 - w) * last season,  w = n / (n + k)
//   base rate    = recency.season * season rate + recency.last10 * L10 rate + recency.last5 * L5 rate
//   x home/away x back-to-back x matchup pace x opponent defence vs position x head-to-head
//   x teammates out (usage bump)
// Combos (PRA, P+R, ...) sum their components' means; their spread is fitted on the combo itself.
import { STATS, statValue } from '../stats.mjs';
import { mixturePmf } from './distributions.mjs';
import { seasonWeight, blendTeam, shrinkRatio, clamp } from './blend.mjs';
import { projectMinutes } from './minutes.mjs';

const BASE_STATS = ['pts', 'reb', 'ast', 'fg3m'];

function rate(rows, s) {
  let x = 0, m = 0;
  for (const r of rows) { x += r[s]; m += r.min; }
  return m >= 30 ? x / m : null;
}

function componentRate(ctx, s, cfg) {
  const A = cfg.adjust;
  const factors = [];
  const k = s === 'fg3m' ? cfg.blend.fg3mRateK : cfg.blend.rateK;
  const rc = rate(ctx.curRows, s), rp = rate(ctx.prevRows, s);
  const w = rp == null ? 1 : rc == null ? 0 : seasonWeight(ctx.curRows.length, k);
  const seasonRate = rc == null && rp == null ? rate(ctx.logs, s) : w * (rc ?? 0) + (1 - w) * (rp ?? 0);
  if (seasonRate == null) return null;

  const parts = [[cfg.recency.season, seasonRate], [cfg.recency.last10, rate(ctx.logs.slice(-10), s)], [cfg.recency.last5, rate(ctx.logs.slice(-5), s)]]
    .filter(([, v]) => v != null);
  const wsum = parts.reduce((a, [wt]) => a + wt, 0);
  const base = parts.reduce((a, [wt, v]) => a + wt * v, 0) / wsum;

  // home / away: the player's own split, shrunk toward the league-wide effect
  const venue = ctx.logs.filter((r) => r.home === ctx.game.home);
  const own = rate(venue, s) != null && rate(ctx.logs, s) ? rate(venue, s) / rate(ctx.logs, s) : 1;
  const sv = seasonWeight(venue.length, A.personalHomeK);
  const lg = ctx.game.home ? A.home : A.away;
  factors.push({ key: 'venue', label: ctx.game.home ? 'Home' : 'Away', value: 1 + (own - 1) * sv + (lg - 1) * (1 - sv) });

  if (ctx.restDays === 0) factors.push({ key: 'b2b', label: 'Back-to-back', value: A.b2b[s] });

  const tk = cfg.blend.teamK;
  const tPace = blendTeam(ctx.team, 'pace', tk), oPace = blendTeam(ctx.opp, 'pace', tk);
  const lgPace = blendTeam({ cur: ctx.league.cur && { ...ctx.league.cur, games: ctx.team.cur?.games || 0 }, prev: ctx.league.prev }, 'pace', tk);
  if (tPace && oPace && lgPace) {
    const gamePace = tPace + oPace - lgPace;
    factors.push({ key: 'pace', label: 'Matchup pace', value: 1 + A.paceElasticity[s] * (gamePace / tPace - 1), note: `${gamePace.toFixed(1)} vs his team's ${tPace.toFixed(1)}` });
  }

  const pd = ctx.posDef(ctx.game.opp, ctx.group);
  const fc = pd.cur?.[s], fp = pd.prev?.[s];
  if (fc != null || fp != null) {
    const wd = fp == null ? 1 : fc == null ? 0 : seasonWeight(pd.curGames, tk);
    const f = wd * (fc ?? 1) + (1 - wd) * (fp ?? 1);
    factors.push({ key: 'defence', label: `${ctx.game.opp} vs ${ctx.group === 'G' ? 'guards' : ctx.group === 'C' ? 'centres' : 'forwards'}`, value: 1 + A.defWeight * (f - 1), note: `allows ${((f - 1) * 100).toFixed(0)}% vs avg` });
  }

  const h = ctx.h2hRows;
  const rh = rate(h, s), rAll = rate(ctx.logs, s);
  if (rh != null && rAll) {
    const v = clamp(shrinkRatio(rh / rAll, h.length, A.h2hK), 1 - A.h2hCap, 1 + A.h2hCap);
    factors.push({ key: 'h2h', label: `vs ${ctx.game.opp} history`, value: v, note: `${h.length}g, weight ${Math.round(seasonWeight(h.length, A.h2hK) * 100)}%` });
  }

  if (ctx.teammatesOut.length) {
    let f = 1;
    const notes = [];
    for (const m of ctx.teammatesOut) {
      const seasons = ctx.mateSeasons(m.id);
      const shared = ctx.logs.filter((r) => r.team === ctx.game.team && seasons.has(`${r.season}|${r.team}`));
      const w = shared.filter((r) => ctx.lineup(r).has(m.id)).slice(-40);
      const wo = shared.filter((r) => !ctx.lineup(r).has(m.id)).slice(-40);
      const a = rate(wo, s), b = rate(w, s);
      if (a != null && b && w.length >= 3) {
        f *= shrinkRatio(a / b, wo.length, A.teammateRateK);
        notes.push(`${m.name.split(' ').at(-1)} ${wo.length}g`);
      }
    }
    if (notes.length) factors.push({ key: 'mates', label: 'Teammates out', value: clamp(f, ...A.teammateRateCap), note: `per-min without: ${notes.join(', ')}` });
  }

  const rateAdj = factors.reduce((a, f) => a * f.value, base);
  return { seasonRate, base, rate: rateAdj, factors, w };
}

/** Per-player work shared by all stats: minutes + component rates. */
export function projectPlayer(ctx, cfg) {
  const minutes = projectMinutes(ctx, cfg);
  const comps = {};
  for (const s of BASE_STATS) comps[s] = componentRate(ctx, s, cfg);
  return { minutes, comps };
}

/** 1/k for the negative binomial, fitted to game-to-game spread given minutes, shrunk to a prior. */
export function fitDispersion(logs, stat, cfg) {
  const rows = logs.slice(-cfg.dispersion.window).filter((r) => r.min > 0);
  const prior = cfg.dispersion.prior[stat];
  if (rows.length < 5) return prior;
  const xs = rows.map((r) => statValue(r, stat));
  const totMin = rows.reduce((a, r) => a + r.min, 0);
  const rt = xs.reduce((a, b) => a + b, 0) / totMin;
  let num = 0, den = 0;
  rows.forEach((r, i) => { const mu = rt * r.min; num += (xs[i] - mu) ** 2 - mu; den += mu * mu; });
  const hat = den > 0 ? Math.max(0, num / den) : prior;
  const K = cfg.dispersion.k;
  return (rows.length * hat + K * prior) / (rows.length + K);
}

/** Full distribution for one stat. */
export function projectStat(pp, ctx, stat, cfg) {
  const parts = STATS[stat].parts;
  const comps = parts.map((p) => pp.comps[p]);
  if (comps.some((c) => !c)) return null;
  const ratePerMin = comps.reduce((a, c) => a + c.rate, 0);
  const baseRate = comps.reduce((a, c) => a + c.base, 0);
  const invK = fitDispersion(ctx.logs, stat, cfg);
  // uncertainty of the mean: sampling error over the games behind the rate + model error
  const D = cfg.dispersion;
  const nEff = Math.max(1, Math.min(D.maxGamesForSampling, ctx.logs.length));
  const perGame = ratePerMin * Math.max(1, pp.minutes.proj);
  const meanCv2 = (1 / Math.max(0.5, perGame) + invK) / nEff + D.modelCv ** 2;
  const { pmf, mean, sd } = mixturePmf({ ratePerMin, minMean: pp.minutes.proj, minSd: pp.minutes.sd, invK: invK + meanCv2 });

  // combined factors, weighted by each component's share of the stat
  const byKey = new Map();
  for (const c of comps) {
    for (const f of c.factors) {
      const e = byKey.get(f.key) || { key: f.key, label: f.label, note: f.note, num: 0, den: 0 };
      e.num += c.base * f.value; e.den += c.base;
      byKey.set(f.key, e);
    }
  }
  // (components a factor doesn't apply to count as 1)
  const factors = [...byKey.values()].map((e) => ({ key: e.key, label: e.label, note: e.note, value: (e.num + (baseRate - e.den)) / baseRate }));

  // the model's own line: median of the distribution, as an x.5
  let cum = 0, median = 0;
  for (let x = 0; x < pmf.length; x++) { cum += pmf[x]; if (cum >= 0.5) { median = x; break; } }

  return {
    stat, mean, sd, pmf, invK, meanCv: Math.sqrt(meanCv2),
    family: invK < 0.005 ? 'Poisson' : 'Negative binomial',
    ratePerMin, per36: ratePerMin * 36, basePer36: baseRate * 36,
    minutes: pp.minutes,
    seasonWeight: comps[0].w,
    factors,
    modelLine: median - 0.5,
  };
}
