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
  return addShotQuality(out.sort((a, b) => a.date - b.date));
}

// Shot quality per match for the shots model: xG where football-data.co.uk has it
// (2026/27 onwards), expressed in shots-on-target units using the division's
// goals-per-shot-on-target rate from the previous season; shots on target otherwise.
// Sets m.qh / m.qa. A within-season walk-forward test on 2026/27 (286 matches) gave
// log-loss 1.0069 with xG against 1.0081 with shots on target alone.
export function addShotQuality(matches) {
  const rate = {};
  for (const m of matches) {
    if (m.hst == null) continue;
    const k = `${m.div}|${m.season}`;
    rate[k] = rate[k] || { g: 0, s: 0 };
    rate[k].g += m.hg + m.ag; rate[k].s += m.hst + m.ast;
  }
  const prev = s => String(Number(s.slice(0, 2)) - 1).padStart(2, '0') + s.slice(0, 2);
  for (const m of matches) {
    const r = rate[`${m.div}|${prev(m.season)}`];
    const k = r ? r.g / r.s : null;
    m.qh = m.xgh != null && k ? m.xgh / k : m.hst;
    m.qa = m.xga != null && k ? m.xga / k : m.ast;
  }
  return matches;
}

// Margin-free probabilities from a set of decimal prices.
export function fair(prices) {
  if (!prices) return null;
  const inv = prices.map(p => 1 / p);
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map(x => x / s);
}
