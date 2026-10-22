// Cross-league goals model, for Europa League and Conference League fixtures (and
// any European tie): clubs from different countries, which the domestic models
// cannot compare.
//
// One Poisson rating model (attack, defence, as in models.mjs) fitted jointly on
//   - domestic league results from 27 divisions (football-data.co.uk; data/raw and
//     data/raw/cross), each division with its own scoring level and home advantage
//   - every UEFA club competition result since 2021 (qualifiers included), as one
//     extra "division" (EUR) with its own scoring level and home advantage.
// Domestic games rate teams within a league; European games set how strong each
// league is relative to the others. Ratings are shrunk towards their league's mean,
// and that league mean is free, so a weak league ends up with a low mean.
// Clubs from countries without domestic data (Croatia, Czechia, Serbia, Cyprus,
// Israel, Hungary, Bulgaria ...) are rated from their European games only, shrunk
// towards the mean of other clubs from the same country. That is a much weaker
// rating, and the site says so.
//
// Goals only: no shots or xG for most of these leagues. Settings are the domestic
// goals model's (tools/model/config.json); the backtest below checks them on past
// European matches before anything is shown.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadMatches } from './data.mjs';
import { scoreGrid, marketsFromGrid, fitRho } from './models.mjs';

const DAY = 864e5;
const FROM = Date.parse('2021-07-01');
// UEFA country code -> football-data divisions
export const COUNTRY_DIVS = {
  ENG: ['E0', 'E1', 'E2'], GER: ['D1', 'D2'], ITA: ['I1', 'I2'], FRA: ['F1', 'F2'], ESP: ['SP1', 'SP2'],
  SCO: ['SC0', 'SC1'], BEL: ['B1'], NED: ['N1'], POR: ['P1'], TUR: ['T1'], GRE: ['G1'],
  AUT: ['AUT'], DEN: ['DNK'], NOR: ['NOR'], SWE: ['SWE'], POL: ['POL'], ROU: ['ROU'], SUI: ['SWZ'], FIN: ['FIN'], IRL: ['IRL'],
};
export const DIV_NAME = {
  E0: 'Premier League', E1: 'Championship', E2: 'League One', D1: 'Bundesliga', D2: '2. Bundesliga', I1: 'Serie A', I2: 'Serie B',
  F1: 'Ligue 1', F2: 'Ligue 2', SP1: 'La Liga', SP2: 'Segunda', SC0: 'Scottish Premiership', SC1: 'Scottish Championship',
  B1: 'Belgian Pro League', N1: 'Eredivisie', P1: 'Primeira Liga', T1: 'Super Lig', G1: 'Greek Super League',
  AUT: 'Austrian Bundesliga', DNK: 'Danish Superliga', NOR: 'Eliteserien', SWE: 'Allsvenskan', POL: 'Ekstraklasa',
  ROU: 'Romanian Liga I', SWZ: 'Swiss Super League', FIN: 'Veikkausliiga', IRL: 'League of Ireland',
};
const DIV_COUNTRY = Object.fromEntries(Object.entries(COUNTRY_DIVS).flatMap(([c, ds]) => ds.map(d => [d, c])));

const parseCSV = text => {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split(',');
  return lines.slice(1).map(l => { const c = l.split(','); return Object.fromEntries(head.map((h, i) => [h, c[i]])); });
};
const ukDate = s => { const [d, m, y] = s.split('/').map(Number); return Date.UTC(y < 100 ? 2000 + y : y, m - 1, d, 15); };
// Season code by date (July cutoff), as the domestic data uses ("2627").
const seasonOf = t => { const d = new Date(t); const y = d.getUTCFullYear() - (d.getUTCMonth() < 6 ? 1 : 0); return `${String(y % 100).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`; };

