// Data sources for the weekly and lineup-time updates. Every function returns what
// the page says, or null / [] when it can't be read; nothing is estimated.
//
//   BBC Sport      - fixtures, kick-off times, league tables, final scores
//   kickoff.co.uk  - Bet365 prices (1X2, BTTS, Over/Under 2.5) from match pages
//   ESPN API       - final scores (second source) and confirmed lineups
//
// All requests go through curl, which honours the cloud session's HTTPS proxy.

import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
export function get(url, { json = false } = {}) {
  try {
    const out = execFileSync('curl', ['-sSfL', '--compressed', '-m', '45', '-A', UA, url], { encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'] });
    return json ? JSON.parse(out) : out;
  } catch {
    return null;
  }
}

export const COMPETITIONS = {
  'Premier League': { bbc: 'premier-league', kickoff: 'english-premier-league', espn: 'eng.1' },
  Championship: { bbc: 'championship', kickoff: 'english-championship', espn: 'eng.2' },
  'Champions League': { bbc: 'champions-league', kickoff: 'uefa-champions-league', espn: 'uefa.champions' },
  Bundesliga: { bbc: 'german-bundesliga', kickoff: 'german-bundesliga', espn: 'ger.1' },
  'Serie A': { bbc: 'italian-serie-a', kickoff: 'italian-serie-a', espn: 'ita.1' },
  'Ligue 1': { bbc: 'french-ligue-one', kickoff: 'french-ligue', espn: 'fra.1' },
};

// ---- BBC Sport -----------------------------------------------------------------
export function bbcTable(league) {
  const s = get(`https://www.bbc.co.uk/sport/football/${COMPETITIONS[league].bbc}/table`);
  if (!s) return null;
  const t = s.replace(/\\"/g, '"');
  const teams = {};
  const re = /"rank":(\d+),[^{}]*?"name":"([^"]+)","points":(\d+),"matchesPlayed":(\d+),"wins":(\d+),"losses":(\d+),"draws":(\d+),"goalsScoredFor":(\d+),"goalsScoredAgainst":(\d+)/g;
  for (const m of t.matchAll(re)) {
    const [, pos, name, pts, p, w, l, d, gf, ga] = m;
    if (!teams[name]) teams[name] = { pos: +pos, p: +p, w: +w, d: +d, l: +l, gf: +gf, ga: +ga, pts: +pts };
  }
  return Object.keys(teams).length ? teams : null;
}

// The JSON data object BBC Sport embeds in its pages.
function bbcData(url) {
  const s = get(url);
  const m = s && /window\.__INITIAL_DATA__\s*=\s*("(?:[^"\\]|\\.)*")/.exec(s);
  if (!m) return null;
  try { return JSON.parse(JSON.parse(m[1])); } catch { return null; }
}
function walk(o, visit) {
  if (Array.isArray(o)) o.forEach(v => walk(v, visit));
  else if (o && typeof o === 'object') { visit(o); Object.values(o).forEach(v => walk(v, visit)); }
}

// Fixtures and results between two UTC instants, from BBC's month pages.
// hg/ag are set only for finished matches (status PostEvent).
export function bbcFixtures(league, fromMs, toMs) {
  const months = new Set();
  for (let t = fromMs; t <= toMs + 864e5; t += 864e5) months.add(new Date(t).toISOString().slice(0, 7));
  const out = new Map();
  // The plain month page lists games from today on; ?filter=results lists finished ones.
  for (const url of [...months].flatMap(mo => [`${mo}`, `${mo}?filter=results`])) {
    const d = bbcData(`https://www.bbc.co.uk/sport/football/${COMPETITIONS[league].bbc}/scores-fixtures/${url}`);
    walk(d, o => {
      if (!o.home || !o.away || !o.startDateTime || !o.home.fullName) return;
      const at = Date.parse(o.startDateTime);
      if (at < fromMs || at > toMs) return;
      const done = o.status === 'PostEvent';
      const ft = side => (o[side].runningScores && o[side].runningScores.fulltime != null ? Number(o[side].runningScores.fulltime) : null);
      out.set(o.id || `${o.home.fullName}|${o.startDateTime}`, {
        home: o.home.fullName, away: o.away.fullName, utc: o.startDateTime, status: o.status,
        hg: done ? ft('home') : null, ag: done ? ft('away') : null,
      });
    });
  }
  return [...out.values()].sort((a, b) => (a.utc < b.utc ? -1 : 1));
}

