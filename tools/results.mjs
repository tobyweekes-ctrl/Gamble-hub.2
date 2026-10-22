#!/usr/bin/env node
// Adds final scores for finished fixtures to data/results.json. Every fixture in
// data/rounds/*.json whose kick-off is over 2.5 hours ago and has no result yet is
// looked up on BBC Sport and on ESPN. Both agree -> two sources. Only one found ->
// stored with "single source". They disagree -> not stored; listed as a conflict.
//
// Usage: node tools/results.mjs

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bbcFixtures, espnEvents, sameTeam } from './research/sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsPath = path.join(root, 'data/results.json');
const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {};

// Fixture ids exactly as tools/build-seed.mjs generates them (an explicit id wins).
const LEAGUE_CODES = { 'Premier League': 'pl', Championship: 'ch', 'Champions League': 'ucl', 'Europa League': 'uel', 'Conference League': 'uecl', Bundesliga: 'bl', 'Serie A': 'sa', 'Ligue 1': 'l1' };
// European competitions: UEFA's own match data (90-minute score) and ESPN, in place of BBC.
const UEFA_COMP = { 'Champions League': 1, 'Europa League': 14, 'Conference League': 2019 };
const ESPN_EURO = { 'Champions League': 'uefa.champions', 'Europa League': 'uefa.europa', 'Conference League': 'uefa.europa.conf' };
const uefaCache = new Map();
const uefaDay = (league, ymd) => {
  const k = `${league}|${ymd}`;
  if (!uefaCache.has(k)) {
    try { uefaCache.set(k, JSON.parse(execFileSync('curl', ['-sSf', '-m', '60', `https://match.uefa.com/v5/matches?competitionId=${UEFA_COMP[league]}&fromDate=${ymd}&toDate=${ymd}&limit=100&offset=0&order=ASC`], { encoding: 'utf8' }))); }
    catch { uefaCache.set(k, []); }
  }
  return uefaCache.get(k);
};
const espnEuro = (league, ymd) => {
  try { return JSON.parse(execFileSync('curl', ['-sSf', '--compressed', '-m', '60', `https://site.api.espn.com/apis/site/v2/sports/soccer/${ESPN_EURO[league]}/scoreboard?dates=${ymd}`], { encoding: 'utf8', maxBuffer: 64e6 })).events || []; }
  catch { return []; }
};
const ESPN_ALIAS = { 'crvena zvezda': 'red star', copenhagen: 'kobenhavn', 'h. beer-sheva': 'hapoel', 'univ. craiova': 'craiova', 'l. red imps': 'lincoln', 'iberia tbilisi': 'iberia', aarhus: 'agf', 'n.e.c.': 'nec', rennes: 'stade rennais', 'gnk dinamo': 'dinamo zagreb' };
const nrm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ø/g, 'o');
const euroSame = (espnName, ours) => {
  const w = s => new Set(nrm(s).split(/[^a-z0-9]+/).filter(x => x.length > 2 && !['fc', 'afc', 'club'].includes(x)));
  const A = w(espnName), B = new Set([...w(ours), ...w(ESPN_ALIAS[nrm(ours)] || '')]);
  return [...A].some(x => B.has(x) || [...B].some(y => x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))));
};
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
  if (UEFA_COMP[f.league]) {
    const ymd = new Date(t).toISOString().slice(0, 10);
    const u = uefaDay(f.league, ymd).find(m => m.status === 'FINISHED' && m.homeTeam?.internationalName === (f.uefa?.home || f.home) && m.awayTeam?.internationalName === (f.uefa?.away || f.away));
    const us = u && (u.score?.regular || u.score?.total);
    const ev = espnEuro(f.league, ymd.replace(/-/g, '')).find(e => {
      const c = e.competitions[0].competitors, h = c.find(x => x.homeAway === 'home'), a = c.find(x => x.homeAway === 'away');
      return e.status.type.completed && euroSame(h.team.displayName, f.home) && euroSame(a.team.displayName, f.away);
    });
    const es = ev && (c => [Number(c.find(x => x.homeAway === 'home').score), Number(c.find(x => x.homeAway === 'away').score)])(ev.competitions[0].competitors);
    const src = [];
    if (us) src.push(['match.uefa.com', [us.home, us.away]]);
    if (es) src.push(['ESPN', es]);
    if (!src.length) { notFound.push(`${f.home} v ${f.away} (${f.kickoff.slice(0, 10)})`); continue; }
    if (src.length === 2 && (src[0][1][0] !== src[1][1][0] || src[0][1][1] !== src[1][1][1])) { conflicts.push(`${f.home} v ${f.away}: UEFA ${us.home}-${us.away}, ESPN ${es[0]}-${es[1]}`); continue; }
    results[f.id] = { kickoff: f.kickoff, score: src[0][1], sources: src.map(s => s[0]), note: src.length === 1 ? 'single source' : '' };
    added++;
    continue;
  }
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
