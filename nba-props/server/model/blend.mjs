// Shrinkage / blending helpers shared by the minutes and stat projections.
import { mean } from '../util.mjs';

/** Weight on this season after n games with prior strength k: n / (n + k). */
export const seasonWeight = (n, k) => (n + k > 0 ? n / (n + k) : 0);

/** Blend a team-level value from {cur, prev} season summaries by games played. */
export function blendTeam(ts, key, k) {
  const c = ts.cur?.[key], p = ts.prev?.[key];
  if (c == null && p == null) return null;
  if (c == null) return p;
  if (p == null) return c;
  const w = seasonWeight(ts.cur.games, k);
  return w * c + (1 - w) * p;
}

/** Recency-weighted mean (most recent last), weight halves every `halfLife` items. */
export function decayMean(xs, halfLife) {
  if (!xs.length) return NaN;
  let s = 0, w = 0;
  for (let i = 0; i < xs.length; i++) {
    const wi = 0.5 ** ((xs.length - 1 - i) / halfLife);
    s += wi * xs[i]; w += wi;
  }
  return s / w;
}

export function sd(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Shrink an observed ratio toward 1 with n observations and prior strength k. */
export const shrinkRatio = (ratio, n, k) => 1 + (ratio - 1) * seasonWeight(n, k);

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
