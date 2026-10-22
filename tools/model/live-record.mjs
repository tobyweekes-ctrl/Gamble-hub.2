// The model's live record: predictions logged before kick-off (data/ledger.json),
// graded against final scores. Win/draw/loss, BTTS and Over 2.5, for our model
// and, on the games where bookmaker prices were logged, for Bet365 on the same
// games. Small samples say little; the site shows the sample size with each figure.
const EURO = /Europa|Conference|Champions League/;
const pct1 = x => +(x * 100).toFixed(1);

function scoreSet(rows) {
  const out = { n: rows.length };
  if (!rows.length) return out;
  const x12 = (get) => {
    const rs = rows.filter(r => get(r));
    if (!rs.length) return null;
    let brier = 0, ll = 0, fav = 0;
    for (const r of rs) {
      const p = get(r), y = r.y;
      const v = [p.h, p.d, p.a].map(x => x / 100), s = v[0] + v[1] + v[2];
      const q = v.map(x => x / s);
      brier += q.reduce((t, x, i) => t + (x - (i === y)) ** 2, 0);
      ll -= Math.log(Math.max(q[y], 1e-6));
      fav += q.indexOf(Math.max(...q)) === y;
    }
    return { n: rs.length, favouriteWon: pct1(fav / rs.length), brier: +(brier / rs.length).toFixed(3), logloss: +(ll / rs.length).toFixed(3) };
  };
  const two = (getP, won) => {
    const rs = rows.filter(r => getP(r) != null);
    if (!rs.length) return null;
    let ll = 0, right = 0;
    for (const r of rs) { const p = Math.min(Math.max(getP(r) / 100, 1e-6), 1 - 1e-6), w = won(r); ll -= Math.log(w ? p : 1 - p); right += (p > 0.5) === w; }
    return { n: rs.length, callRight: pct1(right / rs.length), logloss: +(ll / rs.length).toFixed(3) };
  };
  const priced = rows.filter(r => r.e.market && r.e.market.h != null);
  out.model = { x12: x12(r => r.e.goalModel), btts: two(r => r.e.modelMarkets?.btts, r => r.btts), ou25: two(r => r.e.modelMarkets?.ou25, r => r.o25) };
  out.paired = priced.length ? {
    n: priced.length,
    model: { x12: x12.call(null, r => priced.includes(r) && r.e.goalModel), btts: two(r => priced.includes(r) && r.e.btts != null ? r.e.modelMarkets?.btts : null, r => r.btts), ou25: two(r => priced.includes(r) && r.e.ou25 != null ? r.e.modelMarkets?.ou25 : null, r => r.o25) },
    bet365: { x12: x12(r => priced.includes(r) && r.e.market), btts: two(r => priced.includes(r) ? r.e.btts : null, r => r.btts), ou25: two(r => priced.includes(r) ? r.e.ou25 : null, r => r.o25) },
  } : null;
  // Rates in this sample, for reference ("always say no BTTS" etc.)
  out.rates = { homeWin: pct1(rows.filter(r => r.y === 0).length / rows.length), draw: pct1(rows.filter(r => r.y === 1).length / rows.length),
    btts: pct1(rows.filter(r => r.btts).length / rows.length), over25: pct1(rows.filter(r => r.o25).length / rows.length) };
  return out;
}

export function liveRecord(ledger) {
  // One entry per fixture: the latest logged before kick-off, from the independent model.
  const best = new Map();
  for (const e of ledger) {
    if (!e.result || !e.goalModel || !/^independent/.test(e.modelVersion || '')) continue;
    if (Date.parse(e.loggedAt) >= Date.parse(e.kickoff)) continue;
    const cur = best.get(e.id);
    if (!cur || e.loggedAt > cur.loggedAt) best.set(e.id, e);
  }
  const rows = [...best.values()].map(e => {
    const { home: hg, away: ag } = e.result;
    return { e, y: hg > ag ? 0 : hg === ag ? 1 : 2, btts: hg > 0 && ag > 0, o25: hg + ag > 2 };
  }).sort((a, b) => Date.parse(b.e.kickoff) - Date.parse(a.e.kickoff));
  const games = rows.slice(0, 80).map(({ e, y, btts, o25 }) => {
    const g = e.goalModel, mm = e.modelMarkets || {};
    const pick = [g.h, g.d, g.a].indexOf(Math.max(g.h, g.d, g.a));
    return { id: e.id, league: e.league, fixture: e.fixture, kickoff: e.kickoff, score: [e.result.home, e.result.away],
      model: g, pick, pickRight: pick === y, btts: mm.btts ?? null, bttsRight: mm.btts == null ? null : (mm.btts > 50) === btts,
      ou25: mm.ou25 ?? null, ouRight: mm.ou25 == null ? null : (mm.ou25 > 50) === o25, confidence: e.confidence || null,
      priced: !!(e.market && e.market.h != null) };
  });
  return {
    updated: new Date().toISOString(),
    overall: scoreSet(rows),
    league: scoreSet(rows.filter(r => !EURO.test(r.e.league))),
    european: scoreSet(rows.filter(r => EURO.test(r.e.league))),
    games,
  };
}
