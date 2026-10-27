// Public entry point of the model. Everything else in this folder is pure functions:
//   config.mjs        all weights (tweak here)
//   context.mjs       inputs for one player-game, from data before the game only
//   minutes.mjs       minutes projection
//   projection.mjs    per-minute rates, adjustments, count distribution
//   distributions.mjs negative binomial / Poisson, minutes mixture
//   odds.mjs          price parsing, no-vig, EV
//   evaluate.mjs      edge, verdict, confidence, hit rates
import { DEFAULTS, mergeConfig } from './config.mjs';
import { buildContext } from './context.mjs';
import { projectPlayer, projectStat } from './projection.mjs';
import { evaluateMarket, quality, hitRates } from './evaluate.mjs';

export { DEFAULTS, mergeConfig, buildContext, projectPlayer, projectStat, evaluateMarket, quality, hitRates };

/**
 * One-call analysis for a player, stat and set of lines.
 * @returns projection, per-line evaluations, headline verdict, hit rates vs the main line
 */
export function analyse({ L, playerId, game, stat, lines = [], opts = {}, config = {} }) {
  const cfg = mergeConfig(DEFAULTS, config);
  const ctx = buildContext(L, playerId, game, opts);
  const pp = projectPlayer(ctx, cfg);
  const sp = projectStat(pp, ctx, stat, cfg);
  if (!sp) return { error: 'not enough data to project this player' };
  const q = quality(ctx, pp.minutes);
  const market = evaluateMarket(sp, lines, q, cfg);
  const mainLine = market.headline?.line ?? market.consensus?.line ?? sp.modelLine;
  return {
    config: { threshold: cfg.threshold, devig: cfg.devig },
    context: {
      restDays: ctx.restDays, oppRestDays: ctx.oppRestDays, traded: ctx.traded, group: ctx.group,
      absence: ctx.absence,
      teammatesOut: ctx.teammatesOut.map((m) => ({ id: m.id, name: m.name, min: Math.round(m.min * 10) / 10 })),
      gamesThisSeason: ctx.curRows.length, gamesLastSeason: ctx.prevRows.length, h2hGames: ctx.h2hRows.length,
    },
    projection: summarise(sp),
    quality: q,
    ...market,
    hitRates: { line: mainLine, ...hitRates(ctx.logs, stat, mainLine, ctx.cur) },
  };
}

/** JSON-friendly projection (pmf trimmed to 99.9% of the mass). */
export function summarise(sp) {
  let cum = 0;
  const pmf = [];
  for (const p of sp.pmf) { pmf.push(Math.round(p * 1e5) / 1e5); cum += p; if (cum > 0.999) break; }
  const m = sp.minutes;
  return {
    stat: sp.stat, mean: sp.mean, sd: sp.sd, modelLine: sp.modelLine,
    family: sp.family, dispersion: sp.invK, per36: sp.per36, basePer36: sp.basePer36,
    seasonWeight: sp.seasonWeight,
    factors: sp.factors,
    minutes: { proj: m.proj, sd: m.sd, base: m.base, steps: m.steps, flags: m.flags, blowoutProb: m.blowoutProb, expectedMargin: m.expectedMargin },
    pmf,
  };
}
