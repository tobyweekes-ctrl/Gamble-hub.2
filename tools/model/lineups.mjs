// Lineup strength from confirmed starting XIs (ESPN data, tools/model/fetch-lineups.mjs).
//
// For a team's XI in a match, compared with its previous matches (last 8 within
// 120 days, league and Champions League):
//   reg  - regulars present: sum of the starters' recent start rates divided by
//          the sum of the 11 highest start rates. 1 = the usual XI.
//   att  - attacking share: sum of the starters' share of the team's recent
//          shots on target + assists, divided by the same sum for the team's
//          usual XI (its 11 most-used players). 1 = usual attacking output on the pitch.
//   gk   - the starting goalkeeper started fewer than half of the recent matches.
// The effect of these on goals is measured in tools/model/backtest.mjs; nothing
// here assumes a size.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { GROUPS } from './data.mjs';

const DAY = 864e5;
const LEAGUE_DIV = { 'eng.1': 'E0', 'eng.2': 'E1', 'ger.1': 'D1', 'ita.1': 'I1', 'fra.1': 'F1', 'uefa.champions': 'UCL' };

export function loadLineups(rawDir, { includeUpcoming = false } = {}) {
  const dir = path.join(rawDir, 'lineups');
  const out = [];
  for (const league of Object.keys(LEAGUE_DIV)) {
    const f = path.join(dir, `${league}.json`);
    if (!existsSync(f)) continue;
    for (const m of Object.values(JSON.parse(readFileSync(f, 'utf8')))) out.push({ ...m, div: LEAGUE_DIV[league], t: Date.parse(m.date) });
  }
  const up = path.join(dir, 'upcoming.json');
  if (includeUpcoming && existsSync(up)) {
    for (const m of JSON.parse(readFileSync(up, 'utf8'))) out.push({ ...m, div: LEAGUE_DIV[m.league], t: Date.parse(m.date), upcoming: true });
  }
  return out.sort((a, b) => a.t - b.t);
}

// History of each ESPN team's lineups, oldest first.
export function teamHistory(lineups) {
  const h = new Map();
  for (const m of lineups) {
    for (const side of ['home', 'away']) {
      const t = m[side];
      if (!t || m.upcoming) continue;
      if (!h.has(t.id)) h.set(t.id, []);
      h.get(t.id).push({ t: m.t, players: t.players });
    }
  }
  return h;
}

export function lineupFeatures(hist, team, t) {
  if (!team) return null;
  const past = (hist.get(team.id) || []).filter(x => x.t < t - 3600e3 && t - x.t < 120 * DAY).slice(-8);
  if (past.length < 4) return null;
  const starts = new Map(), contrib = new Map();
  let total = 0;
  for (const g of past) for (const p of g.players) {
    if (p.start) starts.set(p.id, (starts.get(p.id) || 0) + 1);
    const c = p.sot + p.a;
    if (c) { contrib.set(p.id, (contrib.get(p.id) || 0) + c); total += c; }
  }
  const rate = id => (starts.get(id) || 0) / past.length;
  const share = id => (total ? (contrib.get(id) || 0) / total : 0);
  const usual = [...starts.keys()].sort((a, b) => rate(b) - rate(a)).slice(0, 11);
  const xi = team.players.filter(p => p.start);
  const usualRate = usual.reduce((s, id) => s + rate(id), 0);
  const usualShare = usual.reduce((s, id) => s + share(id), 0);
  const gkStarter = xi.find(p => p.pos === 'G');
  return {
    reg: usualRate ? xi.reduce((s, p) => s + rate(p.id), 0) / usualRate : 1,
    att: usualShare ? xi.reduce((s, p) => s + share(p.id), 0) / usualShare : 1,
    gk: gkStarter ? rate(gkStarter.id) < 0.5 : false,
    n: past.length,
  };
}

// The team's usual XI (11 highest recent start rates) and which of them are not
// in this XI. For display alongside the features.
export function missingRegulars(hist, team, t) {
  const past = (hist.get(team.id) || []).filter(x => x.t < t - 3600e3 && t - x.t < 120 * DAY).slice(-8);
  if (past.length < 4) return null;
  const starts = new Map(), names = new Map();
  for (const g of past) for (const p of g.players) { names.set(p.id, p.name); if (p.start) starts.set(p.id, (starts.get(p.id) || 0) + 1); }
  const usual = [...starts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 11);
  const xi = new Set(team.players.filter(p => p.start).map(p => p.id));
  return usual.filter(([id]) => !xi.has(id)).map(([id, n]) => ({ name: names.get(id), started: `${n}/${past.length}` }));
}

