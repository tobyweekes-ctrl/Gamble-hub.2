#!/usr/bin/env node
// Downloads starting lineups and per-player match stats from ESPN's public JSON
// API into data/raw/lineups/<league>.json (a cache: only matches not already
// stored are fetched). Covers 2023/24 onwards for the five leagues, which is what
// the lineup-strength measurement in tools/model/lineups.mjs needs.
//
// Usage: node tools/model/fetch-lineups.mjs [--since YYYY-MM-DD] [--upcoming]
//   --since     only fetch matches from this date (default 2023-07-01; the
//               lineup-time runs use the last 150 days, which is all they need)
//   --upcoming  also fetch matches in the next 3 days, with their lineups where
//               announced (written to data/raw/lineups/upcoming.json)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'data/raw/lineups');
mkdirSync(dir, { recursive: true });
export const ESPN_LEAGUES = { 'eng.1': 'E0', 'eng.2': 'E1', 'ger.1': 'D1', 'ita.1': 'I1', 'fra.1': 'F1', 'uefa.champions': 'UCL' };
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

// curl rather than fetch: it honours the HTTPS proxy settings of cloud sessions.
function get(url) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sSf', '--compressed', '-m', '60', url], { maxBuffer: 64e6 }, (err, out) => {
      if (err) reject(new Error(`${url}: ${err.message.split('\n')[0]}`)); else resolve(JSON.parse(out));
    });
  });
}
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(e => ({ error: e.message })); }
  }));
  return out;
}

const num = (stats, name) => {
  const s = (stats || []).find(x => x.name === name);
  return s && s.value != null ? Number(s.value) : 0;
};
export function extract(summary, ev, league) {
  const comp = ev.competitions[0];
  const side = ha => comp.competitors.find(c => c.homeAway === ha);
  const rosters = summary.rosters || [];
  const team = ha => {
    const c = side(ha);
    const r = rosters.find(x => String(x.team.id) === String(c.team.id));
    if (!r || !r.roster || !r.roster.some(p => p.starter)) return null;
    return {
      id: String(c.team.id), name: c.team.displayName, formation: r.formation || null,
      players: r.roster.map(p => ({
        id: String(p.athlete.id), name: p.athlete.displayName, pos: p.position?.abbreviation || '',
        start: !!p.starter, subIn: !!p.subbedIn, subOut: !!p.subbedOut,
        g: num(p.stats, 'totalGoals'), a: num(p.stats, 'goalAssists'), sh: num(p.stats, 'totalShots'), sot: num(p.stats, 'shotsOnTarget'),
      })),
    };
  };
  return {
    id: String(ev.id), league, date: ev.date, status: ev.status.type.name,
    home: team('home'), away: team('away'),
    homeName: side('home').team.displayName, awayName: side('away').team.displayName,
    hg: side('home').score != null ? Number(side('home').score) : null, ag: side('away').score != null ? Number(side('away').score) : null,
  };
}

async function scoreboard(league, year) {
  const d = await get(`${BASE}/${league}/scoreboard?dates=${year}&limit=1000`);
  return d.events || [];
}

const upcoming = process.argv.includes('--upcoming');
const now = new Date();
const sinceArg = process.argv.indexOf('--since');
const since = sinceArg >= 0 ? Date.parse(process.argv[sinceArg + 1]) : Date.UTC(2023, 6, 1);
const firstYear = new Date(since).getUTCFullYear();
for (const league of Object.keys(ESPN_LEAGUES)) {
  const file = path.join(dir, `${league}.json`);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  let events = [];
  for (let y = firstYear; y <= now.getUTCFullYear(); y++) events = events.concat(await scoreboard(league, y));
  const done = events.filter(e => e.status.type.completed && !cache[e.id] && Date.parse(e.date) >= since);
  const res = await pool(done, 8, async ev => extract(await get(`${BASE}/${league}/summary?event=${ev.id}`), ev, league));
  let added = 0, failed = 0;
  for (const r of res) { if (r.error) failed++; else if (r.home && r.away) { cache[r.id] = r; added++; } }
  writeFileSync(file, JSON.stringify(cache));
  console.log(`${league}: ${Object.keys(cache).length} matches with lineups (${added} new, ${failed} failed)`);
}

if (upcoming) {
  const out = [];
  for (const league of Object.keys(ESPN_LEAGUES)) {
    const evs = (await scoreboard(league, now.getUTCFullYear())).filter(e => {
      const t = Date.parse(e.date);
      return !e.status.type.completed && t > now.getTime() - 3 * 3600e3 && t < now.getTime() + 3 * 864e5;
    });
    const res = await pool(evs, 8, async ev => extract(await get(`${BASE}/${league}/summary?event=${ev.id}`), ev, league));
    for (const r of res) if (!r.error) out.push(r);
  }
  writeFileSync(path.join(dir, 'upcoming.json'), JSON.stringify(out));
  console.log(`upcoming: ${out.length} matches in the next 3 days, ${out.filter(r => r.home && r.away).length} with lineups announced`);
}
