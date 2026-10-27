// Backtest: run the model on past games using only data from before each game.
//
//   node scripts/backtest.mjs [--season 2025-26] [--from 2025-11-01] [--to 2026-04-12]
//                             [--stats pts,reb,ast,fg3m,pra] [--set recency.last5=0.3 ...] [--dump] [--quiet]
//
// Reports three things, kept separate on purpose:
//   1. Projection accuracy and calibration: needs no lines; the real test of the model.
//   2. ROI vs ESTIMATED lines: there are no free historical prop lines, so each line is estimated
//      the way a book roughly would set it (recent form + season average, rounded to x.5, 1.91 both
//      sides). Real books are sharper than this, so real ROI will be lower; it is a sanity check,
//      not evidence of profit.
//   3. ROI vs REAL lines: graded from Odds API snapshots the app saved and manual lines you entered.
//      This sample grows as you use the app.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../server/env.mjs';
import { loadSeason, indexLeague, getLeague, today } from '../server/data/store.mjs';
import { loadClosingLines, listEntries } from '../server/data/userdata.mjs';
import { DEFAULTS, mergeConfig, parseOverride } from '../server/model/config.mjs';
import { buildContext } from '../server/model/context.mjs';
import { projectPlayer, projectStat } from '../server/model/projection.mjs';
import { evaluateLine, quality } from '../server/model/evaluate.mjs';
import { STATS, statValue } from '../server/stats.mjs';
import { seasonOf, prevSeason, addDays, mean, normName } from '../server/util.mjs';

// ---------- args ----------
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const overrides = args.flatMap((a, i) => (a === '--set' ? [parseOverride(args[i + 1])] : []));
const cfg = overrides.reduce((c, o) => mergeConfig(c, o), DEFAULTS);
const quiet = args.includes('--quiet');
const season = opt('season', prevSeason(seasonOf(today())));
const stats = opt('stats', Object.keys(STATS).join(',')).split(',');
const MIN_PRIOR_GAMES = Number(opt('min-games', 5));
const MIN_RECENT_MIN = Number(opt('min-minutes', 20));
const EST_PRICE = 1.91;

// ---------- data ----------
const t0 = Date.now();
const prev = prevSeason(season);
const [S1, S0] = await Promise.all([loadSeason(season), loadSeason(prev)]);
const seasons = { [season]: S1, [prev]: S0 };
const full = indexLeague({ current: season, previous: prev, seasons, today: '9999-12-31', source: S1.source });
const dates = [...new Set(S1.games.map((g) => g.date))].sort();
const from = opt('from', dates[0]);
const to = opt('to', dates.at(-1));
const testDates = dates.filter((d) => d >= from && d <= to);
if (!quiet) console.log(`backtest ${season} (${S1.source}) ${from} → ${to}: ${testDates.length} game days, stats ${stats.join(' ')}`);

// team-level stats from a weekly snapshot (no look-ahead; at most 6 days stale)
let snapshot = null, snapshotWeek = null;
const teamSnapshot = (date) => {
  const week = Math.floor(Date.parse(date) / (7 * 864e5));
  if (week !== snapshotWeek) {
    snapshotWeek = week;
    snapshot = indexLeague({ current: season, previous: prev, seasons, today: date, source: S1.source });
  }
  return snapshot;
};

// ---------- estimated line ----------
function estimatedLine(ctx, stat) {
  const v = (rows) => mean(rows.map((r) => statValue(r, stat)));
  const l10 = v(ctx.logs.slice(-10));
  const seasonAvg = ctx.curRows.length >= 10 ? v(ctx.curRows) : v([...ctx.prevRows.slice(-30), ...ctx.curRows]);
  const est = 0.6 * l10 + 0.4 * (Number.isFinite(seasonAvg) ? seasonAvg : l10);
  return Math.max(0.5, Math.floor(est) + 0.5);
}

// ---------- run ----------
const rec = []; // one record per player-game-stat
for (const date of testDates) {
  const T = teamSnapshot(date);
  const games = new Map();
  for (const r of S1.games) if (r.date === date) (games.get(`${r.gameId}|${r.team}`) || games.set(`${r.gameId}|${r.team}`, []).get(`${r.gameId}|${r.team}`)).push(r);
  for (const rows of games.values()) {
    const { team, opp, home } = rows[0];
    const lineup = new Set(rows.map((r) => r.playerId));
    // anyone who played for this team this season but not tonight = out (proxy for the injury report)
    const out = [...new Set(full.bySeason[season].rows.filter((r) => r.team === team && r.date < date).map((r) => r.playerId))].filter((id) => !lineup.has(id));
    for (const row of rows) {
      const prior = full.playerLogs(row.playerId).filter((r) => r.date < date);
      if (prior.length < MIN_PRIOR_GAMES || mean(prior.slice(-5).map((r) => r.min)) < MIN_RECENT_MIN) continue;
      const game = { date, team, opp, home };
      const ctx = buildContext(full, row.playerId, game, { T, teammatesOut: out });
      const pp = projectPlayer(ctx, cfg);
      const q = quality(ctx, pp.minutes);
      for (const stat of stats) {
        const sp = projectStat(pp, ctx, stat, cfg);
        if (!sp) continue;
        const actual = statValue(row, stat);
        const line = estimatedLine(ctx, stat);
        const e = evaluateLine(sp, { line, over: EST_PRICE, under: EST_PRICE }, q, cfg);
        const v = (rs) => mean(rs.map((r) => statValue(r, stat)));
        rec.push({
          date, stat, player: row.playerId, actual, mean: sp.mean, sd: sp.sd, minProj: pp.minutes.proj, minActual: row.min,
          baseSeason: ctx.curRows.length ? v(ctx.curRows) : v(ctx.prevRows), baseL10: v(ctx.logs.slice(-10)),
          line, pOver: e.model.over, side: e.side, confidence: e.confidence, outcome: actual > line ? 'over' : 'under',
        });
      }
    }
  }
}

