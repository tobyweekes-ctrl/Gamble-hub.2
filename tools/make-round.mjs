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
import { COMPETITIONS, bbcTable, bbcFixtures, kickoffMatchPage, kickoffPrices } from './research/sources.mjs';

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
for (const league of Object.keys(COMPETITIONS)) {
  if (league !== 'Champions League') {
    const t = bbcTable(league);
    if (t) tables[league] = { source: 'bbc.co.uk table', asOf: ukDate(Date.now()), teams: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { pos: v.pos, p: v.p, gf: v.gf, ga: v.ga }])) };
    else gaps.push(`${league}: table not found`);
  }
  const top4 = tables[league] ? Object.entries(tables[league].teams).filter(([, v]) => v.pos <= 4).map(([k]) => k) : [];
  for (const f of bbcFixtures(league, from, to)) {
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
    form.push(`Fixture and kick-off from BBC Sport${pr ? ', date matched on kickoff.co.uk' : ''}.${pr ? ' Prices are a single source (Bet365).' : ''}`);
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
  leagues: Object.keys(COMPETITIONS),
  leagueQuality: Object.fromEntries(Object.keys(COMPETITIONS).map(l => [l, 'researched'])),
  tables, fixtures,
};
mkdirSync(path.join(root, 'data/rounds'), { recursive: true });
const out = path.join(root, 'data/rounds', `${seedVersion}.json`);
writeFileSync(out, JSON.stringify(round, null, 1) + '\n');
console.log(`${fixtures.length} fixtures, ${gaps.length} gaps -> ${path.relative(root, out)}`);
for (const g of gaps) console.log('  gap:', g);
