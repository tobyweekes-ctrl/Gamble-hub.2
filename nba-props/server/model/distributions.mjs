// Count distributions for prop outcomes.
// Given minutes, a stat is negative binomial with mean rate*minutes and dispersion 1/k (1/k = 0
// is Poisson, used for low counts like 3PM when the data show no extra spread). Minutes are
// uncertain too, so the final distribution mixes over a discretised normal for minutes.

/** pmf array [P(0..maxX)] of a negative binomial (or Poisson when invK ~ 0). */
export function countPmf(mu, invK, maxX) {
  const p = new Float64Array(maxX + 1);
  if (mu <= 0) { p[0] = 1; return p; }
  if (invK < 1e-6) {
    p[0] = Math.exp(-mu);
    for (let x = 0; x < maxX; x++) p[x + 1] = (p[x] * mu) / (x + 1);
  } else {
    const k = 1 / invK;
    const q = mu / (k + mu);
    p[0] = Math.exp(k * Math.log(k / (k + mu)));
    for (let x = 0; x < maxX; x++) p[x + 1] = (p[x] * (x + k) * q) / (x + 1);
  }
  return p;
}

const PHI_NODES = [-2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5];
const PHI_W = (() => {
  const w = PHI_NODES.map((z) => Math.exp(-z * z / 2));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
})();

/**
 * Mixture pmf: X | M ~ NB(ratePerMin * M, invK), M ~ Normal(minMean, minSd) clipped to [0, 48].
 * Returns { pmf, mean, sd }.
 */
export function mixturePmf({ ratePerMin, minMean, minSd, invK }) {
  const maxX = Math.ceil(ratePerMin * 48 * 1.6 + 25);
  const pmf = new Float64Array(maxX + 1);
  PHI_NODES.forEach((z, i) => {
    const m = Math.min(48, Math.max(0, minMean + z * minSd));
    const p = countPmf(ratePerMin * m, invK, maxX);
    for (let x = 0; x <= maxX; x++) pmf[x] += PHI_W[i] * p[x];
  });
  let mean = 0, m2 = 0, tot = 0;
  for (let x = 0; x <= maxX; x++) { tot += pmf[x]; mean += x * pmf[x]; m2 += x * x * pmf[x]; }
  return { pmf, mean: mean / tot, sd: Math.sqrt(m2 / tot - (mean / tot) ** 2) };
}

/** P(over), P(under), P(push) for a line. Half-point lines have no push. */
export function lineProbs(pmf, line) {
  let below = 0, at = 0, tot = 0;
  for (let x = 0; x < pmf.length; x++) {
    tot += pmf[x];
    if (x < line) below += pmf[x];
    else if (x === line) at += pmf[x];
  }
  return { over: (tot - below - at) / tot, under: below / tot, push: at / tot };
}

/** Normal CDF (Abramowitz-Stegun 7.1.26), for margin/blowout probabilities. */
export function normCdf(x, mu = 0, sd = 1) {
  const z = (x - mu) / (sd * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + (z >= 0 ? y : -y));
}