export const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ß/g, 'ss').replace(/ı/g, 'i').replace(/ł/g, 'l');
const STOP = new Set(['fc', 'afc', 'cf', 'sc', 'fk', 'sk', 'if', 'bk', 'ac', 'as', 'ss', 'club', 'de', 'cd', 'sv', 'vfl', 'vfb', 'tsg', 'rc', 'ogc', 'aj', 'sl', 'ks', 'jk', 'kv', 'krc', 'rsc', 'kaa', 'royal', 'the', 'and', 'calcio', 'city', 'united', 'town', 'athletic', 'de', 'cfr', 'cs', 'fotball', 'fotbal', 'ff', 'ik', 'aik', 'hjk'].filter(w => !['aik', 'hjk'].includes(w)));
const toks = s => norm(s).split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w));
// UEFA international names that the word match cannot pair with football-data names.
const ALIAS = {
  'ENG:Nottm Forest': "Nott'm Forest", 'ENG:Man City': 'Man City', 'ENG:Man United': 'Man United', 'ENG:Man Utd': 'Man United', 'ENG:Spurs': 'Tottenham',
  'ENG:Wolves': 'Wolves', 'ENG:West Ham': 'West Ham', 'ENG:Newcastle': 'Newcastle',
  'GER:Leverkusen': 'Leverkusen', 'GER:B. Dortmund': 'Dortmund', 'GER:Frankfurt': 'Ein Frankfurt', 'GER:Bayern München': 'Bayern Munich',
  'GER:Mönchengladbach': "M'gladbach", 'GER:Köln': 'FC Koln', 'GER:Leipzig': 'RB Leipzig',
  'ITA:Internazionale': 'Inter', 'ITA:Milan': 'Milan',
  'FRA:Paris': 'Paris SG', 'FRA:Lyon': 'Lyon', 'FRA:Marseille': 'Marseille',
  'ESP:Atleti': 'Ath Madrid', 'ESP:Athletic Club': 'Ath Bilbao', 'ESP:Real Sociedad': 'Sociedad', 'ESP:Celta': 'Celta', 'ESP:Real Betis': 'Betis',
  'ESP:Barcelona': 'Barcelona', 'ESP:Real Madrid': 'Real Madrid', 'ESP:Villarreal': 'Villarreal', 'ESP:Rayo Vallecano': 'Vallecano',
  'POR:Sporting CP': 'Sp Lisbon', 'POR:Benfica': 'Benfica', 'POR:Braga': 'Sp Braga', 'POR:Porto': 'Porto', 'POR:Vitória SC': 'Guimaraes',
  'NED:PSV': 'PSV Eindhoven', 'NED:N.E.C.': 'Nijmegen', 'NED:AZ Alkmaar': 'AZ Alkmaar', 'NED:Feyenoord': 'Feyenoord', 'NED:Twente': 'Twente',
  'BEL:Union SG': 'St. Gilloise', 'BEL:Club Brugge': 'Club Brugge', 'BEL:Sint-Truidense': 'St Truiden', 'BEL:Anderlecht': 'Anderlecht', 'BEL:Gent': 'Gent',
  'BEL:Antwerp': 'Antwerp', 'BEL:Genk': 'Genk', 'BEL:Cercle Brugge': 'Cercle Brugge', 'BEL:Standard Liège': 'Standard',
  'TUR:Beşiktaş': 'Besiktas', 'TUR:Fenerbahçe': 'Fenerbahce', 'TUR:Galatasaray': 'Galatasaray', 'TUR:Trabzonspor': 'Trabzonspor', 'TUR:Başakşehir': 'Buyuksehyr',
  'GRE:Olympiacos': 'Olympiakos', 'GRE:Panathinaikos': 'Panathinaikos', 'GRE:PAOK': 'PAOK', 'GRE:AEK Athens': 'AEK', 'GRE:OFI Crete': 'OFI Crete',
  'SCO:Celtic': 'Celtic', 'SCO:Rangers': 'Rangers', 'SCO:Hearts': 'Hearts', 'SCO:Aberdeen': 'Aberdeen', 'SCO:Hibernian': 'Hibernian',
  'AUT:Salzburg': 'Salzburg', 'AUT:Sturm Graz': 'Sturm Graz', 'AUT:LASK': 'LASK', 'AUT:Rapid Wien': 'Rapid Vienna', 'AUT:Austria Wien': 'Austria Vienna',
  'DEN:Copenhagen': 'FC Copenhagen', 'DEN:Midtjylland': 'Midtjylland', 'DEN:Nordsjælland': 'Nordsjaelland', 'DEN:Aarhus': 'Aarhus', 'DEN:Brøndby': 'Brondby',
  'NOR:Bodø/Glimt': 'Bodo/Glimt', 'NOR:Brann': 'Brann', 'NOR:Molde': 'Molde', 'NOR:Lillestrøm': 'Lillestrom', 'NOR:Rosenborg': 'Rosenborg',
  'SWE:Mjällby': 'Mjallby', 'SWE:Malmö': 'Malmo FF', 'SWE:Häcken': 'Hacken', 'SWE:Djurgården': 'Djurgarden', 'SWE:AIK': 'AIK',
  'POL:Lech Poznań': 'Lech Poznan', 'POL:Jagiellonia': 'Jagiellonia', 'POL:Legia Warszawa': 'Legia', 'POL:Raków': 'Rakow', 'POL:Pogoń': 'Pogon Szczecin',
  'ROU:Univ. Craiova': 'U Craiova', 'ROU:FCSB': 'FCSB', 'ROU:CFR Cluj': 'CFR Cluj',
  'SUI:Lugano': 'Lugano', 'SUI:Thun': 'Thun', 'SUI:Basel': 'Basel', 'SUI:Young Boys': 'Young Boys', 'SUI:Servette': 'Servette', 'SUI:Lausanne-Sport': 'Lausanne', 'SUI:St. Gallen': 'St. Gallen',
  'FIN:KuPS Kuopio': 'KuPS', 'FIN:HJK Helsinki': 'HJK', 'FIN:HJK': 'HJK', 'FIN:SJK': 'SJK', 'FIN:Ilves': 'Ilves',
  'IRL:Shamrock Rovers': 'Shamrock Rovers', 'IRL:Shelbourne': 'Shelbourne',
};

