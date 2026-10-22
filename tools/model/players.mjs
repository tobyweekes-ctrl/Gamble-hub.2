// Player model for shots, shots on target, fouls committed, fouls won and bookings.
//
// For each player, a rate per start: his own totals over the last 365 days shrunk
// towards the average for his position group in that competition (a gamma-Poisson
// estimate: (own total + k x group mean) / (own starts + k)). For a given match
// the rate is scaled by the match context:
//   shots / shots on target  x  team's expected shots this match / team's average
//   fouls committed, booked  x  team's expected fouls this match / team's average
//   fouls won                x  opponent's expected fouls / opponent's average
// and the count is negative binomial with dispersion r (Poisson as r -> infinity).
// k and r are fitted on the validation seasons in tools/model/backtest-players.mjs.

const DAY = 864e5;
export const STATS = ['sh', 'sot', 'fc', 'fw', 'yc'];
export const MARKETS = [
  { key: 'sot1', stat: 'sot', atLeast: 1, label: '1+ shots on target' },
  { key: 'sh2', stat: 'sh', atLeast: 2, label: '2+ shots' },
  { key: 'fc1', stat: 'fc', atLeast: 1, label: '1+ fouls committed' },
  { key: 'fw1', stat: 'fw', atLeast: 1, label: '1+ fouls won' },
  { key: 'yc1', stat: 'yc', atLeast: 1, label: 'booked' },
];
const CONTEXT = { sh: 'shots', sot: 'shots', fc: 'fouls', yc: 'fouls', fw: 'oppFouls' };

export function groupOf(pos) {
  if (pos === 'G') return 'G';
  if (/^(CD|LB|RB|D|LWB|RWB|SW|CB)/.test(pos)) return 'D';
  if (/^(DM|CM|AM|LM|RM|M)/.test(pos)) return 'M';
  return 'F';
}

// Player totals over [asOf - 365 days, asOf), starts only.
export function playerTable(lineups, asOf) {
  const players = new Map(), group = new Map();
  for (const m of lineups) {
    if (m.upcoming || m.t >= asOf || asOf - m.t > 365 * DAY) continue;
    for (const side of ['home', 'away']) for (const p of m[side].players) {
      if (!p.start) continue;
      const g = `${m.div}|${groupOf(p.pos)}`;
      const add = (map, key, init) => { if (!map.has(key)) map.set(key, init()); return map.get(key); };
      const pl = add(players, p.id, () => ({ id: p.id, name: p.name, n: 0, nStat: Object.fromEntries(STATS.map(s => [s, 0])), sum: Object.fromEntries(STATS.map(s => [s, 0])), groups: {} }));
      const gr = add(group, g, () => ({ n: Object.fromEntries(STATS.map(s => [s, 0])), sum: Object.fromEntries(STATS.map(s => [s, 0])) }));
      pl.n++; pl.name = p.name; pl.groups[g] = (pl.groups[g] || 0) + 1; pl.lastPos = p.pos;
      for (const s of STATS) {
        if (p[s] === undefined) continue; // stat missing from the source for this match
        pl.nStat[s]++; pl.sum[s] += p[s]; gr.n[s]++; gr.sum[s] += p[s];
      }
    }
  }
  return { players, group };
}

export function rateFor(table, playerId, div, pos, stat, k) {
  const g = table.group.get(`${div}|${groupOf(pos)}`) || table.group.get(`UCL|${groupOf(pos)}`);
  const prior = g && g.n[stat] ? g.sum[stat] / g.n[stat] : 0;
  const pl = table.players.get(playerId);
  const n = pl ? pl.nStat[stat] : 0, s = pl ? pl.sum[stat] : 0;
  return { rate: (s + k * prior) / (n + k), starts: n };
}

// P(X >= a) for a negative binomial with mean mu and dispersion r.
export function atLeast(mu, a, r) {
  if (mu <= 0) return 0;
  if (!isFinite(r)) { let p = Math.exp(-mu), c = p; for (let x = 1; x < a; x++) { p *= mu / x; c += p; } return 1 - c; }
  const q = r / (r + mu);
  let p = q ** r, c = p;
  for (let x = 1; x < a; x++) { p *= (x - 1 + r) / x * (1 - q); c += p; }
  return Math.max(0, 1 - c);
}

// ctx: { shots, fouls, oppFouls } ratios (1 = an average match for this team).
export function playerProps(table, player, div, ctx, params) {
  const out = { exp: {}, p: {} };
  for (const s of STATS) {
    const { rate, starts } = rateFor(table, player.id, div, player.pos, s, params.k[s]);
    out.exp[s] = rate * (ctx[CONTEXT[s]] || 1);
    out.starts = starts;
  }
  for (const mk of MARKETS) out.p[mk.key] = atLeast(out.exp[mk.stat], mk.atLeast, params.r[mk.stat]);
  return out;
}