// A team's probable XI before team sheets are out: its 11 most-started players in
// the last 8 matches (within 120 days), with the position each last played.
export function usualXI(hist, teamId, t) {
  const past = (hist.get(String(teamId)) || []).filter(x => x.t < t - 3600e3 && t - x.t < 120 * DAY).slice(-8);
  if (past.length < 4) return null;
  const starts = new Map(), info = new Map();
  for (const g of past) for (const p of g.players) {
    if (!p.start) continue;
    starts.set(p.id, (starts.get(p.id) || 0) + 1);
    info.set(p.id, { id: p.id, name: p.name, pos: p.pos });
  }
  return [...starts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 11)
    .map(([id, n]) => ({ ...info.get(id), started: `${n}/${past.length}` }));
}

// Match ESPN fixtures to football-data matches: same division, kick-off within a
// day, and team names that agree on at least one word (ESPN and football-data
// spell clubs differently). Returns Map(fdMatch -> espnMatch).
const words = s => new Set(s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/)
  .filter(w => w.length > 2 && !['fc', 'afc', 'city', 'united', 'town', 'the'].includes(w)));
const ALIAS = {
  'Man United': 'Manchester United', 'Man City': 'Manchester City', "Nott'm Forest": 'Nottingham Forest', Wolves: 'Wolverhampton',
  'Sheffield United': 'Sheffield United', QPR: 'Queens Park Rangers', 'West Brom': 'West Bromwich', Inter: 'Internazionale',
  Milan: 'AC Milan', 'Paris SG': 'Paris Saint-Germain', "M'gladbach": 'Monchengladbach', 'Ein Frankfurt': 'Eintracht Frankfurt',
  'FC Koln': 'Cologne Koln', Dortmund: 'Borussia Dortmund', Leverkusen: 'Bayer Leverkusen', Hamburg: 'Hamburg SV',
  Spurs: 'Tottenham', Rennes: 'Stade Rennais Rennes', 'Sheffield Weds': 'Sheffield Wednesday', Mainz: 'Mainz', Paderborn: 'Paderborn',
};
const fdWords = n => words(ALIAS[n] || n);
export function joinLineups(fdMatches, lineups) {
  const byDay = new Map();
  for (const l of lineups) {
    if (l.upcoming) continue;
    const k = `${l.div}|${Math.floor(l.t / DAY)}`;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(l);
  }
  const out = new Map();
  for (const m of fdMatches) {
    const day = Math.floor(m.date / DAY);
    let best = null;
    for (const d of [day, day - 1, day + 1]) for (const l of byDay.get(`${m.div}|${d}`) || []) {
      const sh = [...fdWords(m.home)].filter(w => words(l.homeName).has(w)).length;
      const sa = [...fdWords(m.away)].filter(w => words(l.awayName).has(w)).length;
      if (sh && sa && (!best || sh + sa > best.s)) best = { l, s: sh + sa };
    }
    if (best) out.set(m, best.l);
  }
  return out;
}

// Multipliers on (home, away) expected goals from both XIs' features and the
// effect sizes measured by the backtest (data/model/context.json -> lineup):
// goals scored scale with the share of regulars starting, goals conceded with
// the share of regulars (delta) and a back-up goalkeeper (kappa).
export function lineupMultipliers(fh, fa, L) {
  if (!L || !fh || !fa) return { h: 1, a: 1 };
  const scored = f => (f.reg / L.regRef) ** L.gamma;
  const conceded = f => (f.reg / L.regRef) ** (-L.delta) * (f.gk ? L.kappa : 1);
  return { h: scored(fh) * conceded(fa), a: scored(fa) * conceded(fh) };
}

export function fitLineupEffects(rows) {
  // rows: [{ lh, la, hg, ag, fh, fa }] -> gamma, delta, kappa maximising the Poisson likelihood
  const v = rows.flatMap(r => [r.fh.reg, r.fa.reg]).sort((a, b) => a - b);
  const regRef = v[Math.floor(v.length / 2)];
  const ll = L => {
    let s = 0;
    for (const r of rows) {
      const m = lineupMultipliers(r.fh, r.fa, L);
      const a = r.lh * m.h, b = r.la * m.a;
      s += r.hg * Math.log(a) - a + r.ag * Math.log(b) - b;
    }
    return s;
  };
  let best = null;
  for (let gamma = 0; gamma <= 0.8001; gamma += 0.05)
    for (let delta = 0; delta <= 0.8001; delta += 0.05)
      for (let kappa = 1; kappa <= 1.15001; kappa += 0.025) {
        const L = { regRef, gamma: +gamma.toFixed(2), delta: +delta.toFixed(2), kappa: +kappa.toFixed(3) };
        const val = ll(L);
        if (!best || val > best.val) best = { L, val };
      }
  return best.L;
}
