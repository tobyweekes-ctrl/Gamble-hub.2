// The independent models. None of them sees a bookmaker price.
//
// 1. Goals model: Dixon-Coles. Each team has an attack and a defence rating, each
//    division a home advantage and a scoring level; recent matches weigh more
//    (exponential time decay); ratings are shrunk towards their division's mean.
// 2. Shots model: the same rating model fitted to shots on target, turned into
//    expected goals with each division's goals-per-shot-on-target rate. Shots are
//    less noisy than goals, so this reads team quality from fewer matches.
// 3. Elo: a goal-difference Elo rating per team, mapped to win/draw/loss with an
//    ordered logistic fitted on past matches.
// The ensemble weights and every setting here are chosen on validation seasons in
// tools/model/backtest.mjs, never on the season being reported.

const DAY = 864e5;

// ---- Generic weighted Poisson rating model ---------------------------------
// log E[home count] = O[div] + H[div] + A[home] - D[away]
// log E[away count] = O[div] + A[away] - D[home]
// seasonDiscount (0-1] multiplies the weight of a match once per season boundary
// between it and the latest season in the data: squads change over the summer, so
// last season says less about this one than its age alone suggests.
export function fitRatings(matches, { asOf, xi, sigma, hKey, aKey, seasonDiscount = 1, iters = 30 }) {
  const rows = [];
  let cur = '';
  for (const m of matches) if (m.date < asOf && m.season > cur) cur = m.season;
  const seasonsBack = s => Number(cur.slice(0, 2)) - Number(s.slice(0, 2));
  for (const m of matches) {
    if (m.date >= asOf || m[hKey] == null || m[aKey] == null) continue;
    const w = Math.exp(-xi * (asOf - m.date) / DAY) * seasonDiscount ** seasonsBack(m.season);
    if (w < 1e-3) continue;
    rows.push({ m, w });
  }
  const teams = new Map(), divs = new Map(), teamDiv = new Map();
  for (const { m } of rows) {
    for (const t of [m.home, m.away]) if (!teams.has(t)) teams.set(t, teams.size);
    if (!divs.has(m.div)) divs.set(m.div, divs.size);
    teamDiv.set(m.home, m.div); teamDiv.set(m.away, m.div); // rows are date-ordered: last division wins
  }
  const nT = teams.size, nD = divs.size;
  const A = new Float64Array(nT), D = new Float64Array(nT);
  const O = new Float64Array(nD), H = new Float64Array(nD).fill(0.2);
  { // start the scoring level at the mean count
    let s = 0, n = 0;
    for (const { m, w } of rows) { s += w * (m[hKey] + m[aKey]); n += 2 * w; }
    O.fill(Math.log(s / n));
  }
  const idx = rows.map(({ m }) => [teams.get(m.home), teams.get(m.away), divs.get(m.div)]);
  const prec = 1 / (sigma * sigma);
  const divOfTeam = new Int32Array(nT);
  for (const [t, i] of teams) divOfTeam[i] = divs.get(teamDiv.get(t));
  const LH = new Float64Array(rows.length), LA = new Float64Array(rows.length);
  const refresh = () => rows.forEach((r, k) => {
    const [i, j, d] = idx[k];
    LH[k] = Math.exp(O[d] + H[d] + A[i] - D[j]);
    LA[k] = Math.exp(O[d] + A[j] - D[i]);
  });
  // Block coordinate Newton: within each block the parameters touch disjoint
  // expected counts, so the diagonal Newton step is exact for that block.
  const step = (n, accumulate, apply) => {
    const g = new Float64Array(n), h = new Float64Array(n);
    rows.forEach(({ m, w }, k) => accumulate(g, h, idx[k], w * (m[hKey] - LH[k]), w * (m[aKey] - LA[k]), w * LH[k], w * LA[k]));
    apply(g, h);
    refresh();
  };
  const divMeans = () => {
    const mA = new Float64Array(nD), mD = new Float64Array(nD), cnt = new Float64Array(nD);
    for (let t = 0; t < nT; t++) { mA[divOfTeam[t]] += A[t]; mD[divOfTeam[t]] += D[t]; cnt[divOfTeam[t]]++; }
    return [mA.map((x, d) => x / cnt[d]), mD.map((x, d) => x / cnt[d])];
  };
  refresh();
  for (let it = 0; it < iters; it++) {
    step(nD, (g, h, [, , d], rh, ra, wh, wa) => { g[d] += rh + ra; h[d] += wh + wa; },
      (g, h) => { for (let d = 0; d < nD; d++) O[d] += g[d] / h[d]; });
    step(nD, (g, h, [, , d], rh, ra, wh) => { g[d] += rh; h[d] += wh; },
      (g, h) => { for (let d = 0; d < nD; d++) H[d] += g[d] / h[d]; });
    let [mA, mD] = divMeans();
    step(nT, (g, h, [i, j], rh, ra, wh, wa) => { g[i] += rh; h[i] += wh; g[j] += ra; h[j] += wa; },
      (g, h) => { for (let t = 0; t < nT; t++) A[t] += (g[t] - prec * (A[t] - mA[divOfTeam[t]])) / (h[t] + prec); });
    [mA, mD] = divMeans();
    step(nT, (g, h, [i, j], rh, ra, wh, wa) => { g[j] -= rh; h[j] += wh; g[i] -= ra; h[i] += wa; },
      (g, h) => { for (let t = 0; t < nT; t++) D[t] += (g[t] - prec * (D[t] - mD[divOfTeam[t]])) / (h[t] + prec); });
    // Identify the scale: mean attack and defence are zero; the level lives in O.
    let sa = 0, sd = 0;
    for (let t = 0; t < nT; t++) { sa += A[t]; sd += D[t]; }
    for (let t = 0; t < nT; t++) { A[t] -= sa / nT; D[t] -= sd / nT; }
    for (let d = 0; d < nD; d++) O[d] += (sa - sd) / nT;
  }
  const team = name => (teams.has(name) ? { a: A[teams.get(name)], d: D[teams.get(name)], div: teamDiv.get(name) } : null);
  return {
    team,
    expected(div, home, away) {
      const h = team(home), a = team(away), d = divs.get(div);
      if (!h || !a || d === undefined) return null;
      return {
        h: Math.exp(O[d] + H[d] + h.a - a.d),
        a: Math.exp(O[d] + a.a - h.d),
      };
    },
    homeAdv: div => (divs.has(div) ? Math.exp(H[divs.get(div)]) : null),
  };
}

