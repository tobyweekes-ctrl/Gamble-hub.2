// Minutes projection. Minutes drive most props, so this is its own explicit step:
//   base (this season vs last season, recency weighted)
//   -> return from injury / minutes restriction
//   -> teammates out (with/without history, else positional redistribution)
//   -> blowout risk (spread if fetched, else team ratings)
//   -> back-to-back
// Each step is recorded so the UI can show why the number moved.
import { mean } from '../util.mjs';
import { normCdf } from './distributions.mjs';
import { seasonWeight, blendTeam, decayMean, sd, clamp } from './blend.mjs';

export function blowoutProb(marginMean, cfgB) {
  const m = cfgB.margin;
  return 1 - (normCdf(m, marginMean, cfgB.marginSd) - normCdf(-m, marginMean, cfgB.marginSd));
}

/** Expected final margin from this team's view: spread if known, else net ratings and pace. */
export function expectedMargin(ctx, cfg) {
  if (ctx.spread != null) return { value: -ctx.spread, source: 'spread' };
  const k = cfg.blend.teamK;
  const net = (ts) => {
    const o = blendTeam(ts, 'ortg', k), d = blendTeam(ts, 'drtg', k);
    return o != null && d != null ? o - d : null;
  };
  const a = net(ctx.team), b = net(ctx.opp);
  if (a == null || b == null) return { value: ctx.game.home ? cfg.minutes.blowout.homeAdv : -cfg.minutes.blowout.homeAdv, source: 'home edge only' };
  const pace = ((blendTeam(ctx.team, 'pace', k) || 100) + (blendTeam(ctx.opp, 'pace', k) || 100)) / 2;
  return { value: ((a - b) * pace) / 100 + (ctx.game.home ? 1 : -1) * cfg.minutes.blowout.homeAdv, source: 'team ratings' };
}

