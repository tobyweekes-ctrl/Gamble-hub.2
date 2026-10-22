#!/usr/bin/env node
// Unibet player props and match totals (fouls, shots, shots on target, cards) for
// every fixture in the round that has not kicked off, from the Kambi feed
// (tools/research/kambi.mjs). Stored on each fixture as f.props, then the seed is
// rebuilt so the site can set each price against our player model. Every price
// and our chance for it are appended to data/props/log.jsonl, so the player model
// can be graded against the bookmaker once results are in (tools/grade-props.mjs).
//
// Usage: node tools/props.mjs [data/rounds/<round>.json]
import { readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kambiEvents, kambiEventOffers, parseKambiOffers } from './research/kambi.mjs';
import { loadApp } from './lib/app.mjs';
import { norm } from './model/cross.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roundsDir = path.join(root, 'data/rounds');
const roundPath = process.argv.slice(2).find(a => a.endsWith('.json')) || path.join(roundsDir, readdirSync(roundsDir).filter(f => f.endsWith('.json')).sort().pop());
const round = JSON.parse(readFileSync(roundPath, 'utf8'));
const now = Date.now();

// Unibet's names against ours: both teams must share a word (after a few aliases).
const ALIAS = { "nott'm forest": 'nottingham forest', 'man city': 'manchester city', 'man united': 'manchester united', spurs: 'tottenham', 'inter milan': 'inter internazionale', 'ac milan': 'milan', 'paris saint-germain': 'paris psg', 'olympique lyonnais': 'lyon', 'bayer 04 leverkusen': 'leverkusen', 'borussia mgladbach': 'monchengladbach gladbach', "borussia m'gladbach": 'monchengladbach gladbach', 'köln': 'koln cologne', 'hamburger sv': 'hamburg hsv' };
const STOP = new Set(['fc', 'afc', 'the', 'and', 'city', 'united', 'town', 'club', 'de', 'ac', 'sc', 'sv']);
const words = s => new Set(norm(ALIAS[norm(s)] || s).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)));
const same = (a, b) => { const A = words(a), B = words(b); return [...A].some(w => B.has(w)) || (!A.size || !B.size ? norm(a) === norm(b) : false); };

const events = {};
let found = 0, prices = 0;
for (const f of round.fixtures) {
  const t = Date.parse(f.kickoff);
  if (!(t > now)) continue;
  events[f.league] ??= kambiEvents(f.league);
  const ev = events[f.league].map(e => e.event).find(e => Math.abs(Date.parse(e.start) - t) < 3 * 3600e3 && same(e.homeName, f.home) && same(e.awayName, f.away));
  if (!ev) continue;
  const parsed = parseKambiOffers(kambiEventOffers(ev.id), ev.homeName, ev.awayName);
  if (!parsed.players.length && !parsed.totals.length) continue;
  f.props = { source: 'Unibet (Kambi feed)', at: new Date(now).toISOString(), eventId: ev.id, homeName: ev.homeName, awayName: ev.awayName, ...parsed };
  found++; prices += parsed.players.length + parsed.totals.length;
}
writeFileSync(roundPath, JSON.stringify(round, null, 1) + '\n');
console.log(`props: ${found} fixtures, ${prices} prices from Unibet`);
execFileSync('node', ['tools/build-seed.mjs', path.relative(root, roundPath)], { cwd: root, stdio: 'inherit' });

// Log what the site now shows: every matched price with our chance.
const app = loadApp(readFileSync(path.join(root, 'index.html'), 'utf8'));
mkdirSync(path.join(root, 'data/props'), { recursive: true });
const logPath = path.join(root, 'data/props/log.jsonl');
let logged = 0;
for (const m of app.SEED_MATCHES) {
  if (!m.props || m.props.at !== new Date(now).toISOString()) continue;
  const rows = app.propRows(m).rows.map(r => ({ name: r.name, team: r.team, mk: r.mk, k: r.k, odds: r.odds, prob: +r.prob.toFixed(4), extra: r.extra }));
  const tot = app.propTotals(m).map(r => ({ name: r.name, label: r.label, odds: r.odds, prob: +r.prob.toFixed(4) }));
  appendFileSync(logPath, JSON.stringify({ at: m.props.at, id: m.id, league: m.league, kickoff: m.kickoff, home: m.home, away: m.away, lineups: m.lineupStatusH, rows, totals: tot }) + '\n');
  logged += rows.length;
}
console.log(`props: ${logged} player prices logged with our chances (data/props/log.jsonl)`);
