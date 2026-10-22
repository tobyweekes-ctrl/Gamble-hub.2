#!/usr/bin/env node
// Lineup-time update, run shortly after team sheets come out (scheduled Fri 19:00,
// Sat 11:20 / 14:00 / 17:00, Sun 13:00 / 15:15 UK time). For the current round:
//   1. results: finished fixtures get their scores (tools/results.mjs)
//   2. lineups: confirmed XIs from ESPN, with the regulars missing from each side
//   3. prices: Bet365 prices refreshed for every fixture not yet kicked off
//   4. season simulator refreshed, then tools/build-seed.mjs with the same round,
//      tagged with the time
// The model's numbers change with lineups only if the backtest enabled the lineup
// effects (data/model/context.json -> lineup.enabled).
//
// Usage: node tools/lineup-update.mjs [data/rounds/<round>.json]

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kickoffMatchPage, kickoffPrices, sameTeam } from './research/sources.mjs';
import { loadLineups, teamHistory, lineupFeatures, missingRegulars, usualXI, recentSquad } from './model/lineups.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roundsDir = path.join(root, 'data/rounds');
const roundPath = process.argv[2] || path.join(roundsDir, readdirSync(roundsDir).filter(f => f.endsWith('.json')).sort().pop());
const round = JSON.parse(readFileSync(roundPath, 'utf8'));
const now = Date.now();
const run = (...a) => execFileSync('node', a, { cwd: root, stdio: 'inherit' });
const ukDate = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(t));
const label = t => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t)).replace(',', '');

// 1. Results
run('tools/results.mjs');

// 2. Lineups (the last 150 days of lineups give every team's usual XI)
run('tools/model/fetch-lineups.mjs', '--since', new Date(now - 150 * 864e5).toISOString().slice(0, 10), '--upcoming');
const lineups = loadLineups(path.join(root, 'data/raw'), { includeUpcoming: true });
const hist = teamHistory(lineups);
const upcoming = lineups.filter(l => l.upcoming);
let withLineups = 0, probable = 0, priced = 0;
// Starters changed from the team's previous match (ESPN data), for "N changes from last game".
const changesFromLast = (team, t) => {
  const prev = (hist.get(team.id) || []).filter(x => x.t < t - 3600e3).pop();
  if (!prev) return null;
  const last = prev.players.filter(p => p.start), now = team.players.filter(p => p.start);
  const lastIds = new Set(last.map(p => p.id)), nowIds = new Set(now.map(p => p.id));
  const sur = n => n.split(' ').slice(-1)[0];
  return { n: now.filter(p => !lastIds.has(p.id)).length, out: last.filter(p => !nowIds.has(p.id)).map(p => sur(p.name)), in: now.filter(p => !lastIds.has(p.id)).map(p => sur(p.name)) };
};
for (const f of round.fixtures) {
  const t = Date.parse(f.kickoff);
  const u = upcoming.find(x => Math.abs(x.t - t) < 3 * 3600e3 && sameTeam(x.homeName, f.home) && sameTeam(x.awayName, f.away));
  const l = u && u.home && u.away ? u : null;
  // Before team sheets: each side's usual XI, for the player markets (labelled probable).
  if (u && !l && t > now) {
    const h = usualXI(hist, u.homeId, u.t), a = usualXI(hist, u.awayId, u.t);
    if (h && a) {
      const inXI = (list, xi) => (list || []).filter(p => !xi.some(x => x.id === p.id));
      f.probableXI = {
        source: 'ESPN, most-started players in the last 8 matches', at: new Date(now).toISOString(), home: h, away: a,
        // The rest of each squad, for bookmaker lists that include squad players.
        homeExtra: inXI(recentSquad(hist, u.homeId, u.t), h), awayExtra: inXI(recentSquad(hist, u.awayId, u.t), a),
      };
      probable++;
    }
  }
  if (l) {
    const side = team => {
      const feats = lineupFeatures(hist, team, l.t);
      return {
        team: team.name, formation: team.formation,
        xi: team.players.filter(p => p.start).map(p => p.name),
        missing: missingRegulars(hist, team, l.t),
        starters: team.players.filter(p => p.start).map(p => ({ id: p.id, name: p.name, pos: p.pos })),
        bench: team.players.filter(p => !p.start).map(p => ({ id: p.id, name: p.name, pos: p.pos })),
        reg: feats ? +feats.reg.toFixed(3) : null, att: feats ? +feats.att.toFixed(3) : null,
        backupKeeper: feats ? feats.gk : null, history: feats ? feats.n : 0,
        changes: changesFromLast(team, l.t),
      };
    };
    f.lineups = { source: 'ESPN', at: new Date(now).toISOString(), home: side(l.home), away: side(l.away) };
    delete f.probableXI;
    withLineups++;
  }
  // 3. Prices, for fixtures not yet started
  if (t > now) {
    const url = f.kickoffUrl || kickoffMatchPage(f.league, f.home, f.away);
    const pr = url ? kickoffPrices(url, ukDate(t)) : null;
    if (pr && pr.x12) {
      const src = `kickoff.co.uk match page (Bet365), ${label(now)}`;
      f.odds1x2 = [{ source: src, ...pr.x12 }];
      if (pr.btts) f.oddsBtts = [{ source: src, ...pr.btts }];
      if (pr.ou25) f.oddsOu25 = [{ source: src, ...pr.ou25 }];
      f.kickoffUrl = url;
      priced++;
    }
  }
}
round.updateTag = label(now);
round.dataUpdated = label(now);
writeFileSync(roundPath, JSON.stringify(round, null, 1) + '\n');
console.log(`lineup update: ${withLineups} fixtures with confirmed lineups, ${probable} with probable XIs, ${priced} prices refreshed`);

// 4. Season simulator (uses the results added above), then rebuild
run('tools/model/season-sim.mjs');
run('tools/build-seed.mjs', path.relative(root, roundPath));
// 5. Unibet player props and totals for games not yet started (rebuilds the seed
//    again), and grading of logged props for games now finished.
try { run('tools/props.mjs', path.relative(root, roundPath)); run('tools/grade-props.mjs'); } catch (e) { console.warn('props step failed:', e.message); }
