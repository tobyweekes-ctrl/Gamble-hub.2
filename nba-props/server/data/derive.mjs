// Pure derivations from normalised box scores. No I/O here, so it is easy to test and to reuse
// in the backtest (pass only games before a cutoff date to avoid look-ahead).
import { daysBetween, mean } from '../util.mjs';

/** Primary positional group from strings like "G", "G-F", "F-C", "Center", "Guard-Forward". */
export function posGroup(pos) {
  const p = String(pos || '').trim().toUpperCase();
  if (!p) return 'F';
  const first = p.split(/[-/ ]/)[0];
  if (first.startsWith('C')) return 'C';
  if (first.startsWith('G') || first === 'PG' || first === 'SG') return 'G';
  if (first === 'PF' || first === 'SF' || first.startsWith('F')) return 'F';
  return 'F';
}

const SUM_KEYS = ['min', 'pts', 'reb', 'ast', 'fg3m', 'fg3a', 'fgm', 'fga', 'ftm', 'fta', 'oreb', 'dreb', 'tov'];

/** Aggregate player rows into one row per (game, team) with the opponent's totals attached. */
export function teamGames(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.gameId}|${r.team}`;
    let t = byKey.get(k);
    if (!t) {
      t = { gameId: r.gameId, date: r.date, team: r.team, opp: r.opp, home: r.home, players: [] };
      for (const s of SUM_KEYS) t[s] = 0;
      byKey.set(k, t);
    }
    for (const s of SUM_KEYS) t[s] += r[s] || 0;
    t.players.push(r.playerId);
  }
  for (const t of byKey.values()) {
    const o = byKey.get(`${t.gameId}|${t.opp}`);
    t.oppPts = o?.pts ?? null;
    // possessions estimate (basketball-reference style, averaged over both teams)
    const poss = (x) => x.fga + 0.44 * x.fta - x.oreb + x.tov;
    t.poss = o ? (poss(t) + poss(o)) / 2 : poss(t);
    const gameMin = Math.max(48, Math.round(t.min / 5)); // OT adds minutes
    t.pace = (t.poss * 48) / gameMin;
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Per-team season summary: pace, offensive/defensive rating, points for/against. */
export function teamSummaries(tgs) {
  const by = new Map();
  for (const t of tgs) {
    if (t.oppPts == null) continue;
    const s = by.get(t.team) || { team: t.team, games: 0, pts: 0, oppPts: 0, poss: 0, pace: 0, fg3mAllowed: 0 };
    s.games++; s.pts += t.pts; s.oppPts += t.oppPts; s.poss += t.poss; s.pace += t.pace;
    by.set(t.team, s);
  }
  const oppOf = new Map(tgs.map((t) => [`${t.gameId}|${t.team}`, t]));
  for (const t of tgs) {
    const o = oppOf.get(`${t.gameId}|${t.opp}`);
    if (o && by.has(t.team)) by.get(t.team).fg3mAllowed += o.fg3m;
  }
  const out = {};
  for (const s of by.values()) {
    out[s.team] = {
      team: s.team,
      games: s.games,
      pace: s.pace / s.games,
      ortg: (100 * s.pts) / s.poss,
      drtg: (100 * s.oppPts) / s.poss,
      ppg: s.pts / s.games,
      oppPpg: s.oppPts / s.games,
      fg3mAllowed: s.fg3mAllowed / s.games,
    };
  }
  const vals = Object.values(out);
  const lg = vals.length
    ? { pace: mean(vals.map((v) => v.pace)), ortg: mean(vals.map((v) => v.ortg)), drtg: mean(vals.map((v) => v.drtg)), fg3mAllowed: mean(vals.map((v) => v.fg3mAllowed)) }
    : null;
  return { teams: out, league: lg };
}

/** Usage rate per player row: share of team plays used while on the floor. */
export function addUsage(rows, tgs) {
  const tg = new Map(tgs.map((t) => [`${t.gameId}|${t.team}`, t]));
  for (const r of rows) {
    const t = tg.get(`${r.gameId}|${r.team}`);
    const teamPlays = t ? t.fga + 0.44 * t.fta + t.tov : 0;
    r.usg = r.min > 0 && teamPlays > 0
      ? (100 * (r.fga + 0.44 * r.fta + r.tov) * (t.min / 5)) / (r.min * teamPlays)
      : null;
  }
  return rows;
}

/**
 * Defence vs position: for each defending team and opponent position group, stat allowed per
 * minute relative to league average. 1.10 = allows 10% more than average to that position.
 * Factors are shrunk toward 1 with a prior of `priorMin` minutes so small samples stay sane.
 */
export function positionDefense(rows, groupOf, { priorMin = 600 } = {}) {
  const STAT = ['pts', 'reb', 'ast', 'fg3m'];
  const acc = {}; // team -> group -> {min, pts, ...}
  const lg = {}; // group -> {min, ...}
  for (const r of rows) {
    if (!r.opp || !r.min) continue;
    const g = groupOf(r.playerId);
    const a = ((acc[r.opp] ||= {})[g] ||= { min: 0, pts: 0, reb: 0, ast: 0, fg3m: 0 });
    const l = (lg[g] ||= { min: 0, pts: 0, reb: 0, ast: 0, fg3m: 0 });
    a.min += r.min; l.min += r.min;
    for (const s of STAT) { a[s] += r[s]; l[s] += r[s]; }
  }
  const out = {};
  for (const [team, groups] of Object.entries(acc)) {
    out[team] = {};
    for (const [g, a] of Object.entries(groups)) {
      const l = lg[g];
      out[team][g] = { min: Math.round(a.min) };
      for (const s of STAT) {
        const lgRate = l[s] / l.min;
        const raw = lgRate > 0 ? a[s] / a.min / lgRate : 1;
        out[team][g][s] = (raw * a.min + 1 * priorMin) / (a.min + priorMin);
      }
    }
  }
  return out;
}

/**
 * Absence / return-from-injury tracking for one player.
 * @param {object[]} playerRows the player's rows, date ascending (any seasons)
 * @param {object[]} teamGameList the games of the player's team, date ascending
 * @param {string} today YYYY-MM-DD
 */
export function absenceInfo(playerRows, teamGameList, today) {
  const played = new Set(playerRows.map((r) => r.gameId));
  const firstDate = playerRows[0]?.date;
  const games = teamGameList.filter((g) => g.date < today && (!firstDate || g.date >= firstDate));
  if (!games.length || !playerRows.length) return { status: playerRows.length ? 'active' : 'no-games' };
  const last = playerRows[playerRows.length - 1];

  // currently out: team games since last appearance
  let missedNow = 0;
  for (let i = games.length - 1; i >= 0 && !played.has(games[i].gameId); i--) missedNow++;
  if (missedNow > 0) {
    return { status: 'absent', gamesMissed: missedNow, lastPlayed: last.date, daysSince: daysBetween(last.date, today) };
  }
  // currently playing: length of current run and the gap before it
  let run = 0, i = games.length - 1;
  while (i >= 0 && played.has(games[i].gameId)) { run++; i--; }
  let missed = 0;
  while (i >= 0 && !played.has(games[i].gameId)) { missed++; i--; }
  if (missed === 0 || run > 10) return { status: 'active' };
  const since = playerRows.slice(-run);
  const before = playerRows.slice(0, -run).slice(-15);
  return {
    status: 'returned',
    gamesMissed: missed,
    gamesSinceReturn: run,
    returnDate: since[0].date,
    minutesSinceReturn: since.map((r) => Math.round(r.min * 10) / 10),
    minutesBefore: before.length ? Math.round(mean(before.map((r) => r.min)) * 10) / 10 : null,
  };
}

/** Days of rest before `date` given a team's game dates (0 = back-to-back). */
export function restDays(teamDates, date) {
  const prev = teamDates.filter((d) => d < date).pop();
  return prev ? daysBetween(prev, date) - 1 : null;
}