function loadDomestic(root) {
  const out = [];
  for (const m of loadMatches(path.join(root, 'data/raw'))) out.push({ div: m.div, season: m.season, date: m.date, home: m.home, away: m.away, hg: m.hg, ag: m.ag });
  const dir = path.join(root, 'data/raw/cross');
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.csv'))) {
    const rows = parseCSV(readFileSync(path.join(dir, f), 'utf8'));
    const isNew = !/-\d{4}\.csv$/.test(f);
    const div = isNew ? f.replace('.csv', '') : f.split('-')[0];
    for (const r of rows) {
      const home = isNew ? r.Home : r.HomeTeam, away = isNew ? r.Away : r.AwayTeam;
      const hg = Number(isNew ? r.HG : r.FTHG), ag = Number(isNew ? r.AG : r.FTAG);
      if (!home || !away || !r.Date || !Number.isFinite(hg) || !Number.isFinite(ag) || (isNew ? r.HG : r.FTHG) === '') continue;
      const date = ukDate(r.Date);
      if (date < FROM) continue;
      out.push({ div, season: seasonOf(date), date, home, away, hg, ag });
    }
  }
  return out;
}

// Pair UEFA club names with football-data names in the same country: an alias, or
// the domestic team sharing the most name words (ties left unpaired).
function makeMapper(domestic) {
  const byCountry = new Map();
  for (const m of domestic) {
    const c = DIV_COUNTRY[m.div];
    if (!byCountry.has(c)) byCountry.set(c, new Set());
    byCountry.get(c).add(m.home); byCountry.get(c).add(m.away);
  }
  const cache = new Map();
  return (name, country) => {
    const key = `${country}:${name}`;
    if (cache.has(key)) return cache.get(key);
    let res = null;
    const teams = byCountry.get(country);
    if (teams) {
      if (ALIAS[key] && teams.has(ALIAS[key])) res = ALIAS[key];
      else if (teams.has(name)) res = name;
      else {
        const t = new Set(toks(name));
        let best = null, tie = false;
        for (const d of teams) {
          const s = toks(d).filter(w => t.has(w) || [...t].some(x => x.length >= 4 && (x.startsWith(w) || w.startsWith(x)))).length;
          if (!s) continue;
          if (!best || s > best.s) { best = { d, s }; tie = false; } else if (s === best.s) tie = true;
        }
        if (best && !tie) res = best.d;
      }
    }
    cache.set(key, res);
    return res;
  };
}

