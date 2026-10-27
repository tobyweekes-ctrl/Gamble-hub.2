#!/usr/bin/env node
// Builds the fixture block of index.html from a round file, syncs matchday-ledger.html,
// and updates the repo ledger used by tools/fit-blend.mjs.
//
// Usage: node tools/build-seed.mjs data/rounds/<seedVersion>.json
//
// Reads:  the round file (format in data/README.md) and data/results.json.
// Writes: index.html (between the BEGIN/END GENERATED SEED markers),
//         matchday-ledger.html (identical copy) and data/ledger.json.
//
// Maths, as in the app:
// - 1X2: each source's decimal prices -> 1/price, normalised to remove the margin;
//   sources averaged; largest-remainder rounding to whole numbers summing to 100.
// - BTTS and Over 2.5: (1/yes) / (1/yes + 1/no) per source, averaged, rounded.
// - Goal rates: table goals for/against per game, regressed halfway to the league
//   average goals per team per game from the same table.
// - Our model (tools/model/): fitted on data/raw/ results with tools/model/config.json
//   and the context factors in data/model/context.json. No bookmaker price goes in.
// Nothing is filled in when a source is missing: the field stays null and the app
// shows the gap.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp, SEED_BEGIN, SEED_END } from './lib/app.mjs';
import { modelForRound } from './model/round.mjs';
import { liveRecord } from './model/live-record.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roundPath = process.argv[2];
if (!roundPath) {
  console.error('Usage: node tools/build-seed.mjs data/rounds/<seedVersion>.json');
  process.exit(2);
}
const round = JSON.parse(readFileSync(roundPath, 'utf8'));
const resultsPath = path.join(root, 'data/results.json');
const ledgerPath = path.join(root, 'data/ledger.json');
const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {};
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : [];
const RESULTS_DAYS = 28; // how far back SEED_RESULTS reaches for auto-grading in the browser

const LEAGUE_CODES = {
  'Premier League': 'pl', 'Championship': 'ch', 'Champions League': 'ucl', 'Europa League': 'uel', 'Conference League': 'uecl',
  'Bundesliga': 'bl', 'Serie A': 'sa', 'Ligue 1': 'l1', 'League Cup': 'elc',
};

function decimal(price) {
  if (typeof price === 'number') return price;
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(String(price));
  if (m) return 1 + Number(m[1]) / Number(m[2]);
  const n = Number(price);
  if (!Number.isFinite(n)) throw new Error(`Unreadable price ${price}`);
  return n;
}

function largestRemainder(shares) {
  const raw = shares.map(x => x * 100);
  const floor = raw.map(Math.floor);
  let left = 100 - floor.reduce((s, x) => s + x, 0);
  raw.map((x, i) => [x - floor[i], i]).sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => { if (left > 0) { floor[i]++; left--; } });
  return floor;
}

function threeWay(sources) {
  if (!sources || !sources.length) return null;
  const avg = [0, 0, 0];
  for (const s of sources) {
    const inv = [s.h, s.d, s.a].map(p => 1 / decimal(p));
    const t = inv[0] + inv[1] + inv[2];
    inv.forEach((x, i) => { avg[i] += x / t / sources.length; });
  }
  return largestRemainder(avg);
}

function twoWay(sources, yesKey, noKey) {
  if (!sources || !sources.length) return null;
  let avg = 0;
  for (const s of sources) {
    const y = 1 / decimal(s[yesKey]), n = 1 / decimal(s[noKey]);
    avg += y / (y + n) / sources.length;
  }
  return Math.round(avg * 100);
}