// ---- Score grid with the Dixon-Coles low-score correction --------------------
function poissonRow(l, max) {
  const r = [Math.exp(-l)];
  for (let k = 1; k <= max; k++) r.push(r[k - 1] * l / k);
  return r;
}
function tau(x, y, lh, la, rho) {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}
export function scoreGrid(lh, la, rho, max = 10) {
  const rh = poissonRow(lh, max), ra = poissonRow(la, max);
  const g = [];
  let t = 0;
  for (let x = 0; x <= max; x++) {
    g.push([]);
    for (let y = 0; y <= max; y++) {
      const p = Math.max(0, rh[x] * ra[y] * tau(x, y, lh, la, rho));
      g[x].push(p); t += p;
    }
  }
  for (const row of g) for (let y = 0; y <= max; y++) row[y] /= t;
  return g;
}
export function marketsFromGrid(g) {
  let h = 0, d = 0, a = 0, btts = 0, o15 = 0, o25 = 0, o35 = 0, csH = 0, csA = 0;
  const lines = [];
  g.forEach((row, x) => row.forEach((p, y) => {
    if (x > y) h += p; else if (x === y) d += p; else a += p;
    if (x > 0 && y > 0) btts += p;
    if (x + y > 1) o15 += p;
    if (x + y > 2) o25 += p;
    if (x + y > 3) o35 += p;
    if (y === 0) csH += p;
    if (x === 0) csA += p;
    lines.push([x, y, p]);
  }));
  lines.sort((p, q) => q[2] - p[2]);
  return { h, d, a, btts, o15, o25, o35, csH, csA, top: lines.slice(0, 3).map(([x, y, p]) => ({ h: x, a: y, p })) };
}

export function fitRho(pairs) {
  // pairs: [{lh, la, hg, ag, w}] -> rho maximising the weighted likelihood of the low scores
  let best = { rho: 0, ll: -Infinity };
  for (let r = -0.25; r <= 0.1001; r += 0.01) {
    let ll = 0;
    for (const p of pairs) {
      if (p.hg > 1 || p.ag > 1) continue;
      const t = tau(p.hg, p.ag, p.lh, p.la, r);
      if (t <= 0) { ll = -Infinity; break; }
      ll += p.w * Math.log(t);
    }
    if (ll > best.ll) best = { rho: +r.toFixed(2), ll };
  }
  return best.rho;
}