export function loadCross(root) {
  const domestic = loadDomestic(root);
  const uefa = JSON.parse(readFileSync(path.join(root, 'data/raw/cross/uefa.json'), 'utf8'));
  const mapName = makeMapper(domestic);
  // Team keys: "<country>:<football-data name>" for clubs with domestic data,
  // "<country>:uefa:<UEFA name>" for the rest.
  const key = (name, country) => { const d = mapName(name, country); return d ? `${country}:${d}` : `${country}:uefa:${name}`; };
  const rows = domestic.map(m => ({ ...m, home: `${DIV_COUNTRY[m.div]}:${m.home}`, away: `${DIV_COUNTRY[m.div]}:${m.away}` }));
  const euro = [];
  for (const m of uefa) {
    const date = Date.parse(m.date);
    if (!m.homeCountry || !m.awayCountry || !Number.isFinite(date)) continue;
    const e = { div: 'EUR', comp: m.comp, round: m.round, status: m.status, season: seasonOf(date), date,
      home: key(m.home, m.homeCountry), away: key(m.away, m.awayCountry), homeName: m.home, awayName: m.away,
      hg: m.status === 'FINISHED' ? m.hg : null, ag: m.status === 'FINISHED' ? m.ag : null,
      // Finals are at a neutral ground; their home side has no home advantage.
      neutral: /final$/i.test(m.round) && !/semi|quarter/i.test(m.round) };
    euro.push(e);
  }
  return { rows, euro, key };
}

