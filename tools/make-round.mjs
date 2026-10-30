#!/usr/bin/env node
// Builds a round file (data/rounds/<seedVersion>.json) with no manual research:
// BBC Sport fixtures and tables, kickoff.co.uk Bet365 prices. Scope as agreed:
// Premier League, Championship and Champions League in full; Bundesliga, Serie A
// and Ligue 1 only for fixtures involving a current top-4 side.
//
// Usage: node tools/make-round.mjs [--days 7] [--from ISO]
// Prints the path written. Gaps (no price, no table) stay empty and are listed.

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPETITIONS, bbcTable, bbcFixtures, espnEvents, sameTeam, kickoffMatchPage, kickoffPrices } from './research/sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const from = arg('--from') ? Date.parse(arg('--from')) : Date.now();
const to = from + Number(arg('--days', 7)) * 864e5;
const TOP4_ONLY = new Set(['Bundesliga', 'Serie A', 'Ligue 1']);

const ukDate = utc => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(utc));
const ukIso = utc => {
  const d = new Date(utc);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' })
    .formatToParts(d).map(p => [p.type, p.value]));
  const off = parts.timeZoneName === 'GMT' ? '+00:00' : '+0' + parts.timeZoneName.replace('GMT+', '') + ':00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00${off}`;
};
const label = t => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t)).replace(',', '');

const tables = {}, fixtures = [], gaps = [];
const LEAGUES = Object.keys(COMPETITIONS).filter(l => !COMPETITIONS[l].cup);
for (const league of LEAGUES) {
  if (league !== 'Champions League') {
    const t = bbcTable(league);
    if (t) tables[league] = { source: 'bbc.co.uk table', asOf: ukDate(Date.now()), teams: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { pos: v.pos, p: v.p, gf: v.gf, ga: v.ga }])) };
    else gaps.push(`${league}: table not found`);
  }
  const top4 = tables[league] ? Object.entries(tables[league].teams).filter(([, v]) => v.pos <= 4).map(([k]) => k) : [];
  const bbcList = bbcFixtures(league, from, to);
  // ESPN fills fixtures BBC does not list (BBC left out a whole Bundesliga Saturday,
  // 31 Oct 2026). Names are put in the BBC table's spelling where one matches.
  // Strict: every word of the shorter name appears in the longer one ("Bayern Munich"
  // = "FC Bayern Munich"), so "Borussia Mönchengladbach" never becomes "Borussia Dortmund".
  const w = n => n.replace(/^Internazionale$/, 'Inter Milan').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length > 1 && !['fc', 'afc'].includes(x));
  const same = (a, b) => { const A = w(a), B = w(b), [s1, l1] = A.length <= B.length ? [A, B] : [B, A]; return s1.length > 0 && s1.every(x => l1.includes(x)); };
  const tableName = n => (tables[league] && Object.keys(tables[league].teams).find(k => same(k, n))) || n;
  for (let t = from; t <= to; t += 864e5) {
    for (const e of espnEvents(league, new Date(t).toISOString().slice(0, 10).replace(/-/g, ''))) {
      const c = e.competitions[0].competitors, at = Date.parse(e.date);
      if (e.status.type.state !== 'pre' || at < from || at > to) continue;
      const home = tableName(c.find(x => x.homeAway === 'home').team.displayName), away = tableName(c.find(x => x.homeAway === 'away').team.displayName);
      if (bbcList.some(b => Math.abs(Date.parse(b.utc) - at) < 36 * 3600e3 && (same(b.home, home) || sameTeam(b.home, home)) && (same(b.away, away) || sameTeam(b.away, away)))) continue;
      bbcList.push({ home, away, utc: new Date(at).toISOString(), status: 'PreEvent', espnOnly: true });
    }
  }
  for (const f of bbcList) {
    if (f.status === 'PostEvent') continue;
    if (TOP4_ONLY.has(league) && !top4.includes(f.home) && !top4.includes(f.away)) continue;
    const url = kickoffMatchPage(league, f.home, f.away);
    const pr = url ? kickoffPrices(url, ukDate(f.utc)) : null;
    const src = 'kickoff.co.uk match page (Bet365), ' + ukDate(Date.now());
    const form = [];
    if (TOP4_ONLY.has(league)) {
      const inTop = [f.home, f.away].filter(n => top4.includes(n));
      form.push(`Included because ${inTop.join(' and ')} ${inTop.length === 1 ? 'is' : 'are'} in the ${league} top 4.`);
    }
    form.push(`Fixture and kick-off from ${f.espnOnly ? 'ESPN (single source: BBC does not list it)' : 'BBC Sport'}${pr ? ', date matched on kickoff.co.uk' : ''}.${pr ? ' Prices are a single source (Bet365).' : ''}`);
    if (!pr || !pr.x12) gaps.push(`${league}: ${f.home} v ${f.away}: no price found`);
    fixtures.push({
      league, home: f.home, away: f.away, kickoff: ukIso(f.utc),
      odds1x2: pr && pr.x12 ? [{ source: src, ...pr.x12 }] : [],
      oddsBtts: pr && pr.btts ? [{ source: src, ...pr.btts }] : [],
      oddsOu25: pr && pr.ou25 ? [{ source: src, ...pr.ou25 }] : [],
      kickoffUrl: url || null,
      form: form.join(' '),
    });
  }
}
fixtures.sort((a, b) => (a.kickoff < b.kickoff ? -1 : 1));
const seedVersion = `${ukDate(from)}-weekly`;
const round = {
  seedVersion,
  dataUpdated: label(Date.now()),
  notes: [
    `${label(from)} to ${label(to)}. Premier League, Championship and Champions League in full; Bundesliga, Serie A and Ligue 1 games with a top-4 side.`,
    `Fixtures and tables: BBC Sport. Prices: Bet365 via kickoff.co.uk match pages. Predictions: our own model (tools/model/).`,
    ...(gaps.length ? [`Gaps: ${gaps.join('; ')}.`] : []),
  ],
  leagues: LEAGUES,
  leagueQuality: Object.fromEntries(LEAGUES.map(l => [l, 'researched'])),
  tables, fixtures,
};
mkdirSync(path.join(root, 'data/rounds'), { recursive: true });
const out = path.join(root, 'data/rounds', `${seedVersion}.json`);
writeFileSync(out, JSON.stringify(round, null, 1) + '\n');
console.log(`${fixtures.length} fixtures, ${gaps.length} gaps -> ${path.relative(root, out)}`);
for (const g of gaps) console.log('  gap:', g);
