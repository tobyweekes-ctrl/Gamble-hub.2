// Price parsing, implied probability, vig removal, expected value.

/** Accepts decimal "1.91", fractional "10/11", American "-110"/"+150", "evens". Returns decimal or null. */
export function parsePrice(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'number') return input > 1 ? input : null;
  const s = String(input).trim().toLowerCase();
  if (s === 'evens' || s === 'evs' || s === 'even') return 2;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[2]) > 0 ? 1 + Number(m[1]) / Number(m[2]) : null;
  m = s.match(/^([+-])(\d+(?:\.\d+)?)$/);
  if (m) {
    const n = Number(m[2]);
    if (n < 100) return null;
    return m[1] === '+' ? 1 + n / 100 : 1 + 100 / n;
  }
  const d = Number(s);
  return Number.isFinite(d) && d > 1 ? d : null;
}

export const implied = (dec) => (dec ? 1 / dec : null);

/**
 * Fair (no-vig) probabilities for a two-way market.
 * With only one price, the margin is assumed (`assumedMargin`) and the result is flagged.
 */
export function noVig(over, under, { method = 'multiplicative', assumedMargin = 0.05 } = {}) {
  const io = implied(over), iu = implied(under);
  if (io && iu) {
    const overround = io + iu;
    if (method === 'power') {
      // solve io^k + iu^k = 1 for k by bisection
      let lo = 0.5, hi = 2;
      for (let i = 0; i < 60; i++) {
        const k = (lo + hi) / 2;
        if (io ** k + iu ** k > 1) lo = k; else hi = k;
      }
      const k = (lo + hi) / 2;
      return { over: io ** k, under: iu ** k, margin: overround - 1, estimated: false };
    }
    return { over: io / overround, under: iu / overround, margin: overround - 1, estimated: false };
  }
  if (io) return { over: Math.min(0.99, io / (1 + assumedMargin)), under: null, margin: assumedMargin, estimated: true };
  if (iu) return { over: null, under: Math.min(0.99, iu / (1 + assumedMargin)), margin: assumedMargin, estimated: true };
  return null;
}

/** Expected profit per 1 unit staked. Push returns the stake. */
export function expectedValue(pWin, pPush, decimal) {
  if (!decimal || pWin == null) return null;
  const pLose = 1 - pWin - (pPush || 0);
  return pWin * (decimal - 1) - pLose;
}
