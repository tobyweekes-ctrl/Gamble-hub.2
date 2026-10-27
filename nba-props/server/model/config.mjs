// Every tunable weight of the model in one place. Override per call (deep-merged) or from the
// backtest CLI:  node scripts/backtest.mjs --set recency.last5=0.3 --set threshold=0.05
export const DEFAULTS = {
  // Verdict
  threshold: 0.04,           // min edge (model prob − no-vig market prob) to recommend a side
  requirePositiveEV: true,   // also require EV > 0 at the offered price
  devig: 'multiplicative',   // 'multiplicative' | 'power'
  assumedMargin: 0.05,       // bookmaker margin assumed when only one side's price is known

  // Last season vs this season: weight on this season = n / (n + k), n = games this season
  blend: {
    rateK: 12,               // per-minute production (pts, reb, ast)
    fg3mRateK: 20,           // 3PM is noisier, so it needs more games
    minutesK: 5,             // role shows up quickly
    minutesKTraded: 2,       // changed team: last season's minutes barely count
    teamK: 15,               // team pace / defence, in team games
  },

  // Recent form on top of the season blend (weights sum to 1). Short-run form is mostly noise;
  // heavier recency made the backtest overconfident, so recent games get a modest share.
  recency: { season: 0.7, last10: 0.2, last5: 0.1 },

  minutes: {
    halfLife: 6,             // games; recency weighting of this season's minutes
    max: 42,
    sdFloor: 3,
    b2bFactor: 0.97,
    teammateK: 5,            // shrinkage (games) for with/without-teammate minutes
    redistributeShare: 0.85, // share of an absent teammate's minutes that goes to the rotation
    sameGroupWeight: 1.6,    // same position group absorbs more of those minutes
    restriction: { minMissed: 5, window: 5, firstGameFactor: 0.75, rampPerGame: 1.5, sdBoost: 2.5 },
    blowout: { margin: 18, marginSd: 12.5, homeAdv: 1.5, starterRatio: 0.86, benchRatio: 1.12, k: 15, starterMin: 28 },
  },

  adjust: {
    home: 1.015, away: 0.985,
    personalHomeK: 40,       // shrinkage of a player's own home/away split
    b2b: { pts: 0.98, reb: 0.99, ast: 0.99, fg3m: 0.97 },
    paceElasticity: { pts: 1.0, reb: 0.7, ast: 0.9, fg3m: 0.9 },
    defWeight: 0.5,          // how much of the opponent-vs-position factor to apply (estimates are noisy)
    h2hK: 15,                // head-to-head shrinkage in games (3 games -> 17% weight)
    h2hCap: 0.1,             // max ±10% from head-to-head
    teammateRateK: 10,
    teammateRateCap: [0.85, 1.25],
  },

  dispersion: {
    // prior for 1/k of the negative binomial (0 = Poisson), per stat
    prior: { pts: 0.03, reb: 0.04, ast: 0.05, fg3m: 0.03, pra: 0.02, pr: 0.025, pa: 0.025, ra: 0.03 },
    k: 20,                   // games of evidence needed to move halfway from the prior
    window: 60,
    // Uncertainty in the projected mean itself, added on top of game-to-game noise:
    //   sampling error of the rate (shrinks as games accumulate) + modelCv^2 for adjustment error.
    // Calibrate modelCv with the backtest's "spread" column (target 1.00).
    modelCv: 0.12,
    maxGamesForSampling: 40,
  },
};

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
export function mergeConfig(base, over = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? mergeConfig(base[k], v) : v;
  return out;
}

/** "recency.last5=0.3" -> { recency: { last5: 0.3 } } */
export function parseOverride(s) {
  const [path, raw] = s.split('=');
  const val = raw === 'true' ? true : raw === 'false' ? false : Number.isNaN(Number(raw)) ? raw : Number(raw);
  return path.split('.').reduceRight((acc, key) => ({ [key]: acc }), val);
}