// ---- Elo ---------------------------------------------------------------------
// Ratings run through every match in date order. A team new to a division starts
// at the mean rating of the teams that left that division at the end of the
// previous season (promoted/relegated sides swap places). A team staying in its
// division keeps a share `carry` of its distance from the division mean.
export function runElo(matches, { k, hfa, carry = 1 }) {
  const R = new Map(), pre = new Map();
  const members = new Map(); // `${div}|${season}` -> Set(team)
  for (const m of matches) {
    const key = `${m.div}|${m.season}`;
    if (!members.has(key)) members.set(key, new Set());
    members.get(key).add(m.home); members.get(key).add(m.away);
  }
  const prevSeason = s => String(Number(s.slice(0, 2)) - 1).padStart(2, '0') + s.slice(0, 2);
  const seeded = new Set();
  for (const m of matches) {
    for (const t of [m.home, m.away]) {
      const tag = `${t}|${m.div}|${m.season}`;
      if (seeded.has(tag)) continue;
      seeded.add(tag);
      const last = members.get(`${m.div}|${prevSeason(m.season)}`);
      if (!R.has(t) || (last && !last.has(t))) {
        if (last) {
          const now = members.get(`${m.div}|${m.season}`);
          const left = [...last].filter(x => !now.has(x) && R.has(x));
          if (left.length) { R.set(t, left.reduce((s, x) => s + R.get(x), 0) / left.length); continue; }
        }
        if (!R.has(t)) R.set(t, 1500);
      } else if (last && carry < 1) {
        const rated = [...last].filter(x => R.has(x));
        const mu = rated.reduce((s, x) => s + R.get(x), 0) / rated.length;
        R.set(t, mu + carry * (R.get(t) - mu));
      }
    }
    const rh = R.get(m.home), ra = R.get(m.away);
    pre.set(m, { rh, ra });
    const e = 1 / (1 + 10 ** (-(rh + hfa - ra) / 400));
    const s = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
    const gd = Math.abs(m.hg - m.ag);
    const mult = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    const delta = k * mult * (s - e);
    R.set(m.home, rh + delta); R.set(m.away, ra - delta);
  }
  return { pre, current: R };
}

// Ordered logistic: P(away) = s(t1 - b*x), P(away or draw) = s(t2 - b*x), x = (rh + hfa - ra)/100
const sig = z => 1 / (1 + Math.exp(-z));
export function eloProbs(x, { b, t1, t2 }) {
  const pa = sig(t1 - b * x), pad = sig(t2 - b * x);
  return [1 - pad, pad - pa, pa];
}
export function fitEloLink(samples) {
  // samples: [{x, o}] with o 0 home / 1 draw / 2 away; plain gradient ascent on log-likelihood
  let p = { b: 0.4, t1: -0.6, t2: 0.6 };
  const lr = 0.5;
  for (let it = 0; it < 400; it++) {
    let gb = 0, g1 = 0, g2 = 0;
    for (const { x, o } of samples) {
      const pa = sig(p.t1 - p.b * x), pad = sig(p.t2 - p.b * x);
      // d/dz log s(z) = 1 - s(z); d/dz log(1 - s(z)) = -s(z)
      if (o === 2) { g1 += 1 - pa; gb += -x * (1 - pa); }
      else if (o === 0) { g2 += -pad; gb += x * pad; }
      else {
        const pd = pad - pa;
        const d2 = pad * (1 - pad), d1 = pa * (1 - pa);
        g2 += d2 / pd; g1 += -d1 / pd; gb += (-x * d2 + x * d1) / pd;
      }
    }
    const n = samples.length;
    p = { b: p.b + lr * gb / n, t1: p.t1 + lr * g1 / n, t2: Math.max(p.t1 + 0.05, p.t2 + lr * g2 / n) };
  }
  return p;
}

// ---- Ordered logistic stacker -------------------------------------------------
// Combines the component models through features rather than a fixed average:
// z = sum(b_i * x_i); P(away) = s(t1 - z), P(away or draw) = s(t2 - z).
export function orderedProbs(x, { b, t1, t2 }) {
  const z = x.reduce((s, v, i) => s + b[i] * v, 0);
  const pa = sig(t1 - z), pad = sig(t2 - z);
  return [1 - pad, pad - pa, pa];
}
export function fitOrdered(samples, { iters = 600, lr = 0.3, l2 = 1e-3 } = {}) {
  const nf = samples[0].x.length;
  let b = new Array(nf).fill(0), t1 = -0.6, t2 = 0.6;
  for (let it = 0; it < iters; it++) {
    const gb = new Array(nf).fill(0);
    let g1 = 0, g2 = 0;
    for (const { x, o } of samples) {
      const z = x.reduce((s, v, i) => s + b[i] * v, 0);
      const pa = sig(t1 - z), pad = sig(t2 - z);
      let dz;
      if (o === 2) { g1 += 1 - pa; dz = -(1 - pa); }
      else if (o === 0) { g2 += -pad; dz = pad; }
      else {
        const pd = Math.max(pad - pa, 1e-9), d2 = pad * (1 - pad), d1 = pa * (1 - pa);
        g2 += d2 / pd; g1 += -d1 / pd; dz = (-d2 + d1) / pd;
      }
      for (let i = 0; i < nf; i++) gb[i] += dz * x[i];
    }
    const n = samples.length;
    b = b.map((v, i) => v + lr * (gb[i] / n - l2 * v));
    t1 += lr * g1 / n; t2 = Math.max(t1 + 0.05, t2 + lr * g2 / n);
  }
  return { b, t1, t2 };
}
