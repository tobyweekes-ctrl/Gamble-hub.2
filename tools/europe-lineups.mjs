#!/usr/bin/env node
// Confirmed lineups for this round's European ties (Europa League, Conference
// League), run once team sheets are out (about an hour before kick-off):
//   - each side's starting XI and bench from ESPN
//   - its usual XI: the most-started players in its last 8 competitive matches,
//     any competition (ESPN team schedules; friendlies left out)
//   - regulars missing, share of regulars starting, back-up goalkeeper
// Stored on the fixture as f.lineups, in the same shape as tools/lineup-update.mjs.
// The cross-league model's numbers do not change with lineups: the same lineup
// measures did not improve predictions on past seasons (data/model/context.json),
// so the site shows them and flags heavy rotation instead.
//
// Usage: node tools/europe-lineups.mjs [--hours 3] [data/rounds/<round>.json]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm } from './model/cross.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const hours = args.includes('--hours') ? +args[args.indexOf('--hours') + 1] : 3;
const roundsDir = path.join(root, 'data/rounds');
const roundPath = args.find(a => a.endsWith('.json')) || path.join(roundsDir, readdirSync(roundsDir).filter(f => f.endsWith('.json')).sort().pop());
const round = JSON.parse(readFileSync(roundPath, 'utf8'));
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const LEAGUE = { 'Europa League': 'uefa.europa', 'Conference League': 'uefa.europa.conf', 'Champions League': 'uefa.champions' };
const now = Date.now();
const label = t => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t)).replace(',', '');

const get = url => new Promise((resolve, reject) => execFile('curl', ['-sSf', '--compressed', '-m', '60', url], { maxBuffer: 64e6 },
  (err, out) => (err ? reject(new Error(`${url}: ${err.message.split('\n')[0]}`)) : resolve(JSON.parse(out)))));
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); } }));
  return out;
}
// ESPN spellings that share no word with UEFA's.
const ESPN_ALIAS = { 'crvena zvezda': 'red star belgrade', copenhagen: 'kobenhavn', 'h. beer-sheva': "hapoel be'er sheva", 'univ. craiova': 'csu craiova' };
const words = s => new Set(norm(ESPN_ALIAS[norm(s)] || s).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !['fc', 'afc', 'club', 'the'].includes(w)));
const overlap = (a, b) => { const B = new Set([...words(b), ...words(ESPN_ALIAS[norm(b)] || b)]); return [...words(a)].some(w => B.has(w) || [...B].some(x => x.length >= 4 && w.length >= 4 && (x.startsWith(w) || w.startsWith(x)))); };
const starters = (summary, teamId) => {
  const r = (summary.rosters || []).find(x => String(x.team.id) === String(teamId));
  if (!r || !r.roster || !r.roster.some(p => p.starter)) return null;
  return { formation: r.formation || null, players: r.roster.map(p => ({ id: String(p.athlete.id), name: p.athlete.displayName, pos: p.position?.abbreviation || '', start: !!p.starter })) };
};