// Fit: domestic + European matches before asOf. Shrinkage group: a team's latest
// domestic division, or "U-<country>" for clubs rated from European games only.
export function fitCross(rows, euro, { asOf, xi = 0.0015, sigma = 0.4, seasonDiscount = 0.7, iters = 40 }) {
  const all = [];
  let cur = '';
  for (const m of [...rows, ...euro]) if (m.date < asOf && m.season > cur) cur = m.season;
  const back = s => Number(cur.slice(0, 2)) - Number(s.slice(0, 2));
  for (const m of [...rows, ...euro]) {
    if (m.date >= asOf || m.hg == null || m.ag == null || m.date < FROM) continue;
    const w = Math.exp(-xi * (asOf - m.date) / DAY) * seasonDiscount ** back(m.season);
    if (w < 1e-3) continue;
    all.push({ m, w });
  }
  all.sort((a, b) => a.m.date - b.m.date);
  const teams = new Map(), divs = new Map(), group = new Map(), groups = new Map(), euroGames = new Map();
  for (const { m } of all) {
    for (const t of [m.home, m.away]) if (!teams.has(t)) teams.set(t, teams.size);
    if (!divs.has(m.div)) divs.set(m.div, divs.size);
    if (m.div !== 'EUR') { group.set(m.home, m.div); group.set(m.away, m.div); }
    else for (const t of [m.home, m.away]) euroGames.set(t, (euroGames.get(t) || 0) + 1);
  }
  // Clubs without domestic data share a prior with other such clubs from their
  // country, or (fewer than 3 of them) with all such clubs from small groups.
  const perCountry = new Map();
  for (const t of teams.keys()) if (!group.has(t)) perCountry.set(t.split(':')[0], (perCountry.get(t.split(':')[0]) || 0) + 1);
  for (const t of teams.keys()) if (!group.has(t)) group.set(t, perCountry.get(t.split(':')[0]) >= 3 ? 'U-' + t.split(':')[0] : 'U-other');
  for (const g of group.values()) if (!groups.has(g)) groups.set(g, groups.size);
  const nT = teams.size, nD = divs.size, nG = groups.size;
  const gOf = new Int32Array(nT);
  for (const [t, i] of teams) gOf[i] = groups.get(group.get(t));
  const A = new Float64Array(nT), D = new Float64Array(nT), O = new Float64Array(nD), H = new Float64Array(nD).fill(0.2);
  { let s = 0, n = 0; for (const { m, w } of all) { s += w * (m.hg + m.ag); n += 2 * w; } O.fill(Math.log(s / n)); }
  const idx = all.map(({ m }) => [teams.get(m.home), teams.get(m.away), divs.get(m.div), m.neutral ? 0 : 1]);
  const LH = new Float64Array(all.length), LA = new Float64Array(all.length);
  const refresh = () => all.forEach((r, k) => { const [i, j, d, ha] = idx[k]; LH[k] = Math.exp(O[d] + ha * H[d] + A[i] - D[j]); LA[k] = Math.exp(O[d] + A[j] - D[i]); });
  const step = (n, acc, apply) => {
    const g = new Float64Array(n), h = new Float64Array(n);
    all.forEach(({ m, w }, k) => acc(g, h, idx[k], w * (m.hg - LH[k]), w * (m.ag - LA[k]), w * LH[k], w * LA[k]));
    apply(g, h); refresh();
  };
  const means = () => {
    const mA = new Float64Array(nG), mD = new Float64Array(nG), c = new Float64Array(nG);
    for (let t = 0; t < nT; t++) { mA[gOf[t]] += A[t]; mD[gOf[t]] += D[t]; c[gOf[t]]++; }
    return [mA.map((x, g) => x / c[g]), mD.map((x, g) => x / c[g])];
  };
  const prec = 1 / (sigma * sigma);
  refresh();
  for (let it = 0; it < iters; it++) {
    step(nD, (g, h, [, , d], rh, ra, wh, wa) => { g[d] += rh + ra; h[d] += wh + wa; }, (g, h) => { for (let d = 0; d < nD; d++) O[d] += g[d] / h[d]; });
    step(nD, (g, h, [, , d, ha], rh, ra, wh) => { if (ha) { g[d] += rh; h[d] += wh; } }, (g, h) => { for (let d = 0; d < nD; d++) if (h[d]) H[d] += g[d] / h[d]; });
    let [mA] = means();
    step(nT, (g, h, [i, j], rh, ra, wh, wa) => { g[i] += rh; h[i] += wh; g[j] += ra; h[j] += wa; },
      (g, h) => { for (let t = 0; t < nT; t++) A[t] += (g[t] - prec * (A[t] - mA[gOf[t]])) / (h[t] + prec); });
    let [, mD] = means();
    step(nT, (g, h, [i, j], rh, ra, wh, wa) => { g[j] -= rh; h[j] += wh; g[i] -= ra; h[i] += wa; },
      (g, h) => { for (let t = 0; t < nT; t++) D[t] += (g[t] - prec * (D[t] - mD[gOf[t]])) / (h[t] + prec); });
    let sa = 0, sd = 0;
    for (let t = 0; t < nT; t++) { sa += A[t]; sd += D[t]; }
    for (let t = 0; t < nT; t++) { A[t] -= sa / nT; D[t] -= sd / nT; }
    for (let d = 0; d < nD; d++) O[d] += (sa - sd) / nT;
  }
  const E = divs.get('EUR');
  const team = k => (teams.has(k) ? { a: A[teams.get(k)], d: D[teams.get(k)], group: group.get(k), euroGames: euroGames.get(k) || 0 } : null);
  return {
    team,
    expected(home, away, neutral = false) {
      const h = team(home), a = team(away);
      if (!h || !a || E === undefined) return null;
      return { h: Math.exp(O[E] + (neutral ? 0 : H[E]) + h.a - a.d), a: Math.exp(O[E] + a.a - h.d) };
    },
    homeAdv: Math.exp(H[E]),
  };
}

export const probsFor = (lh, la, rho) => {
  const g = scoreGrid(lh, la, rho);
  return { grid: g, ...marketsFromGrid(g) };
};
export { fitRho };