function slug(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

function fixtureId(f) {
  if (f.id) return f.id;
  const code = LEAGUE_CODES[f.league] || slug(f.league).slice(0, 3);
  return `${code}-${f.kickoff.slice(0, 10).replace(/-/g, '')}-${slug(f.home).slice(0, 4)}-${slug(f.away).slice(0, 4)}`;
}

function leagueAverage(table) {
  let goals = 0, games = 0;
  for (const t of Object.values(table.teams)) { goals += t.gf; games += t.p; }
  return games ? goals / games : null;
}

function rates(table, team, avg) {
  const t = table && table.teams[team];
  if (!t || !t.p || avg == null) return null;
  const r = x => +(((x / t.p) + avg) / 2).toFixed(3);
  return { gf: r(t.gf), ga: r(t.ga), row: t };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function tableLine(team, t) {
  if (!t) return `${team}: not in the table used.`;
  const pos = t.pos ? `${ordinal(t.pos)}, ` : '';
  return `${team}: ${pos}P${t.p} GF${t.gf} GA${t.ga}.`;
}

const model = modelForRound(root, round.fixtures.map(f => ({ ...f, id: fixtureId(f) })));
function lineupText(L, applied) {
  const side = s => {
    // The starting XI itself; changes from the last game are in the fixture's key points.
    const gk = s.backupKeeper ? ' (back-up goalkeeper starts)' : '';
    return `${s.team}${s.formation ? ` (${s.formation})` : ''}: ${(s.xi || []).join(', ')}${gk}.`;
  };
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(L.at));
  return `Confirmed lineups (${L.source}, ${when}). ${side(L.home)} ${side(L.away)}` +
    (applied ? ' Lineup effects measured in the backtest are applied to the model.' : '');
}


const seen = new Set();
const fixtures = round.fixtures.map(f => {
  const id = fixtureId(f);
  if (seen.has(id)) throw new Error(`Duplicate fixture id ${id}`);
  seen.add(id);
  const table = round.tables?.[f.league];
  const avg = table ? leagueAverage(table) : null;
  const h = rates(table, f.home, avg), a = rates(table, f.away, avg);
  const x = threeWay(f.odds1x2);
  const btts = twoWay(f.oddsBtts, 'yes', 'no');
  const ou25 = twoWay(f.oddsOu25, 'over', 'under');
  const priceSources = [...new Set([...(f.odds1x2 || []), ...(f.oddsBtts || []), ...(f.oddsOu25 || [])].map(s => s.source))];
  const mod = model.byId[id] || null;
  const firstPrice = (list, keys) => (list && list.length ? keys.map(k => decimal(list[0][k])) : null);
  const p1 = firstPrice(f.odds1x2, ['h', 'd', 'a']), pb = firstPrice(f.oddsBtts, ['yes', 'no']), po = firstPrice(f.oddsOu25, ['over', 'under']);
  const prices = p1 ? { source: f.odds1x2[0].source, h: p1[0], d: p1[1], a: p1[2],
    bttsY: pb ? pb[0] : null, bttsN: pb ? pb[1] : null, o25: po ? po[0] : null, u25: po ? po[1] : null } : null;
  const goalText = mod
    ? `Our model: fitted on league results to ${model.asOfLabel}. Table for reference: ${h ? tableLine(f.home, h.row) : f.home + ': no table.'} ${a ? tableLine(f.away, a.row) : f.away + ': no table.'}`
    : h && a
    ? `Goal rates from the ${f.league} table (${table.source}, ${table.asOf}), regressed halfway to the league average of ${avg.toFixed(3)} per team per game. ${tableLine(f.home, h.row)} ${tableLine(f.away, a.row)}`
    : 'No goal-rate table for at least one side, so the model column is the market price restated (market-implied).';
  const priceText = x
    ? `Prices: ${priceSources.join('; ')}. Margin removed${(f.odds1x2.length > 1) ? ', sources averaged' : ''}.${btts == null ? ' BTTS not priced.' : ''}${ou25 == null ? ' Over 2.5 not priced.' : ''}`
    : 'No 1X2 price found.';
  return {
    id, league: f.league, home: f.home, away: f.away, kickoff: f.kickoff,
    hw: x ? x[0] : null, dw: x ? x[1] : null, aw: x ? x[2] : null,
    btts, ou25,
    referee: f.referee || '', refCards: null,
    form: [f.form, priceText, goalText].filter(Boolean).join(' '),
    h2h: f.h2h || 'No H2H data pulled.',
    gfH: h ? h.gf : null, gaH: h ? h.ga : null, gfA: a ? a.gf : null, gaA: a ? a.ga : null,
    gfHome: null, gaHome: null, gfAway: null, gaAway: null,
    // Lineups are confirmed only once tools/lineup-update.mjs has found the team sheets.
    lineupFactorH: 1, lineupStatusH: f.lineups ? 'confirmed' : 'unconfirmed', lineupFactorA: 1, lineupStatusA: f.lineups ? 'confirmed' : 'unconfirmed',
    compFactorH: 1, compFactorA: 1,
    lineupNote: f.lineups ? lineupText(f.lineups, model.info.lineupEnabled)
      : f.teamNews ? `Reported, not confirmed, not applied to the maths: ${f.teamNews}`
      : 'Lineups not announced yet (they are added about an hour before kick-off). No team news applied.',
    compNote: '',
    prices,
    // Unibet player props and totals (tools/props.mjs), set against our model in the app.
    props: f.props || null,
    model: mod,
  };
});
for (const w of model.warnings) console.warn('model:', w);

const now = Date.now();
const seedResults = {};
for (const [id, r] of Object.entries(results)) {
  if (now - Date.parse(r.kickoff) <= RESULTS_DAYS * 864e5) seedResults[id] = r.score;
}

const leagues = round.leagues;
for (const f of fixtures) if (!leagues.includes(f.league)) throw new Error(`${f.id}: league ${f.league} missing from leagues`);
const quality = Object.fromEntries(leagues.map(l => [l, round.leagueQuality?.[l] || 'estimate']));
const empty = leagues.filter(l => !fixtures.some(f => f.league === l));
const header = (round.notes || []).map(n => `  // ${n}`).join('\n');

const block = `${SEED_BEGIN}: rewritten each round by tools/build-seed.mjs. Edit the round file in data/, not this block.
const SEED_MATCHES = [
${header ? header + '\n' : ''}${fixtures.map(f => '  ' + JSON.stringify(f) + ',').join('\n')}
];

const LEAGUE_ORDER = ${JSON.stringify(leagues)};
const LEAGUES_WITH_NO_SEED = ${JSON.stringify(empty)};

// Final scores for recent fixtures (id -> [home, away]). On load, any matching
// entry in this browser's prediction log is graded automatically.
const SEED_RESULTS = ${JSON.stringify(seedResults)};

// Model settings and backtest summary from tools/model/ (filled in by the build).
const MODEL_INFO = ${JSON.stringify(model.info)};

const DATA_UPDATED = ${JSON.stringify(round.dataUpdated)};
const SEED_VERSION = ${JSON.stringify(round.seedVersion + '@' + (round.updateTag || 'weekly') + ' build ' + new Date(now).toISOString().slice(0, 16))};
const LEAGUE_QUALITY = ${JSON.stringify(quality)};

// The model's live record: predictions logged before kick-off, graded (tools/model/live-record.mjs).
const LIVE_RECORD = __LIVE_RECORD__;
${SEED_END}`;

const indexPath = path.join(root, 'index.html');
const html = readFileSync(indexPath, 'utf8');
const a = html.indexOf(SEED_BEGIN), b = html.indexOf(SEED_END);
if (a < 0 || b < 0) throw new Error('Seed markers not found in index.html');
let out = html.slice(0, a) + block.replace('__LIVE_RECORD__', 'null') + html.slice(b + SEED_END.length);

// Ledger: snapshot market, goal-model-alone and blend for fixtures not yet kicked off,
// and attach results to graded ones. Entries are never changed after kick-off.
const app = loadApp(out);
const pct = t => t && { h: +t.h.toFixed(1), d: +t.d.toFixed(1), a: +t.a.toFixed(1) };
for (const m of app.SEED_MATCHES) {
  // Every fixture with a prediction is logged before kick-off, priced or not.
  if (Date.parse(m.kickoff) <= now || (m.hw == null && !m.model)) continue;
  const mp = app.computeModelProbs(m);
  let goalModel = null;
  if (mp && mp.basis === 'independent') {
    goalModel = pct({ h: mp.hw, d: mp.dw, a: mp.aw });
  } else if (mp && mp.basis === 'anchored') {
    const rateH = mp.seasonExpH * mp.lineupFactorApplied.h * mp.compFactorApplied.h;
    const rateA = mp.seasonExpA * mp.lineupFactorApplied.a * mp.compFactorApplied.a;
    const q = app.quickProbs(rateH, rateA);
    goalModel = pct({ h: q.hw * 100, d: q.dw * 100, a: q.aw * 100 });
  }
  const entry = {
    id: m.id, league: m.league, fixture: `${m.home} vs ${m.away}`, kickoff: m.kickoff,
    loggedAt: new Date(now).toISOString(), modelVersion: app.MODEL_VERSION, seedVersion: app.SEED_VERSION,
    market: { h: m.hw, d: m.dw, a: m.aw }, btts: m.btts, ou25: m.ou25,
    goalModel,
    // Our own BTTS / Over 2.5 chances (the btts/ou25 fields above are the market's).
    modelMarkets: m.model ? { btts: m.model.btts, ou25: m.model.ou25, expH: m.model.expH, expA: m.model.expA } : null,
    confidence: m.model && m.model.confidence ? m.model.confidence.level : null,
    blend: mp && mp.basis === 'anchored' ? pct({ h: mp.hw, d: mp.dw, a: mp.aw }) : null,
    modelBasis: mp ? mp.basis : null, prices: m.prices || null,
    inputs: { gfH: m.gfH, gaH: m.gaH, gfA: m.gfA, gaA: m.gaA },
    result: null,
  };
  const i = ledger.findIndex(e => e.id === m.id && e.modelVersion === app.MODEL_VERSION);
  if (i >= 0) ledger[i] = entry; else ledger.push(entry);
}
let graded = 0;
for (const e of ledger) {
  const r = results[e.id];
  if (r && !e.result) { e.result = { home: r.score[0], away: r.score[1] }; graded++; }
}

const record = liveRecord(ledger);
out = out.replace('const LIVE_RECORD = null;', `const LIVE_RECORD = ${JSON.stringify(record)};`);
writeFileSync(indexPath, out);
writeFileSync(path.join(root, 'matchday-ledger.html'), out);
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1) + '\n');
console.log(`Built ${fixtures.length} fixtures (${empty.length ? 'no fixtures: ' + empty.join(', ') : 'every league has fixtures'}), ` +
  `${Object.keys(seedResults).length} recent results, seed ${round.seedVersion}. Ledger: ${ledger.length} entries, ${graded} newly graded.`);
