#!/usr/bin/env node
// Grades the logged player-prop prices (data/props/log.jsonl, from tools/props.mjs)
// against what happened, using ESPN player match stats (data/raw/lineups, from
// tools/model/fetch-lineups.mjs). For each fixture the last prices logged before
// kick-off are used. Reports, per market:
//   - our model's log-loss and calibration on these props
//   - the return from backing every price our model rated as value (edge >= 5%, 10%)
// Unibet settles on Opta data and ESPN's counts can differ slightly, so a handful
// of outcomes may be graded differently from the bookmaker.
// Writes data/props/graded.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLineups } from './model/lineups.mjs';
import { norm } from './model/cross.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logPath = path.join(root, 'data/props/log.jsonl');
if (!existsSync(logPath)) { console.log('no props logged yet'); process.exit(0); }
const latest = new Map();
for (const line of readFileSync(logPath, 'utf8').split('\n').filter(Boolean)) {
  const e = JSON.parse(line);
  if (Date.parse(e.at) < Date.parse(e.kickoff)) latest.set(e.id, e);
}
const games = loadLineups(path.join(root, 'data/raw')).filter(g => g.home && g.away);
const words = s => new Set(norm(s).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !['fc', 'afc', 'city', 'united', 'town', 'the'].includes(w)));
const overlap = (a, b) => { const B = words(b); return [...words(a)].some(w => B.has(w)); };
const STAT = { fc: 'fc', sh: 'sh', sot: 'sot', yc: 'yc', rc: 'rc' };
const graded = [];
for (const e of latest.values()) {
  const t = Date.parse(e.kickoff);
  const g = games.find(x => Math.abs(x.t - t) < 6 * 3600e3 && overlap(x.homeName, e.home) && overlap(x.awayName, e.away));
  if (!g) continue;
  const players = [...g.home.players, ...g.away.players];
  for (const r of e.rows) {
    const n = norm(r.name);
    const p = players.find(x => norm(x.name) === n) || players.find(x => norm(x.name).split(' ').pop() === n.split(' ').pop() && norm(x.name)[0] === n[0]);
    // Did not play (absent, or an unused substitute): Unibet voids these bets.
    if (!p || !(p.start || p.subIn)) continue;
    const lu = e.lineups === 'confirmed' ? 'confirmed' : 'preLineups';
    if (r.mk === 'yc' && p.rc) { graded.push({ ...r, lu, won: true }); continue; } // "to get a card" includes reds
    graded.push({ ...r, lu, won: (p[STAT[r.mk]] || 0) >= r.k, started: p.start });
  }
}
const summary = {};
// 'confirmed' and 'preLineups': all markets, split by whether the price was logged
// after the team sheets were out (the site only flags value on confirmed starters).
for (const mk of ['fc', 'sh', 'sot', 'yc', 'rc', 'all', 'confirmed', 'preLineups']) {
  const rows = graded.filter(r => mk === 'all' || r.mk === mk || r.lu === mk);
  if (!rows.length) continue;
  const ll = rows.reduce((s, r) => s - Math.log(Math.min(Math.max(r.won ? r.prob : 1 - r.prob, 1e-6), 1)), 0) / rows.length;
  const value = th => { const b = rows.filter(r => r.prob * r.odds - 1 >= th); const ret = b.reduce((s, r) => s + (r.won ? r.odds - 1 : -1), 0); return { bets: b.length, profit: +ret.toFixed(2), roi: b.length ? +(ret / b.length).toFixed(3) : null }; };
  summary[mk] = { n: rows.length, logloss: +ll.toFixed(4), modelAvg: +(rows.reduce((s, r) => s + r.prob, 0) / rows.length).toFixed(3),
    actualRate: +(rows.filter(r => r.won).length / rows.length).toFixed(3), unibetAvg: +(rows.reduce((s, r) => s + 1 / r.odds, 0) / rows.length).toFixed(3),
    value5: value(0.05), value10: value(0.1) };
}
writeFileSync(path.join(root, 'data/props/graded.json'), JSON.stringify({ generatedAt: new Date().toISOString(), fixtures: latest.size, graded: graded.length, summary }, null, 1) + '\n');
console.log(`graded ${graded.length} prop prices from ${latest.size} fixtures`);
console.log(JSON.stringify(summary, null, 1));