const due = round.fixtures.filter(f => f.uefa && LEAGUE[f.league] && Date.parse(f.kickoff) > now - 2 * 3600e3 && Date.parse(f.kickoff) < now + hours * 3600e3);
const boards = {};
for (const lg of new Set(due.map(f => LEAGUE[f.league]))) {
  const days = [...new Set(due.map(f => f.kickoff.slice(0, 10).replace(/-/g, '')))];
  boards[lg] = (await Promise.all(days.map(d => get(`${BASE}/${lg}/scoreboard?dates=${d}`)))).flatMap(b => b.events || []);
}
let found = 0;
for (const f of due) {
  const t = Date.parse(f.kickoff);
  const ev = boards[LEAGUE[f.league]].find(e => {
    const c = e.competitions[0].competitors, h = c.find(x => x.homeAway === 'home'), a = c.find(x => x.homeAway === 'away');
    return Math.abs(Date.parse(e.date) - t) < 3 * 3600e3 && (overlap(h.team.displayName, f.home) || overlap(a.team.displayName, f.away));
  });
  if (!ev) { console.log(`${f.home} v ${f.away}: not found on ESPN`); continue; }
  const comp = ev.competitions[0];
  const side = ha => comp.competitors.find(c => c.homeAway === ha).team;
  const summary = await get(`${BASE}/${LEAGUE[f.league]}/summary?event=${ev.id}`);
  const H = starters(summary, side('home').id), A = starters(summary, side('away').id);
  if (!H || !A) { console.log(`${f.home} v ${f.away}: team sheets not out yet`); continue; }
  // Usual XI: the last 8 competitive matches before this one, any competition.
  const usual = async team => {
    const sch = await get(`${BASE}/all/teams/${team.id}/schedule`);
    const past = (sch.events || []).filter(e => e.league?.slug !== 'club.friendly' && Date.parse(e.date) < t - 3600e3
      && /FULL_TIME|FINAL/.test(e.competitions[0].status?.type?.name || '')).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 8);
    const games = (await pool(past, 6, e => get(`${BASE}/${e.league?.slug || 'all'}/summary?event=${e.id}`))).map(s => s && starters(s, team.id)).filter(Boolean);
    const counts = new Map(), info = new Map();
    for (const g of games) for (const p of g.players) { info.set(p.id, p); if (p.start) counts.set(p.id, (counts.get(p.id) || 0) + 1); }
    // The XI from the most recent of those matches, for "changes from last game".
    const lastIdx = games.length ? 0 : -1;
    return { n: games.length, counts, info, last: lastIdx >= 0 ? { ids: new Set(games[0].players.filter(p => p.start).map(p => p.id)), names: new Map(games[0].players.map(p => [p.id, p.name])) } : null };
  };
  const build = async (team, xi) => {
    const u = await usual(team);
    const rate = id => (u.n ? (u.counts.get(id) || 0) / u.n : 0);
    const top = [...u.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 11);
    const starting = xi.players.filter(p => p.start);
    const ids = new Set(starting.map(p => p.id));
    const usualSum = top.reduce((s, [id]) => s + rate(id), 0);
    const gk = starting.find(p => p.pos === 'G' || p.pos === 'GK');
    const enough = u.n >= 4;
    return {
      team: team.displayName, formation: xi.formation, xi: starting.map(p => p.name),
      missing: enough ? top.filter(([id]) => !ids.has(id)).map(([id, c]) => ({ name: u.info.get(id).name, started: `${c}/${u.n}` })) : null,
      starters: starting.map(p => ({ id: p.id, name: p.name, pos: p.pos })), bench: xi.players.filter(p => !p.start).map(p => ({ id: p.id, name: p.name, pos: p.pos })),
      reg: enough && usualSum ? +(starting.reduce((s, p) => s + rate(p.id), 0) / usualSum).toFixed(3) : null, att: null,
      backupKeeper: enough && gk ? rate(gk.id) < 0.5 : null, history: u.n,
      changes: u.last ? { n: starting.filter(p => !u.last.ids.has(p.id)).length,
        out: [...u.last.ids].filter(id => !ids.has(id)).map(id => u.last.names.get(id).split(' ').slice(-1)[0]),
        in: starting.filter(p => !u.last.ids.has(p.id)).map(p => p.name.split(' ').slice(-1)[0]) } : null,
    };
  };
  f.lineups = { source: 'ESPN', at: new Date(now).toISOString(), home: await build(side('home'), H), away: await build(side('away'), A) };
  found++;
  const s = x => `${x.team} ${x.changes ? x.changes.n + ' changes (out ' + x.changes.out.join(', ') + ')' : '? changes'}`;
  console.log(`${f.home} v ${f.away}: ${s(f.lineups.home)}; ${s(f.lineups.away)}`);
}
round.updateTag = label(now);
round.dataUpdated = label(now);
writeFileSync(roundPath, JSON.stringify(round, null, 1) + '\n');
console.log(`european lineups: ${found} of ${due.length} fixtures`);
execFileSync('node', ['tools/build-seed.mjs', path.relative(root, roundPath)], { cwd: root, stdio: 'inherit' });
