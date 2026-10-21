// Calibration of the ensemble's probabilities, fitted on validation seasons.
// 1X2: q_i proportional to (p_i * k_i)^T, with a temperature T (T > 1 sharpens)
// and a draw multiplier k_draw. Two-way markets: logit(q) = a + b * logit(p).
// Without it the ensemble was too cautious at the extremes (strong favourites won
// more often than it said), which shows up as false "value" on outsiders.

export function calibrate1x2(p, { T, kd }) {
  const q = [p[0] ** T, (p[1] * kd) ** T, p[2] ** T];
  const s = q[0] + q[1] + q[2];
  return q.map(x => x / s);
}
const logit = p => Math.log(p / (1 - p));
const sig = z => 1 / (1 + Math.exp(-z));
export function calibrate2(p, { a, b }) {
  const c = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
  return sig(a + b * logit(c));
}

// rows: [{ p: {h, d, a, btts, o25}, m: match }]
export function fitCalibration(rows) {
  const o = r => (r.m.hg > r.m.ag ? 0 : r.m.hg === r.m.ag ? 1 : 2);
  let x12 = null;
  for (let T = 0.8; T <= 1.8001; T += 0.02) {
    for (let kd = 0.8; kd <= 1.2001; kd += 0.02) {
      let ll = 0;
      for (const r of rows) ll -= Math.log(calibrate1x2([r.p.h, r.p.d, r.p.a], { T, kd })[o(r)]);
      if (!x12 || ll < x12.ll) x12 = { T: +T.toFixed(2), kd: +kd.toFixed(2), ll };
    }
  }
  const two = (get, won) => {
    let best = null;
    for (let a = -0.3; a <= 0.3001; a += 0.02) {
      for (let b = 0.7; b <= 1.8001; b += 0.02) {
        let ll = 0;
        for (const r of rows) { const q = calibrate2(get(r), { a, b }); ll -= Math.log(won(r) ? q : 1 - q); }
        if (!best || ll < best.ll) best = { a: +a.toFixed(2), b: +b.toFixed(2), ll };
      }
    }
    return { a: best.a, b: best.b };
  };
  return {
    x12: { T: x12.T, kd: x12.kd },
    btts: two(r => r.p.btts, r => r.m.hg > 0 && r.m.ag > 0),
    o25: two(r => r.p.o25, r => r.m.hg + r.m.ag > 2),
  };
}
