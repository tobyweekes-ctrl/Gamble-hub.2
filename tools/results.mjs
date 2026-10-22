#!/usr/bin/env node
// Adds final scores for finished fixtures to data/results.json. Every fixture in
// data/rounds/*.json whose kick-off is over 2.5 hours ago and has no result yet is
// looked up on BBC Sport and on ESPN. Both agree -> two sources. Only one found ->
// stored with "single source". They disagree -> not stored; listed as a conflict.
//
// Usage: node tools/results.mjs

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bbcFixtures, espnEvents, sameTeam } from './research/sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsPath = path.join(root, 'data/results.json');
const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {};

// Fixture ids exactly as tools/build-seed.mjs generates them (an explicit id wins).
const LEAGUE_CODES = { 'Premier League': 'pl', Championship: 'ch', 'Champions League': 'ucl', Bundesliga: 'bl', 'Serie A': 'sa', 'Ligue 1': 'l1' };
const slug = n => n.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const fid = f => f.id || `${LEAGUE_CODES[f.league]}-${f.kickoff.slice(0, 10).replace(/-/g, '')}-${slug(f.home).slice(0, 4)}-${slug(f.away).slice(0, 4)}`;

const pending = [];
for (const file of readdirSync(path.join(root, 'data/rounds')).filter(f => f.endsWith('.json'))) {
  const round = JSON.parse(readFileSync(path.join(root, 'data/rounds', file), 'utf8'));
  for (const f of round.fixtures) {
    const id = fid(f);
    if (results[id] || Date.now() - Date.parse(f.kickoff) < 2.5 * 3600e3) continue;
    pending.push({ ...f, id });
  }
}
const conflicts = [], notFound = [];
let added = 0;
const bbcCache = new Map(), espnCache = new Map();
for (const f of pending) {
  const t = Date.parse(f.kickoff);
  const dayKey = `${f.league}|${f.kickoff.slice(0, 10)}`;
  if (!bbcCache.has(dayKey)) bbcCache.set(dayKey, bbcFixtures(f.league, t - 12 * 3600e3, t + 12 * 3600e3));
  const b = bbcCache.get(dayKey).find(x => x.hg != null && sameTeam(x.home, f.home) && sameTeam(x.away, f.away));
  const ymd = new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
  if (!espnCache.has(`${f.league}|${ymd}`)) espnCache.set(`${f.league}|${ymd}`, espnEvents(f.league, ymd));
  const ev = espnCache.get(`${f.league}|${ymd}`).find(e => {
    const c = e.competitions[0].competitors;
    const h = c.find(x => x.homeAway === 'home'), a = c.find(x => x.homeAway === 'away');
    return e.status.type.completed && sameTeam(h.team.displayName, f.home) && sameTeam(a.team.displayName, f.away);
  });
  const e = ev && (() => {
    const c = ev.competitions[0].competitors;
    return [Number(c.find(x => x.homeAway === 'home').score), Number(c.find(x => x.homeAway === 'away').score)];
  })();
  const sources = [];
  if (b) sources.push(['bbc.co.uk scores-fixtures', [b.hg, b.ag]]);
  if (e) sources.push(['ESPN', e]);
  if (!sources.length) { notFound.push(`${f.home} v ${f.away} (${f.kickoff.slice(0, 10)})`); continue; }
  if (sources.length === 2 && (sources[0][1][0] !== sources[1][1][0] || sources[0][1][1] !== sources[1][1][1])) {
    conflicts.push(`${f.home} v ${f.away}: BBC ${b.hg}-${b.ag}, ESPN ${e[0]}-${e[1]}`);
    continue;
  }
  results[f.id] = { kickoff: f.kickoff, score: sources[0][1], sources: sources.map(s => s[0]), note: sources.length === 1 ? 'single source' : '' };
  added++;
}
writeFileSync(resultsPath, JSON.stringify(results, null, 1) + '\n');
console.log(`results: ${added} added, ${notFound.length} not found, ${conflicts.length} conflicts`);
for (const c of conflicts) console.log('  conflict:', c);
for (const n of notFound) console.log('  not found:', n);