// ---------- metrics ----------
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const mae = (xs, f) => mean(xs.map((x) => Math.abs(f(x) - x.actual)));
function accuracy(rs) {
  return {
    n: rs.length,
    maeModel: r3(mae(rs, (x) => x.mean)),
    maeSeasonAvg: r3(mae(rs.filter((x) => Number.isFinite(x.baseSeason)), (x) => x.baseSeason)),
    maeLast10: r3(mae(rs, (x) => x.baseL10)),
    maeEstLine: r3(mae(rs, (x) => x.line)),
    bias: r3(mean(rs.map((x) => x.mean - x.actual))),
    // > 1 means outcomes spread wider than the model's distributions predict (overconfident)
    spreadRatio: r3(Math.sqrt(mean(rs.map((x) => (x.actual - x.mean) ** 2))) / mean(rs.map((x) => x.sd))),
  };
}
function calibration(rs) {
  const brier = mean(rs.map((x) => (x.pOver - (x.outcome === 'over' ? 1 : 0)) ** 2));
  const baseRate = mean(rs.map((x) => (x.outcome === 'over' ? 1 : 0)));
  const ll = -mean(rs.map((x) => Math.log(Math.min(1 - 1e-9, Math.max(1e-9, x.outcome === 'over' ? x.pOver : 1 - x.pOver)))));
  const buckets = [];
  for (let b = 0; b < 10; b++) {
    const xs = rs.filter((x) => x.pOver >= b / 10 && x.pOver < (b + 1) / 10);
    if (xs.length >= 20) buckets.push({ range: `${b * 10}-${b * 10 + 10}%`, n: xs.length, predicted: r3(mean(xs.map((x) => x.pOver))), actual: r3(mean(xs.map((x) => (x.outcome === 'over' ? 1 : 0)))) });
  }
  return { brier: r3(brier), brierCoinFlip: 0.25, brierBaseRate: r3(baseRate * (1 - baseRate)), logLoss: r3(ll), overRate: r3(baseRate), buckets };
}
function roi(rs, price = EST_PRICE) {
  const bets = rs.filter((x) => x.side);
  const won = bets.filter((x) => x.side === x.outcome).length;
  const profit = won * (price - 1) - (bets.length - won);
  return { bets: bets.length, won, hitRate: r3(won / bets.length), roi: r3(profit / bets.length), breakEven: r3(1 / price) };
}

const byStat = Object.fromEntries(stats.map((s) => [s, rec.filter((x) => x.stat === s)]));
const minutesRecs = rec.filter((x) => x.stat === stats[0]);
const report = {
  season, source: S1.source, from, to, generated: new Date().toISOString(), config: overrides,
  sample: { playerGames: minutesRecs.length, predictions: rec.length },
  minutes: { n: minutesRecs.length, mae: r3(mae(minutesRecs.map((x) => ({ ...x, actual: x.minActual })), (x) => x.minProj)), bias: r3(mean(minutesRecs.map((x) => x.minProj - x.minActual))) },
  accuracy: Object.fromEntries(Object.entries(byStat).map(([s, rs]) => [s, accuracy(rs)])),
  calibration: { all: calibration(rec), ...Object.fromEntries(Object.entries(byStat).map(([s, rs]) => [s, calibration(rs)])) },
  estimatedLines: {
    label: 'ESTIMATED LINES - not real bookmaker prices. Line = 0.6 x last-10 avg + 0.4 x season avg, rounded to x.5, priced 1.91 both sides. Real books are sharper; expect real ROI to be lower.',
    threshold: cfg.threshold,
    all: roi(rec),
    byStat: Object.fromEntries(Object.entries(byStat).map(([s, rs]) => [s, roi(rs)])),
    byConfidence: Object.fromEntries(['HIGH', 'MEDIUM', 'LOW'].map((c) => [c, roi(rec.filter((x) => x.confidence === c))])),
  },
  realLines: await realLineBacktest(),
  seconds: Math.round((Date.now() - t0) / 100) / 10,
};

