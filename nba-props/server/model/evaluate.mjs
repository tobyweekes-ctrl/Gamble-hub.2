// Turn a stat distribution + a bookmaker line into probabilities, edge, EV and a verdict.
import { lineProbs } from './distributions.mjs';
import { noVig, expectedValue, parsePrice } from './odds.mjs';
import { statValue } from '../stats.mjs';

/**
 * Data-quality score in [0, 1] with plain-English notes. Lowers confidence, never flips a side.
 */
export function quality(ctx, minutes) {
  let q = 1;
  const notes = [];
  const n = ctx.logs.length;
  if (minutes.flags.includes('no-history')) { q -= 0.5; notes.push('no game history'); }
  else if (n < 10) { q -= 0.3; notes.push(`only ${n} career games in data`); }
  if (ctx.curRows.length < 5) { q -= 0.1; notes.push(`${ctx.curRows.length} games this season (leaning on last season)`); }
  if (ctx.traded) { q -= 0.1; notes.push('changed team'); }
  if (minutes.restricted) { q -= 0.25; notes.push('minutes restriction risk after absence'); }
  if (ctx.teammatesOut.length >= 2) { q -= 0.1; notes.push(`${ctx.teammatesOut.length} rotation teammates out`); }
  if (minutes.sd / Math.max(1, minutes.proj) > 0.3) { q -= 0.15; notes.push('volatile minutes'); }
  return { score: Math.max(0, Math.round(q * 100) / 100), notes };
}

/**
 * @param sp  output of projectStat
 * @param l   { line, over, under, book?, bookTitle? } prices in any format parsePrice accepts
 * @param q   quality() output
 */
export function evaluateLine(sp, l, q, cfg) {
  const over = parsePrice(l.over), under = parsePrice(l.under);
  const line = Number(l.line);
  const p = lineProbs(sp.pmf, line);
  // the market prices exclude pushes, so compare against the model's no-push probabilities
  const noPush = p.over + p.under;
  const cond = { over: p.over / noPush, under: p.under / noPush };
  const fair = noVig(over, under, { method: cfg.devig, assumedMargin: cfg.assumedMargin });
  const edge = {
    over: fair?.over != null ? cond.over - fair.over : null,
    under: fair?.under != null ? cond.under - fair.under : null,
  };
  const ev = { over: expectedValue(p.over, p.push, over), under: expectedValue(p.under, p.push, under) };

  const sides = ['over', 'under'].filter((s) => edge[s] != null);
  const best = sides.sort((a, b) => edge[b] - edge[a])[0] || null;
  const passes = best && edge[best] >= cfg.threshold && (!cfg.requirePositiveEV || ev[best] > 0);
  const side = passes ? best : null;
  let confidence = null;
  if (side) {
    const r = edge[side] / cfg.threshold;
    confidence = r >= 2.5 && q.score >= 0.7 ? 'HIGH' : r >= 1.5 && q.score >= 0.5 ? 'MEDIUM' : 'LOW';
  }
  return {
    id: l.id ?? null, book: l.book || null, bookTitle: l.bookTitle || l.book || null, source: l.source || null,
    bestOver: Boolean(l.bestOver), bestUnder: Boolean(l.bestUnder),
    line, over, under,
    model: { over: p.over, under: p.under, push: p.push },
    fair, edge, ev,
    verdict: side ? side.toUpperCase() : 'PASS',
    side, confidence,
    leanSide: best, leanEdge: best ? edge[best] : null,
  };
}

/** Evaluate every line; the headline is the recommended line with the highest EV. */
export function evaluateMarket(sp, lines, q, cfg) {
  const evals = lines.map((l) => evaluateLine(sp, l, q, cfg));
  // a line being typed in (preview) is shown on its own; it never becomes the headline
  const real = evals.filter((e) => e.source !== 'preview');
  const recs = real.filter((e) => e.side);
  const headline = recs.sort((a, b) => b.ev[b.side] - a.ev[a.side])[0]
    || real.slice().sort((a, b) => (b.leanEdge ?? -1) - (a.leanEdge ?? -1))[0] || null;
  // market consensus at the most common line
  const counts = new Map();
  for (const e of real) counts.set(e.line, (counts.get(e.line) || 0) + 1);
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const atModal = real.filter((e) => e.line === modal && e.fair?.over != null);
  const consensus = atModal.length
    ? { line: modal, over: atModal.reduce((a, e) => a + e.fair.over, 0) / atModal.length, books: atModal.length }
    : null;
  return { evals, headline, consensus };
}

/** Hit rate against an exact line over recent windows and this season. */
export function hitRates(logs, stat, line, currentSeason) {
  const calc = (rows) => {
    const vals = rows.map((r) => statValue(r, stat));
    const over = vals.filter((v) => v > line).length;
    const under = vals.filter((v) => v < line).length;
    return { n: rows.length, over, under, push: rows.length - over - under, rate: rows.length ? over / rows.length : null, avg: rows.length ? vals.reduce((a, b) => a + b, 0) / rows.length : null };
  };
  const season = logs.filter((r) => r.season === currentSeason);
  const prev = logs.filter((r) => r.season !== currentSeason);
  return {
    last5: calc(logs.slice(-5)),
    last10: calc(logs.slice(-10)),
    last20: calc(logs.slice(-20)),
    season: calc(season),
    lastSeason: calc(prev.filter((r) => r.season === prev.at(-1)?.season)),
  };
}
