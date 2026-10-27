#!/usr/bin/env node
// Adds League Cup (Carabao Cup) ties that have not kicked off to the current round,
// for the cross-league model (tools/model/cross.mjs rates Premier League,
// Championship and League One sides together), then rebuilds the seed.
//   - fixtures and kick-offs from ESPN, cross-checked with BBC Sport where BBC lists them
//   - a tie is left out when a side has no league games in the last year in our data
//     (League Two and below are not covered), rather than rated on old games
// Cup sides rotate heavily; nothing in our data measures that for cups, so the site
// says so on each tie. Prices (Bet365, kickoff.co.uk) and lineups (ESPN) are added by
// tools/lineup-update.mjs and tools/europe-lineups.mjs like any other fixture.
//
// Usage: node tools/cup-fixtures.mjs [--days 7] [--lead 30] [data/rounds/<round>.json]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { espnEvents, bbcFixtures, sameTeam } from './research/sources.mjs';
import { loadCross } from './model/cross.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const days = args.includes('--days') ? +args[args.indexOf('--days') + 1] : 7;
const lead = args.includes('--lead') ? +args[args.indexOf('--lead') + 1] : 0;
const roundsDir = path.join(root, 'data/rounds');
const roundPath = args.find(a => a.endsWith('.json')) || path.join(roundsDir, readdirSync(roundsDir).filter(f => f.endsWith('.json')).sort().pop());
const round = JSON.parse(readFileSync(roundPath, 'utf8'));
const league = 'League Cup';
const now = Date.now();
const ukIso = t => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(p => [p.type, p.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const off = Math.round((local - t) / 6e4), sign = off < 0 ? '-' : '+', a = Math.abs(off);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
};
const label = t => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t)).replace(',', '');

const cross = loadCross(root);
const recentLeagueGames = key => cross.rows.filter(m => (m.home === key || m.away === key) && m.hg != null && now - m.date < 365 * 864e5).length;
const bbc = bbcFixtures(league, now, now + days * 864e5);
round.fixtures = round.fixtures.filter(f => f.league !== league || Date.parse(f.kickoff) <= now);
let added = 0;
const skipped = [];
for (let d = 0; d <= days; d++) {
  for (const e of espnEvents(league, new Date(now + d * 864e5).toISOString().slice(0, 10).replace(/-/g, ''))) {
    const t = Date.parse(e.date), c = e.competitions[0].competitors;
    const home = c.find(x => x.homeAway === 'home').team.displayName, away = c.find(x => x.homeAway === 'away').team.displayName;
    if (!(t > now + lead * 6e4) || e.status.type.state !== 'pre') continue; // never predict a game that has started
    if (round.fixtures.some(f => f.league === league && sameTeam(f.home, home) && Date.parse(f.kickoff) === t)) continue;
    const unrated = [home, away].filter(n => recentLeagueGames(cross.key(n, 'ENG')) < 10);
    if (unrated.length) { skipped.push(`${home} v ${away} (${unrated.join(', ')}: not enough league games in our data)`); continue; }
    const b = bbc.find(x => sameTeam(x.home, home) && sameTeam(x.away, away));
    const kickoffNote = b ? (Date.parse(b.utc) === t ? 'Fixture and kick-off from ESPN, confirmed by BBC Sport.' : `Kick-off differs: ESPN ${label(t)}, BBC ${label(Date.parse(b.utc))} (ESPN used).`) : 'Fixture and kick-off from ESPN (single source).';
    round.fixtures.push({
      league, home, away, kickoff: ukIso(t),
      uefa: { home, homeCountry: 'ENG', away, awayCountry: 'ENG' }, cup: true,
      form: `${kickoffNote} Prices are a single source (Bet365) when found.`,
    });
    added++;
  }
}
if (added && !round.leagues.includes(league)) round.leagues.push(league);
round.leagueQuality = { ...(round.leagueQuality || {}), [league]: 'researched' };
round.updateTag = label(now);
round.dataUpdated = label(now);
writeFileSync(roundPath, JSON.stringify(round, null, 1) + '\n');
console.log(`cup fixtures: ${added} added`);
for (const s of skipped) console.log('  left out:', s);
execFileSync('node', ['tools/build-seed.mjs', path.relative(root, roundPath)], { cwd: root, stdio: 'inherit' });