// ---------- real lines (saved snapshots + manual entries) ----------
async function realLineBacktest() {
  const L = await getLeague();
  const lines = [
    ...loadClosingLines().map((l) => ({ ...l, kind: 'odds-api' })),
    ...listEntries().filter((e) => e.source === 'manual').map((e) => ({ kind: 'manual', date: e.date, playerId: e.playerId, player: e.playerName, stat: e.stat, line: e.line, over: e.over, under: e.under, book: e.book })),
  ].filter((l) => l.date < L.today && STATS[l.stat]);
  const byName = new Map([...L.players.values()].map((p) => [normName(p.name), p]));
  const out = [];
  for (const l of lines) {
    const p = l.playerId ? L.players.get(l.playerId) : byName.get(normName(l.player));
    if (!p) continue;
    const row = L.playerLogs(p.id).find((r) => r.date === l.date);
    if (!row) continue; // did not play: void
    const ctx = buildContext(L, p.id, { date: l.date, team: row.team, opp: row.opp, home: row.home }, { teammatesOut: [] });
    const pp = projectPlayer(ctx, cfg);
    const sp = projectStat(pp, ctx, l.stat, cfg);
    if (!sp) continue;
    const e = evaluateLine(sp, l, quality(ctx, pp.minutes), cfg);
    const actual = statValue(row, l.stat);
    const outcome = actual > l.line ? 'over' : actual < l.line ? 'under' : 'push';
    if (!e.side) { out.push({ kind: l.kind, bet: false }); continue; }
    const price = e.side === 'over' ? e.over : e.under;
    const profit = outcome === 'push' ? 0 : outcome === e.side ? price - 1 : -1;
    out.push({ kind: l.kind, bet: true, profit, won: outcome === e.side });
  }
  const bets = out.filter((x) => x.bet);
  return {
    label: 'REAL LINES - saved Odds API prices (latest before tip-off) and your manual lines, graded against box scores. Team-level stats use the current snapshot (slight look-ahead on team pace/defence).',
    linesGraded: out.length,
    bets: bets.length,
    won: bets.filter((x) => x.won).length,
    roi: bets.length ? r3(bets.reduce((a, x) => a + x.profit, 0) / bets.length) : null,
    note: out.length ? null : 'No real lines yet. Every Odds API fetch and manual line is saved, so this fills in as you use the app.',
  };
}

// ---------- output ----------
mkdirSync(join(ROOT, 'reports'), { recursive: true });
const file = join(ROOT, 'reports', `backtest-${season}-${S1.source}.json`);
writeFileSync(file, JSON.stringify(report, null, 1));
if (args.includes('--dump')) {
  // every prediction as CSV, for your own analysis
  const cols = Object.keys(rec[0] || {});
  writeFileSync(file.replace(/\.json$/, '.csv'), [cols.join(','), ...rec.map((x) => cols.map((c) => x[c] ?? '').join(','))].join('\n'));
}

if (!quiet) {
  const pct = (x) => (x == null ? '   –  ' : `${(x * 100).toFixed(1).padStart(5)}%`);
  console.log(`\n${report.sample.playerGames} player-games, ${report.sample.predictions} predictions, ${report.seconds}s`);
  console.log(`\nMINUTES  MAE ${report.minutes.mae}  bias ${report.minutes.bias}`);
  console.log('\nPROJECTION ACCURACY (mean absolute error; lower is better)');
  console.log('stat    n      model  season  last10  est.line   bias  spread');
  for (const [s, a] of Object.entries(report.accuracy)) console.log(`${s.padEnd(6)}${String(a.n).padStart(6)}  ${String(a.maeModel).padStart(6)}  ${String(a.maeSeasonAvg).padStart(6)}  ${String(a.maeLast10).padStart(6)}  ${String(a.maeEstLine).padStart(8)}  ${String(a.bias).padStart(6)}  ${a.spreadRatio}`);
  const c = report.calibration.all;
  console.log(`\nCALIBRATION  P(over estimated line)  Brier ${c.brier} (coin flip 0.25)  log loss ${c.logLoss}`);
  for (const b of c.buckets) console.log(`  predicted ${b.range.padEnd(8)} n=${String(b.n).padStart(6)}  avg ${pct(b.predicted)}  actual ${pct(b.actual)}`);
  const E = report.estimatedLines;
  console.log(`\n*** ${E.label}`);
  console.log(`threshold ${E.threshold * 100}%   bets ${E.all.bets}   hit ${pct(E.all.hitRate)}   ROI ${pct(E.all.roi)}   (break-even hit rate ${pct(E.all.breakEven)})`);
  for (const [s, x] of Object.entries(E.byStat)) console.log(`  ${s.padEnd(6)} bets ${String(x.bets).padStart(5)}  hit ${pct(x.hitRate)}  ROI ${pct(x.roi)}`);
  for (const [s, x] of Object.entries(E.byConfidence)) console.log(`  ${s.padEnd(6)} bets ${String(x.bets).padStart(5)}  hit ${pct(x.hitRate)}  ROI ${pct(x.roi)}`);
  const R = report.realLines;
  console.log(`\nREAL LINES: ${R.linesGraded} graded, ${R.bets} bets, ROI ${pct(R.roi)}${R.note ? `  (${R.note})` : ''}`);
  console.log(`\nfull report: ${file}`);
}
export default report;
