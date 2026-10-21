// Match context: rest days, European games either side of a league match, derbies,
// newly promoted teams and recent form. Each factor is an adjustment to a team's
// expected goals scored (and, through the opponent, conceded). The sizes are not
// guessed: tools/model/backtest.mjs measures them on the validation seasons as
// actual / expected goals for the flagged teams, shrunk towards "no effect", and
// a factor is only kept when the evidence clears a significance gate.

import { readFileSync, existsSync } from 'node:fs';

const DAY = 864e5;

const UEFA_NAMES = {
  'B. Dortmund': 'Dortmund', 'Bayern München': 'Bayern Munich', Frankfurt: 'Ein Frankfurt', 'Köln': 'FC Koln',
  Leipzig: 'RB Leipzig', 'Man Utd': 'Man United', 'Mönchengladbach': "M'gladbach", Paris: 'Paris SG',
};
export const uefaToFd = n => UEFA_NAMES[n] || n;

// Local rivalries in the covered divisions (football-data names). Order doesn't matter.
export const DERBIES = [
  ['Arsenal', 'Tottenham'], ['Arsenal', 'Chelsea'], ['Chelsea', 'Tottenham'], ['Liverpool', 'Everton'],
  ['Man City', 'Man United'], ['Liverpool', 'Man United'], ['Newcastle', 'Sunderland'], ['Aston Villa', 'Birmingham'],
  ['West Ham', 'Tottenham'], ['West Ham', 'Millwall'], ['Crystal Palace', 'Brighton'], ['Ipswich', 'Norwich'],
  ['Leeds', 'Man United'], ['Nott\'m Forest', 'Derby'], ['Sheffield United', 'Sheffield Weds'], ['Bristol City', 'Cardiff'],
  ['Cardiff', 'Swansea'], ['West Brom', 'Wolves'], ['Portsmouth', 'Southampton'], ['Blackburn', 'Burnley'],
  ['Preston', 'Blackburn'], ['Stoke', 'Port Vale'], ['Coventry', 'Birmingham'], ['Hull', 'Leeds'],
  ['Dortmund', 'Schalke 04'], ['Bayern Munich', '1860 Munich'], ['Hamburg', 'St Pauli'], ['FC Koln', "M'gladbach"],
  ['Werder Bremen', 'Hamburg'], ['Stuttgart', 'Karlsruhe'], ['Union Berlin', 'Hertha'], ['Bayern Munich', 'Dortmund'],
  ['Inter', 'Milan'], ['Roma', 'Lazio'], ['Juventus', 'Torino'], ['Genoa', 'Sampdoria'], ['Inter', 'Juventus'],
  ['Napoli', 'Roma'], ['Fiorentina', 'Bologna'], ['Atalanta', 'Brescia'],
  ['Paris SG', 'Marseille'], ['Lyon', 'St Etienne'], ['Lens', 'Lille'], ['Nice', 'Monaco'], ['Nantes', 'Rennes'],
  ['Paris SG', 'Paris FC'],
].map(p => p.slice().sort().join('|'));
export const isDerby = (h, a) => DERBIES.includes([h, a].sort().join('|'));

export function loadEurope(rawDir) {
  const p = `${rawDir}/europe.json`;
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')).map(e => ({
    ...e, t: Date.parse(e.date), home: uefaToFd(e.home), away: uefaToFd(e.away),
  }));
}

// Every match date per team across league and European games.
export function schedule(leagueMatches, europe, extra = []) {
  const s = new Map();
  const add = (t, d, kind) => { if (!s.has(t)) s.set(t, []); s.get(t).push({ d, kind }); };
  for (const m of leagueMatches) { add(m.home, m.date, 'league'); add(m.away, m.date, 'league'); }
  for (const e of europe) { if (!e.t) continue; add(e.home, e.t, 'europe'); add(e.away, e.t, 'europe'); }
  for (const f of extra) { add(f.home, f.date, 'league'); add(f.away, f.date, 'league'); }
  for (const v of s.values()) v.sort((a, b) => a.d - b.d);
  return s;
}

// Flags for one team in a fixture at time t.
export function teamFlags(sched, team, t, seasonMatches) {
  const list = sched.get(team) || [];
  let prev = null, nextEurope = null, prevEurope = null;
  for (const x of list) {
    if (x.d < t - 3600e3) { prev = x; if (x.kind === 'europe') prevEurope = x; }
    else if (x.d > t + 3600e3 && x.kind === 'europe' && !nextEurope) nextEurope = x;
  }
  const rest = prev ? (t - prev.d) / DAY : null;
  return {
    shortRest: rest != null && rest < 3.5,                                   // played within ~3 days
    europeBefore: !!(prevEurope && t - prevEurope.d < 4.5 * DAY),            // European game in the previous 4 days
    europeAfter: !!(nextEurope && nextEurope.d - t < 4.5 * DAY),             // European game in the next 4 days (rotation risk)
    newcomer: seasonMatches != null && seasonMatches.newcomer,
  };
}

export const FLAGS = ['shortRest', 'europeBefore', 'europeAfter', 'newcomer'];

// Combine fitted factors into multipliers on (home expected goals, away expected goals).
// factors: { flag: { att, def } } where att scales the flagged team's goals scored and
// def scales goals it concedes; derby: { h, a } scales both sides' goals in a derby.
export function contextMultipliers(factors, flagsH, flagsA, derby) {
  let h = 1, a = 1;
  const applied = [];
  for (const f of FLAGS) {
    const k = factors[f];
    if (!k) continue;
    if (flagsH[f]) { h *= k.att; a *= k.def; applied.push(`${f} (home)`); }
    if (flagsA[f]) { a *= k.att; h *= k.def; applied.push(`${f} (away)`); }
  }
  if (derby && factors.derby) { h *= factors.derby.h; a *= factors.derby.a; applied.push('derby'); }
  return { h, a, applied };
}
