// Loads match results from football-data.co.uk CSVs (fetched into data/raw/ by
// tools/model/fetch.sh) into plain objects the models use.
//
// Each match: { div, group, season, date (ms), home, away, hg, ag, hs, as, hst, ast,
//   hf, af, hc, ac, hy, ay, hr, ar, xgh, xga, odds }
// where odds holds the bookmaker prices used only for benchmarking and the value
// backtest, never as model inputs.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// Divisions fitted together, so teams moving between them keep one rating.
export const GROUPS = {
  england: ['E0', 'E1', 'E2'],
  germany: ['D1', 'D2'],
  italy: ['I1', 'I2'],
  france: ['F1', 'F2'],
};
export const DIV_LEAGUE = { E0: 'Premier League', E1: 'Championship', D1: 'Bundesliga', I1: 'Serie A', F1: 'Ligue 1' };
export const LEAGUE_DIV = Object.fromEntries(Object.entries(DIV_LEAGUE).map(([d, l]) => [l, d]));
const DIV_GROUP = Object.fromEntries(Object.entries(GROUPS).flatMap(([g, ds]) => ds.map(d => [d, g])));

// BBC Sport / app names -> football-data.co.uk names, where they differ.
export const TEAM_ALIASES = {
  'Brighton & Hove Albion': 'Brighton', 'Coventry City': 'Coventry', 'Hull City': 'Hull',
  'Ipswich Town': 'Ipswich', 'Leeds United': 'Leeds', 'Manchester City': 'Man City',
  'Manchester United': 'Man United', 'Newcastle United': 'Newcastle', 'Nottingham Forest': "Nott'm Forest",
  'Tottenham Hotspur': 'Tottenham', 'Tottenham': 'Tottenham',
  'Birmingham City': 'Birmingham', 'Blackburn Rovers': 'Blackburn', 'Bolton Wanderers': 'Bolton',
  'Cardiff City': 'Cardiff', 'Charlton Athletic': 'Charlton', 'Derby County': 'Derby', 'Lincoln City': 'Lincoln',
  'Norwich City': 'Norwich', 'Preston North End': 'Preston', 'Queens Park Rangers': 'QPR', 'Stoke City': 'Stoke',
  'Swansea City': 'Swansea', 'West Bromwich Albion': 'West Brom', 'West Ham United': 'West Ham',
  'Wolverhampton Wanderers': 'Wolves', 'Sheffield United': 'Sheffield United',
  'Borussia Dortmund': 'Dortmund', 'Eintracht Frankfurt': 'Ein Frankfurt', 'Köln': 'FC Koln', 'Hamburger SV': 'Hamburg',
  'Bayer 04 Leverkusen': 'Leverkusen', "Borussia M'gladbach": "M'gladbach", 'Mainz 05': 'Mainz',
  'Inter Milan': 'Inter', 'AC Milan': 'Milan', 'Paris Saint-Germain': 'Paris SG', 'Olympique Lyonnais': 'Lyon',
};
export const fdName = name => TEAM_ALIASES[name] || name;

function parseCSV(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split(',');
  return lines.slice(1).map(l => {
    const cells = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
}

const num = v => (v === undefined || v === '' ? null : Number(v));
function triple(r, a, b, c) {
  const t = [num(r[a]), num(r[b]), num(r[c])];
  return t.every(x => x > 1) ? t : null;
}
function pair(r, a, b) {
  const t = [num(r[a]), num(r[b])];
  return t.every(x => x > 1) ? t : null;
}

export function loadMatches(rawDir) {
  if (!existsSync(rawDir)) throw new Error(`${rawDir} missing: run tools/model/fetch.sh first`);
  const out = [];
  for (const f of readdirSync(rawDir).filter(f => /^[A-Z]\d-\d{4}\.csv$/.test(f)).sort()) {
    const [div, season] = f.replace('.csv', '').split('-');
    if (!DIV_GROUP[div]) continue;
    for (const r of parseCSV(readFileSync(path.join(rawDir, f), 'utf8'))) {
      if (!r.HomeTeam || r.FTHG === undefined || r.FTHG === '') continue;
      const [d, m, y] = r.Date.split('/').map(Number);
      const year = y < 100 ? 2000 + y : y;
      const [hh, mm] = (r.Time || '15:00').split(':').map(Number);
      out.push({
        div, group: DIV_GROUP[div], season, date: Date.UTC(year, m - 1, d, hh || 15, mm || 0),
        home: r.HomeTeam, away: r.AwayTeam, hg: num(r.FTHG), ag: num(r.FTAG),
        hs: num(r.HS), as: num(r.AS), hst: num(r.HST), ast: num(r.AST),
        hf: num(r.HF), af: num(r.AF), hc: num(r.HC), ac: num(r.AC),
        hy: num(r.HY), ay: num(r.AY), hr: num(r.HR), ar: num(r.AR),
        xgh: num(r.HxG), xga: num(r.AxG),
        odds: {
          b365: triple(r, 'B365H', 'B365D', 'B365A'),
          b365c: triple(r, 'B365CH', 'B365CD', 'B365CA'),
          avgc: triple(r, 'AvgCH', 'AvgCD', 'AvgCA'),
          psc: triple(r, 'PSCH', 'PSCD', 'PSCA'),
          o25: pair(r, 'B365>2.5', 'B365<2.5'),
          o25c: pair(r, 'B365C>2.5', 'B365C<2.5') || pair(r, 'AvgC>2.5', 'AvgC<2.5'),
        },
      });
    }
  }
  return out.sort((a, b) => a.date - b.date);
}

// Margin-free probabilities from a set of decimal prices.
export function fair(prices) {
  if (!prices) return null;
  const inv = prices.map(p => 1 / p);
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map(x => x / s);
}
