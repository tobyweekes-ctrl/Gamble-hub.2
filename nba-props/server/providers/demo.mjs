// Deterministic synthetic league for offline development and for this repo's tests.
// Fictional players on the real 30 teams. It fills the same shapes as the live providers (season
// box scores, schedule, injuries, prop lines) and is used only when STATS_PROVIDER=demo.
// The generator has real structure the model should find: team pace, defence by position,
// home edge, back-to-back fatigue, blowout minutes, injury absences and returns.
import { TEAMS } from '../teams.mjs';
import { addDays, seasonStartYear, daysBetween } from '../util.mjs';
import { STATS, STAT_KEYS, statValue } from '../stats.mjs';

// ---------- seeded randomness ----------
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let a = typeof seed === 'number' ? seed : hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const uni = (r, a, b) => a + (b - a) * r();
function poisson(r, lam) {
  if (lam <= 0) return 0;
  if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * normal(r)));
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}
function gamma(r, shape) { // Marsaglia-Tsang, shape >= 1
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(r); v = 1 + c * x; } while (v <= 0);
    v = v ** 3;
    if (Math.log(r()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
// negative binomial as gamma-Poisson mixture with dispersion k (var = mu + mu^2/k)
const negbin = (r, mu, k) => poisson(r, mu * gamma(r, k) / k);
const shuffle = (r, a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- league construction ----------
const FIRST = ['Marcus','Jalen','Tyrese','Darius','Andre','Malik','Isaiah','Cameron','Jordan','Elijah','Trey','Devin','Keon','Javon','Miles','Xavier','Bryce','Caleb','Damon','Felix','Gavin','Hugo','Ivan','Jonas','Kofi','Luka','Mateo','Nikola','Omar','Pascal','Quentin','Rashad','Silas','Tobias','Umar','Victor','Wendell','Yusuf','Zion','Amari','Bennett','Cormac','Dillon','Emeka','Franco','Grant','Hassan','Idris','Jaylen','Kendrick','Lorenzo','Moses','Nolan','Orlando','Reggie','Santiago','Terrance','Vince','Wes','Ade'];
const LAST = ['Okafor','Hartley','Vance','Delgado','Whitmore','Kessler','Mbeki','Lindqvist','Barros','Calloway','Dunleavy','Ellison','Fairbanks','Garrison','Holloway','Ibarra','Jefferies','Kowalski','Langford','Moreau','Nakamura','Osei','Pruitt','Quarles','Rasmussen','Sandoval','Thibault','Umeh','Varga','Wexler','Yancey','Zeller','Abernathy','Brightman','Castellanos','Draper','Eriksen','Fontaine','Gallardo','Haddad','Ingram-Cole','Jovanovic','Kimura','Lockhart','Mwangi','Novak','Ortega','Petrov','Rhodes','Stroud','Tanaka','Underwood','Valdez','Whitfield','Achebe','Bianchi','Coleman','Dragic','Edwards-Hill','Ferreira','Greer','Halvorsen','Iwu','Jansen','Kaplan','Lemaire','Marchetti','Nwosu','Oyelaran','Pellegrini','Quigley','Royce','Sato','Toure','Ulrich','Vasquez','Wainwright','Yilmaz','Zubac-Ray','Ashworth'];

const SLOTS = [ // [position string, group, base minutes range, starter]
  ['G', 'G', [32, 36], true], ['G-F', 'G', [29, 34], true], ['F', 'F', [28, 34], true],
  ['F-C', 'F', [26, 32], true], ['C', 'C', [26, 32], true],
  ['G', 'G', [16, 24], false], ['G', 'G', [12, 19], false], ['F', 'F', [14, 22], false],
  ['F', 'F', [10, 17], false], ['C', 'C', [12, 18], false],
];
const RATE36 = { // per-36 ranges by group: [pts, reb, ast, fg3m]
  G: [[14, 26], [3.2, 5.5], [4.5, 9], [1.6, 3.6]],
  F: [[12, 23], [5.5, 8.5], [2, 4.5], [1, 2.6]],
  C: [[11, 21], [9.5, 13.5], [1.5, 4], [0, 1.1]],
};
const STYLES = ['drop', 'switch', 'rim-protect', 'aggressive', 'balanced'];

let LEAGUE;
function league() {
  if (LEAGUE) return LEAGUE;
  const r = rng('demo-league-v1');
  const used = new Set();
  const players = [];
  const teams = {};
  let pid = 1000;
  for (const t of TEAMS) {
    const style = STYLES[Math.floor(r() * STYLES.length)];
    // defensive multipliers by opponent position group and stat (1 = league average)
    const d = (base) => Object.fromEntries(['pts', 'reb', 'ast', 'fg3m'].map((s) => [s, base * uni(r, 0.95, 1.05)]));
    const def = { G: d(uni(r, 0.92, 1.08)), F: d(uni(r, 0.92, 1.08)), C: d(uni(r, 0.92, 1.08)) };
    if (style === 'rim-protect') { def.C.pts *= 0.88; def.C.reb *= 0.94; def.G.fg3m *= 1.06; }
    if (style === 'drop') { def.G.fg3m *= 1.1; def.G.pts *= 1.05; def.C.pts *= 0.96; }
    if (style === 'switch') { def.G.pts *= 0.92; def.G.ast *= 0.93; def.C.pts *= 1.05; def.C.reb *= 1.04; }
    if (style === 'aggressive') { def.G.ast *= 0.92; def.F.pts *= 1.04; def.C.reb *= 1.07; }
    teams[t.abbr] = { abbr: t.abbr, pace: uni(r, 96, 104.5), strength: normal(r) * 4, style, def };
    const starIdx = Math.floor(r() * 3);
    SLOTS.forEach(([pos, group, [mlo, mhi], starter], i) => {
      let name;
      do { name = `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`; } while (used.has(name));
      used.add(name);
      const star = i === starIdx;
      const [p, rb, a, f3] = RATE36[group];
      const boost = star ? 1.35 : 1;
      players.push({
        id: `d${pid++}`, name, team: t.abbr, pos, group, starter,
        baseMin: uni(r, mlo, mhi) + (star ? 2 : 0),
        rate: { pts: uni(r, ...p) * boost, reb: uni(r, ...rb) * (star ? 1.1 : 1), ast: uni(r, ...a) * (star ? 1.2 : 1), fg3m: uni(r, ...f3) * (star ? 1.15 : 1) },
        consistency: uni(r, 0.7, 1.3), // scales game-to-game noise
      });
    });
  }
  LEAGUE = { players, teams, byId: new Map(players.map((p) => [p.id, p])) };
  return LEAGUE;
}

// ---------- calendar ----------
const SEASON_DATES = { open: '10-21', close: '04-12' };
function seasonCalendar(season) {
  const y = seasonStartYear(season);
  const start = `${y}-${SEASON_DATES.open}`;
  const end = `${y + 1}-${SEASON_DATES.close}`;
  const r = rng(`cal-${season}`);
  const lastPlayed = {}; const streak = {};
  const days = [];
  for (let d = start, i = 0; d <= end; d = addDays(d, 1), i++) {
    if (d.endsWith('-12-24')) continue;
    const n = Math.floor(uni(r, 4, 10));
    const pool = shuffle(r, TEAMS.map((t) => t.abbr)).filter((t) => !(streak[t] >= 2 && lastPlayed[t] === addDays(d, -1)));
    // teams that haven't played for longest go first, so games are spread evenly
    pool.sort((a, b) => (lastPlayed[a] || '') .localeCompare(lastPlayed[b] || ''));
    const playing = pool.slice(0, n * 2);
    const games = [];
    for (let k = 0; k + 1 < playing.length; k += 2) {
      const [home, away] = r() < 0.5 ? [playing[k], playing[k + 1]] : [playing[k + 1], playing[k]];
      games.push({ gameId: `${y}${String(i).padStart(3, '0')}${String(k / 2).padStart(2, '0')}`, date: d, home, away });
      for (const t of [home, away]) {
        streak[t] = lastPlayed[t] === addDays(d, -1) ? (streak[t] || 1) + 1 : 1;
        lastPlayed[t] = d;
      }
    }
    days.push({ date: d, games });
  }
  return days;
}

// injury spells: playerId -> [{from, to}] game indices (inclusive) within the team's season games
function injurySpells(season, teamGames) {
  const r = rng(`inj-${season}`);
  const out = new Map();
  for (const p of league().players) {
    const n = teamGames[p.team].length;
    if (n < 10 || r() > 0.35) continue;
    const len = Math.floor(uni(r, 2, 14));
    const from = Math.floor(uni(r, 0, n - len));
    out.set(p.id, [{ from, to: from + len - 1 }]);
  }
  return out;
}

// Scripted storylines for the current season so injury/return paths always appear.
// Indexed by roster slot so they're stable: [teamIndex, slot, kind]
const STORY = [
  [13, 0, 'returning'], [9, 4, 'returning'], [2, 1, 'returning'], [21, 2, 'returning'],
  [5, 3, 'out'], [16, 0, 'out'], [27, 4, 'out'], [11, 1, 'questionable'], [24, 2, 'questionable'],
  [6, 5, 'dtd'],
];
const storyPlayer = ([ti, slot]) => league().players[ti * SLOTS.length + slot];

const cache = new Map();
function simulateSeason(season, today) {
  const key = `${season}|${today}`;
  if (cache.has(key)) return cache.get(key);
  const L = league();
  const cal = seasonCalendar(season);
  const played = cal.filter((d) => d.date < today).flatMap((d) => d.games);
  const isCurrent = cal.length && cal[0].date <= today && today <= cal[cal.length - 1].date;

  const teamGames = Object.fromEntries(TEAMS.map((t) => [t.abbr, []]));
  for (const g of played) { teamGames[g.home].push(g); teamGames[g.away].push(g); }
  const spells = injurySpells(season, teamGames);
  if (isCurrent) {
    for (const s of STORY) {
      const p = storyPlayer(s);
      const n = teamGames[p.team].length;
      if (s[2] === 'returning') spells.set(p.id, [{ from: 0, to: Math.max(0, n - 3) }]); // back for last 2
      else if (s[2] === 'out') spells.set(p.id, [{ from: Math.max(0, n - 3), to: n - 1 }]);
      else spells.delete(p.id);
    }
  }
  const absent = (p, idx) => (spells.get(p.id) || []).some((s) => idx >= s.from && idx <= s.to);

  const r = rng(`box-${season}`);
  const rows = [];
  const lastDate = {};
  for (const g of played) {
    const idx = { [g.home]: teamGames[g.home].indexOf(g), [g.away]: teamGames[g.away].indexOf(g) };
    const H = L.teams[g.home], A = L.teams[g.away];
    const margin = H.strength - A.strength + 2.5 + normal(r) * 12;
    const blowout = Math.abs(margin) > 18;
    const pace = (H.pace + A.pace) / 2;
    for (const side of [g.home, g.away]) {
      const home = side === g.home;
      const opp = home ? g.away : g.home;
      const O = L.teams[opp];
      const b2b = lastDate[side] === addDays(g.date, -1);
      const roster = L.players.filter((p) => p.team === side && !absent(p, idx[side]));
      // redistribute missing minutes over the available players
      const missing = L.players.filter((p) => p.team === side).reduce((s, p) => s + p.baseMin, 0) - roster.reduce((s, p) => s + p.baseMin, 0);
      const totalAvail = roster.reduce((s, p) => s + p.baseMin, 0);
      const mins = roster.map((p) => {
        let m = p.baseMin * (1 + missing / totalAvail * 0.85) + normal(r) * 3.2 * p.consistency;
        if (b2b) m *= 0.96;
        if (blowout) m *= p.starter ? 0.86 : 1.25;
        return Math.max(4, Math.min(44, m));
      });
      const scale = 240 / mins.reduce((a, b) => a + b, 0); // team minutes always add up to 240
      for (const [j, p] of roster.entries()) {
        const min = Math.min(46, mins[j] * scale);
        const form = Math.exp(normal(r) * 0.12 * p.consistency);
        const env = (min / 36) * (pace / 100) * 0.9 * (home ? 1.02 : 0.98) * (b2b ? 0.97 : 1) * form;
        const mu = (s) => p.rate[s] * env * O.def[p.group][s];
        const pts = negbin(r, mu('pts'), 16 / p.consistency);
        const reb = negbin(r, mu('reb'), 20 / p.consistency);
        const ast = negbin(r, mu('ast'), 16 / p.consistency);
        const fg3m = poisson(r, mu('fg3m'));
        const fg3a = Math.max(fg3m, Math.round(fg3m / uni(r, 0.3, 0.42)));
        const fta = Math.max(0, Math.round(pts * uni(r, 0.1, 0.26)));
        const ftm = Math.min(fta, Math.round(fta * uni(r, 0.7, 0.88)));
        const fgm = Math.max(fg3m, Math.round((pts - ftm - fg3m) / 2));
        const fga = Math.max(fgm, Math.round(fgm / uni(r, 0.47, 0.55)));
        const oreb = Math.round(reb * (p.group === 'C' ? 0.36 : 0.22));
        rows.push({
          playerId: p.id, gameId: g.gameId, date: g.date, team: side, opp, home,
          min: Math.round(min * 10) / 10, pts, reb, ast, fg3m, fg3a, fgm, fga, ftm, fta,
          oreb, dreb: reb - oreb, tov: poisson(r, (p.rate.ast * 0.3 + 0.5) * min / 36),
          stl: poisson(r, 0.9 * min / 36), blk: poisson(r, (p.group === 'C' ? 1.6 : 0.4) * min / 36),
          pf: poisson(r, 2.4 * min / 36), pm: 0,
        });
      }
    }
    lastDate[g.home] = g.date; lastDate[g.away] = g.date;
  }
  // final margins -> plus/minus (team-level, good enough for demo)
  const totals = new Map();
  for (const row of rows) totals.set(`${row.gameId}|${row.team}`, (totals.get(`${row.gameId}|${row.team}`) || 0) + row.pts);
  for (const row of rows) row.pm = Math.round(((totals.get(`${row.gameId}|${row.team}`) - totals.get(`${row.gameId}|${row.opp}`)) * row.min) / 48);

  // returning players also sat out the end of the previous season
  if (!isCurrent && today > cal[cal.length - 1]?.date) {
    const cur = STORY.filter((s) => s[2] === 'returning').map((s) => storyPlayer(s).id);
    const cutoff = addDays(cal[cal.length - 1].date, -20);
    for (let i = rows.length - 1; i >= 0; i--) if (cur.includes(rows[i].playerId) && rows[i].date > cutoff) rows.splice(i, 1);
  }
  const out = { cal, rows, isCurrent };
  cache.set(key, out);
  return out;
}

// ---------- provider ----------
export function demoProvider(today) {
  return {
    name: 'demo',
    async loadSeason(season) {
      const { rows } = simulateSeason(season, today);
      const players = league().players.map(({ id, name, team, pos }) => ({ id, name, team, pos }));
      return { season, source: 'demo', players, games: rows };
    },
    async schedule(date) {
      const season = seasonFor(date);
      const day = seasonCalendar(season).find((d) => d.date === date);
      return (day?.games || []).map((g, i) => ({
        gameId: g.gameId, date, home: g.home, away: g.away, status: 'Scheduled',
        tipoff: new Date(Date.parse(`${date}T23:00:00Z`) + (i % 4) * 1800000).toISOString(),
      }));
    },
  };
}
const seasonFor = (date) => { const y = Number(date.slice(0, 4)); const m = Number(date.slice(5, 7)); const s = m >= 8 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

export function demoInjuries() {
  const statusFor = { out: 'Out', questionable: 'Questionable', dtd: 'Day-To-Day' };
  const injuries = ['Left ankle sprain', 'Right hamstring strain', 'Lower back soreness', 'Left knee contusion', 'Right calf tightness', 'Illness'];
  return STORY.filter((s) => statusFor[s[2]]).map((s, i) => {
    const p = storyPlayer(s);
    return { name: p.name, team: p.team, status: statusFor[s[2]], injury: injuries[i % injuries.length], returnDate: null, updated: null, note: 'Demo injury report entry.', source: 'demo' };
  });
}

const BOOKS = [
  ['draftkings', 'DraftKings'], ['fanduel', 'FanDuel'], ['betmgm', 'BetMGM'],
  ['williamhill_us', 'Caesars'], ['espnbet', 'ESPN BET'],
];

/** Prop lines for one demo game, priced off the player's recent form (as a book roughly would). */
export function demoEventProps(gameId, date) {
  const season = seasonFor(date);
  const sim = simulateSeason(season, date);
  const prev = simulateSeason(`${seasonStartYear(season) - 1}-${String(seasonStartYear(season) % 100).padStart(2, '0')}`, date);
  const game = seasonCalendar(season).find((d) => d.date === date)?.games.find((g) => g.gameId === gameId);
  if (!game) return [];
  const r = rng(`odds-${gameId}`);
  const injured = new Set(demoInjuries().filter((i) => i.status === 'Out').map((i) => i.name));
  const out = [];
  for (const p of league().players.filter((x) => x.team === game.home || x.team === game.away)) {
    if (injured.has(p.name)) continue;
    const logs = [...prev.rows, ...sim.rows].filter((x) => x.playerId === p.id).slice(-25);
    if (logs.length < 5 || logs.slice(-5).reduce((s, x) => s + x.min, 0) / 5 < 16) continue;
    for (const stat of STAT_KEYS) {
      const vals = logs.map((x) => statValue(x, stat));
      const w = vals.map((_, i) => 0.9 ** (vals.length - 1 - i));
      const avg = vals.reduce((s, v, i) => s + v * w[i], 0) / w.reduce((a, b) => a + b, 0);
      if (avg < (stat === 'fg3m' ? 0.6 : 2)) continue;
      const fair = avg * (1 + normal(r) * 0.04);
      const nBooks = 2 + Math.floor(r() * (BOOKS.length - 1));
      for (const [book, bookTitle] of shuffle(r, [...BOOKS]).slice(0, nBooks)) {
        const line = Math.max(0.5, Math.floor(fair + normal(r) * (stat === 'fg3m' ? 0.25 : 0.6)) + 0.5);
        const lean = (fair - line) / Math.max(1, Math.sqrt(fair)) * 0.35 + normal(r) * 0.015; // >0 means over favoured
        const pOver = Math.min(0.75, Math.max(0.25, 0.5 + lean));
        const vig = uni(r, 1.04, 1.07);
        const price = (p) => Math.round((1 / (p * vig)) * 100) / 100;
        out.push({ player: p.name, stat, book, bookTitle, line, over: price(pOver), under: price(1 - pOver), updated: `${date}T15:00:00Z` });
      }
    }
  }
  return out;
}

export const demoInternals = { league, seasonCalendar, simulateSeason, STORY, storyPlayer, daysBetween, STATS };