export function projectMinutes(ctx, cfg) {
  const C = cfg.minutes;
  const steps = [];
  const flags = [];

  // 1. base
  const curMins = ctx.teamRows.map((r) => r.min);
  const prevMins = ctx.prevRows.slice(-30).map((r) => r.min);
  const k = ctx.traded ? cfg.blend.minutesKTraded : cfg.blend.minutesK;
  let base;
  if (curMins.length || prevMins.length) {
    const curM = curMins.length ? decayMean(curMins, C.halfLife) : null;
    const prevM = prevMins.length ? mean(prevMins) : null;
    const w = prevM == null ? 1 : curM == null ? 0 : seasonWeight(curMins.length, k);
    base = w * (curM ?? 0) + (1 - w) * (prevM ?? 0);
    steps.push({ key: 'base', label: 'Base minutes', value: base, note: `${Math.round(w * 100)}% this season (${curMins.length}g${ctx.traded ? ', new team' : ''}), ${Math.round((1 - w) * 100)}% last season` });
  } else {
    const any = ctx.curRows.map((r) => r.min);
    base = any.length ? mean(any) : 16;
    flags.push('no-history');
    steps.push({ key: 'base', label: 'Base minutes', value: base, note: any.length ? 'other team this season' : 'no history: league bench prior' });
  }
  let proj = base;

  // 2. return from injury / restriction
  const a = ctx.absence;
  const R = C.restriction;
  let restricted = false;
  if (a.status === 'absent' && a.gamesMissed >= R.minMissed) {
    const pre = mean(ctx.logs.slice(-10).map((r) => r.min));
    proj = pre * R.firstGameFactor;
    restricted = true;
    flags.push('first-game-back');
    steps.push({ key: 'restriction', label: 'First game back', value: proj - base, note: `missed ${a.gamesMissed}; ${Math.round(R.firstGameFactor * 100)}% of pre-injury ${pre.toFixed(1)}` });
  } else if (a.status === 'returned' && a.gamesMissed >= R.minMissed && a.gamesSinceReturn <= R.window) {
    const since = a.minutesSinceReturn;
    const pre = a.minutesBefore ?? base;
    const next = Math.min(pre, mean(since.slice(-2)) + R.rampPerGame);
    restricted = true;
    flags.push('returning');
    steps.push({ key: 'restriction', label: 'Return ramp', value: next - proj, note: `back ${a.gamesSinceReturn}g after missing ${a.gamesMissed}; mins ${since.map((m) => m.toFixed(0)).join(', ')} vs ${pre.toFixed(1)} before` });
    proj = next;
  }

  // 3. teammates out
  for (const m of ctx.teammatesOut) {
    const seasons = ctx.mateSeasons(m.id);
    const shared = ctx.logs.filter((r) => r.team === ctx.game.team && seasons.has(`${r.season}|${r.team}`));
    const withM = [], without = [];
    for (const r of shared) (ctx.lineup(r).has(m.id) ? withM : without).push(r.min);
    const w = withM.slice(-40), wo = without.slice(-40);
    const s = w.length >= 3 ? seasonWeight(wo.length, C.teammateK) : 0;
    const emp = s > 0 ? mean(wo) - mean(w) : 0;
    const weights = [...ctx.availableMates, { id: '_self', group: ctx.group, min: base }]
      .map((x) => x.min * (x.group === m.group ? C.sameGroupWeight : 1));
    const myShare = weights.at(-1) / weights.reduce((x, y) => x + y, 0);
    const fb = m.min * C.redistributeShare * myShare;
    const delta = s * emp + (1 - s) * fb;
    proj += delta;
    steps.push({ key: `mate:${m.id}`, label: `${m.name} out`, value: delta, note: s > 0 ? `${wo.length}g without him: ${emp >= 0 ? '+' : ''}${emp.toFixed(1)} (weight ${Math.round(s * 100)}%), positional share ${fb.toFixed(1)}` : `positional share of his ${m.min.toFixed(0)} min` });
  }

  // 4. blowout risk
  const B = C.blowout;
  const em = expectedMargin(ctx, cfg);
  const pB = blowoutProb(em.value, B);
  const pB0 = blowoutProb(0, { ...B, marginSd: Math.hypot(B.marginSd, 6) });
  const hist = [...ctx.prevRows.slice(-50), ...ctx.teamRows];
  const blow = [], normal = [];
  for (const r of hist) {
    const mg = ctx.marginOf(r);
    if (mg == null) continue;
    (Math.abs(mg) >= B.margin ? blow : normal).push(r.min);
  }
  const prior = base >= B.starterMin ? B.starterRatio : B.benchRatio;
  const empRatio = blow.length && normal.length ? mean(blow) / mean(normal) : prior;
  const ratio = (blow.length * empRatio + B.k * prior) / (blow.length + B.k);
  const bf = 1 + (pB - pB0) * (ratio - 1);
  const before = proj;
  proj *= bf;
  steps.push({ key: 'blowout', label: 'Blowout risk', value: proj - before, note: `exp. margin ${em.value >= 0 ? '+' : ''}${em.value.toFixed(1)} (${em.source}); P(${B.margin}+ pt game) ${Math.round(pB * 100)}% vs ${Math.round(pB0 * 100)}% typical; his blowout min ratio ${ratio.toFixed(2)}` });

  // 5. back-to-back
  if (ctx.restDays === 0) {
    const b = proj;
    proj *= C.b2bFactor;
    steps.push({ key: 'b2b', label: 'Back-to-back', value: proj - b, note: `x${C.b2bFactor}` });
  }

  proj = clamp(proj, 0, C.max);
  if (ctx.minutesOverride != null) {
    steps.push({ key: 'override', label: 'Manual minutes', value: ctx.minutesOverride - proj, note: 'user override' });
    proj = ctx.minutesOverride;
    flags.push('manual-minutes');
  }

  // uncertainty
  const curSd = sd(curMins.slice(-20)), prevSd = sd(prevMins);
  let s = Number.isFinite(curSd) && curMins.length >= 5 ? curSd : Number.isFinite(prevSd) ? prevSd : 6;
  s = Math.max(C.sdFloor, s);
  if (restricted) s += R.sdBoost;
  s += 0.75 * ctx.teammatesOut.length;
  if (flags.includes('no-history')) s += 4;

  return { proj, sd: s, base, steps, flags, restricted, blowoutProb: pB, expectedMargin: em };
}