// ---- kickoff.co.uk (Bet365 prices) ---------------------------------------------
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set(['fc', 'afc', 'city', 'united', 'town', 'the', 'and', 'hove', 'albion', 'de', 'ac', 'as', 'sc', 'cf', 'rovers', 'wanderers', 'athletic', 'county']);
const toks = s => new Set(norm(s).split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w)));
const KO_ALIAS = {
  'manchester united': 'man united', 'manchester city': 'man city', 'tottenham hotspur': 'tottenham', 'wolverhampton wanderers': 'wolves',
  'sheffield united': 'sheff utd', 'sheffield wednesday': 'sheff wed', 'queens park rangers': 'qpr', 'west bromwich albion': 'west brom',
  'borussia dortmund': 'borussia dortmund', 'eintracht frankfurt': 'e frankfurt', 'bayer 04 leverkusen': 'leverkusen',
  'paris saint-germain': 'psg', 'inter milan': 'inter milan', 'monza': 'ac monza', "borussia m'gladbach": 'gladbach',
  'nottingham forest': 'nottingham forest', 'brighton & hove albion': 'brighton', 'olympique lyonnais': 'olympique lyonnais',
};
const koToks = name => toks(KO_ALIAS[norm(name)] || name);

const listingCache = new Map();
export function kickoffMatchPage(league, home, away) {
  const slug = COMPETITIONS[league].kickoff;
  if (!listingCache.has(slug)) {
    const s = get(`https://www.kickoff.co.uk/${slug}-predictions-stats-odds/`) || '';
    listingCache.set(slug, [...new Set([...s.matchAll(/href="(?:https:\/\/www\.kickoff\.co\.uk)?(\/[a-z0-9-]+-predictions-stats-odds\/[a-z0-9-]+-vs-[a-z0-9-]+\/)"/g)].map(m => m[1]))]);
  }
  let best = null;
  for (const l of listingCache.get(slug)) {
    const m = /\/([a-z0-9-]+)-vs-([a-z0-9-]+)\/$/.exec(l);
    const kh = toks(m[1].replace(/-/g, ' ')), ka = toks(m[2].replace(/-/g, ' '));
    const sh = [...koToks(home)].filter(w => kh.has(w)).length, sa = [...koToks(away)].filter(w => ka.has(w)).length;
    if (sh && sa && (!best || sh + sa > best.s)) best = { url: 'https://www.kickoff.co.uk' + l, s: sh + sa };
  }
  return best && best.url;
}

// Bet365 prices from a kickoff.co.uk match page. The page's odds table holds
// every market; rows are identified by their labels. The match date shown on the
// page must equal `ukDate` (YYYY-MM-DD), so an old fixture between the same
// clubs can't be picked up by mistake.
export function kickoffPrices(url, ukDate) {
  const s = get(url);
  if (!s || (ukDate && !s.includes(ukDate))) return null;
  const i = s.indexOf('ko-mp-odds-matrix-block-content-grid-market-wrapper'), j = s.indexOf('</table>', i);
  if (i < 0) return null;
  const rows = [];
  for (const tr of s.slice(i, j).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...tr[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)];
    if (!tds.length) continue;
    const first = [...tds[0][2].matchAll(/<div[^>]*>([\s\S]*?)<\/div>/g)];
    const label = first.length ? first[0][1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim() : '';
    const odds = tds.map(t => /data-odds_decimal="([^"]*)"/.exec(t[1])).filter(Boolean).map(x => (x[1] ? Number(x[1]) : null));
    rows.push({ label, bet365: odds[0] ?? null });
  }
  const by = label => { const r = rows.find(x => x.label === label); return r && r.bet365 > 1 ? r.bet365 : null; };
  const x = rows.slice(0, 3).map(r => (r.bet365 > 1 ? r.bet365 : null));
  return {
    x12: x.every(Boolean) ? { h: x[0], d: x[1], a: x[2] } : null,
    btts: by('BTTS - Yes') && by('BTTS - No') ? { yes: by('BTTS - Yes'), no: by('BTTS - No') } : null,
    ou25: by('Over 2.5 Goals') && by('Under 2.5 Goals') ? { over: by('Over 2.5 Goals'), under: by('Under 2.5 Goals') } : null,
  };
}

// ---- ESPN ------------------------------------------------------------------------
export function espnEvents(league, ymd) {
  const d = get(`https://site.api.espn.com/apis/site/v2/sports/soccer/${COMPETITIONS[league].espn}/scoreboard?dates=${ymd}`, { json: true });
  return (d && d.events) || [];
}
export function espnSummary(league, id) {
  return get(`https://site.api.espn.com/apis/site/v2/sports/soccer/${COMPETITIONS[league].espn}/summary?event=${id}`, { json: true });
}
// Short names (ESPN, BBC) that share no word with ours.
const SHORT_NAME = { lyon: 'olympique lyonnais' };
export const sameTeam = (a, b) => {
  const ta = koToks(a), tb = koToks(b), long = x => toks(SHORT_NAME[norm(x)] || x);
  return [...ta].some(w => tb.has(w)) || [...long(a)].some(w => long(b).has(w));
};
