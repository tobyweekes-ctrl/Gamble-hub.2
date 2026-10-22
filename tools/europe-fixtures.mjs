#!/usr/bin/env node
// Adds Europa League and Conference League fixtures (UEFA match data) that have not
// kicked off to the current round, for the cross-league model (tools/model/cross.mjs),
// then rebuilds the seed. Champions League ties are added too when the competition
// is passed with --ucl.
//
// Usage: node tools/europe-fixtures.mjs [--days 7] [--ucl] [data/rounds/<round>.json]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const days = args.includes('--days') ? +args[args.indexOf('--days') + 1] : 7;
const roundsDir = path.join(root, 'data/rounds');
const roundPath = args.find(a => a.endsWith('.json')) || path.join(roundsDir, readdirSync(roundsDir).filter(f => f.endsWith('.json')).sort().pop());
const round = JSON.parse(readFileSync(roundPath, 'utf8'));
const COMPS = { 14: 'Europa League', 2019: 'Conference League', ...(args.includes('--ucl') ? { 1: 'Champions League' } : {}) };
const lead = args.includes("--lead") ? +args[args.indexOf("--lead") + 1] : 0; // minutes: skip games starting before publishing can finish
const now = Date.now();
// Kick-off in UK time with its offset, as the rest of the round ("2026-10-22T20:00:00+01:00").
const ukIso = t => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(p => [p.type, p.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const off = Math.round((local - t) / 6e4), sign = off < 0 ? '-' : '+', a = Math.abs(off);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
};
const day = t => new Date(t).toISOString().slice(0, 10);
const label = t => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t)).replace(',', '');

let added = 0;
for (const [id, league] of Object.entries(COMPS)) {
  const url = `https://match.uefa.com/v5/matches?competitionId=${id}&fromDate=${day(now)}&toDate=${day(now + days * 864e5)}&limit=100&offset=0&order=ASC`;
  const list = JSON.parse(execFileSync('curl', ['-sSf', '-m', '60', url], { encoding: 'utf8' }));
  // Replace this competition's fixtures that have not started; keep the rest as logged.
  round.fixtures = round.fixtures.filter(f => f.league !== league || Date.parse(f.kickoff) <= now);
  for (const m of list) {
    const t = Date.parse(m.kickOffTime?.dateTime);
    if (!(t > now + lead * 6e4) || m.status !== 'UPCOMING' || !m.homeTeam || !m.awayTeam) continue; // never predict a game that has started
    if (round.fixtures.some(f => f.league === league && f.home === m.homeTeam.internationalName && Date.parse(f.kickoff) === t)) continue;
    round.fixtures.push({
      league, home: m.homeTeam.internationalName, away: m.awayTeam.internationalName, kickoff: ukIso(t),
      uefa: { home: m.homeTeam.internationalName, homeCountry: m.homeTeam.countryCode, away: m.awayTeam.internationalName, awayCountry: m.awayTeam.countryCode },
      form: `Fixture and kick-off from UEFA match data (${m.round?.metaData?.name || league}). No bookmaker prices gathered for this game.`,
    });
    added++;
  }
  if (list.length && !round.leagues.includes(league)) round.leagues.push(league);
  round.leagueQuality = { ...(round.leagueQuality || {}), [league]: 'researched' };
}
round.updateTag = label(now);
round.dataUpdated = label(now);
writeFileSync(roundPath, JSON.stringify(round, null, 1) + '\n');
console.log(`europe fixtures: ${added} added`);
execFileSync('node', ['tools/build-seed.mjs', path.relative(root, roundPath)], { cwd: root, stdio: 'inherit' });
