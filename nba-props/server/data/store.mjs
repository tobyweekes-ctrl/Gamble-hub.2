// Data service: picks providers from config, caches their responses, and builds an indexed
// League (two seasons of box scores + derived team/position/usage data). Everything the API,
// model and backtest need comes through here.
import { config } from '../env.mjs';
import { cached, cacheAge } from '../cache.mjs';
import { nbaStatsProvider } from '../providers/nbaStats.mjs';
import { balldontlieProvider } from '../providers/balldontlie.mjs';
import { espnInjuryProvider } from '../providers/espnInjuries.mjs';
import { oddsApiProvider, quota } from '../providers/oddsApi.mjs';
import { demoProvider, demoInjuries, demoEventProps } from '../providers/demo.mjs';
import { seasonOf, prevSeason, todayET, normName, mean, round } from '../util.mjs';
import { teamGames, teamSummaries, addUsage, positionDefense, posGroup, absenceInfo, restDays } from './derive.mjs';
import { STATS, statValue } from '../stats.mjs';

const HOUR = 3600;
export const today = () => todayET(config.today);
const demo = () => config.statsProvider === 'demo';

function statsProvider() {
  if (demo()) return demoProvider(today());
  if (config.statsProvider === 'balldontlie') return balldontlieProvider;
  return nbaStatsProvider;
}

// ---------- seasons ----------
async function loadSeason(season) {
  const p = statsProvider();
  if (p.name === 'demo') return p.loadSeason(season);
  const key = `season:${p.name}:${season}`;
  const isCurrent = season === seasonOf(today());
  if (!isCurrent) return cached(key, Infinity, () => p.loadSeason(season));
  if (p.name === 'balldontlie') {
    // incremental top-up: keep cached rows, fetch only from the last cached date onward
    return cached(key, 3 * HOUR, async () => {
      const prev = await cached(`${key}:base`, Infinity, () => p.loadSeason(season));
      const since = prev.games.at(-1)?.date;
      if (!since) return p.loadSeason(season);
      const fresh = await p.loadSeason(season, since);
      const seen = new Set(fresh.games.map((g) => `${g.playerId}|${g.gameId}`));
      const games = [...prev.games.filter((g) => !seen.has(`${g.playerId}|${g.gameId}`)), ...fresh.games];
      const players = new Map([...prev.players, ...fresh.players].map((x) => [x.id, x]));
      return { ...prev, games, players: [...players.values()] };
    });
  }
  return cached(key, 3 * HOUR, () => p.loadSeason(season));
}

// ---------- league ----------
let leaguePromise = null;
let leagueBuiltFor = null;

/** Two seasons, indexed. Rebuilt when the date changes or the current-season cache expires. */
export async function getLeague() {
  const stamp = `${today()}|${Math.floor(Date.now() / (3 * HOUR * 1000))}`;
  if (!leaguePromise || leagueBuiltFor !== stamp) {
    leagueBuiltFor = stamp;
    leaguePromise = buildLeague().catch((e) => { leaguePromise = null; throw e; });
  }
  return leaguePromise;
}

async function buildLeague() {
  const cur = seasonOf(today());
  const prev = prevSeason(cur);
  const [S1, S0] = await Promise.all([loadSeason(cur), loadSeason(prev)]);
  return indexLeague({ current: cur, previous: prev, seasons: { [cur]: S1, [prev]: S0 }, today: today(), source: S1.source });
}

/** Build indexes from raw season bundles. Exported so the backtest can index a truncated copy. */
export function indexLeague({ current, previous, seasons, today: asOf, source }) {
  const players = new Map();
  for (const s of [previous, current]) {
    for (const p of seasons[s].players) players.set(p.id, { ...players.get(p.id), ...p, pos: p.pos || players.get(p.id)?.pos || '' });
  }
  for (const p of players.values()) p.group = posGroup(p.pos);
  const groupOf = (id) => players.get(id)?.group ?? 'F';

  const bySeason = {};
  const logs = new Map();
  const teamDates = new Map();
  const teamGameList = new Map();
  for (const s of [previous, current]) {
    const rows = seasons[s].games.filter((g) => g.date < asOf).map((g) => ({ ...g, season: s }));
    const tgs = teamGames(rows);
    addUsage(rows, tgs);
    bySeason[s] = { rows, teamGames: tgs, summary: teamSummaries(tgs), posDef: positionDefense(rows, groupOf) };
    for (const r of rows) {
      if (!logs.has(r.playerId)) logs.set(r.playerId, []);
      logs.get(r.playerId).push(r);
    }
    for (const t of tgs) {
      if (!teamDates.has(t.team)) { teamDates.set(t.team, []); teamGameList.set(t.team, []); }
      teamDates.get(t.team).push(t.date);
      teamGameList.get(t.team).push(t);
    }
  }
  for (const l of logs.values()) l.sort((a, b) => a.date.localeCompare(b.date));
  const tgIndex = new Map();
  for (const s of Object.values(bySeason)) for (const t of s.teamGames) tgIndex.set(`${t.gameId}|${t.team}`, t);

  return {
    today: asOf, current, previous, source, players, logs, bySeason, teamDates, teamGameList, tgIndex,
    groupOf,
    playerLogs: (id) => logs.get(id) || [],
    /** players who appeared for `team` in that game (for with/without splits) */
    lineup: (gameId, team) => new Set(tgIndex.get(`${gameId}|${team}`)?.players || []),
    restDays: (team, date) => restDays(teamDates.get(team) || [], date),
    absence: (id) => {
      const p = players.get(id);
      return absenceInfo(logs.get(id) || [], teamGameList.get(p?.team) || [], asOf);
    },
  };
}

// ---------- player search ----------
export function searchPlayers(L, q, limit = 10) {
  const nq = normName(q);
  if (!nq) return [];
  const terms = nq.split(' ');
  const scored = [];
  for (const p of L.players.values()) {
    const n = normName(p.name);
    if (!terms.every((t) => n.includes(t))) continue;
    const logs = L.playerLogs(p.id);
    const recent = logs.filter((r) => r.season === L.current);
    const basis = recent.length ? recent : logs.filter((r) => r.season === L.previous);
    const words = n.split(' ');
    let score = 0;
    if (n.startsWith(nq)) score += 3;
    if (words.some((w) => w.startsWith(terms[0]))) score += 2;
    score += Math.min(2, mean(basis.map((r) => r.min)) / 18 || 0); // regulars first
    if (!logs.length) score -= 2;
    scored.push({ p, score, basis });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ p, basis }) => ({
    id: p.id, name: p.name, team: p.team, pos: p.pos,
    gp: basis.length,
    min: round(mean(basis.map((r) => r.min))),
    pts: round(mean(basis.map((r) => r.pts))),
    reb: round(mean(basis.map((r) => r.reb))),
    ast: round(mean(basis.map((r) => r.ast))),
  }));
}

/** Averages over a set of rows for every stat key, plus minutes and usage. */
export function averages(rows) {
  const o = { gp: rows.length, min: round(mean(rows.map((r) => r.min))), usg: round(mean(rows.map((r) => r.usg).filter((x) => x != null))) };
  for (const k of Object.keys(STATS)) o[k] = round(mean(rows.map((r) => statValue(r, k))));
  return o;
}

// ---------- schedule ----------
export async function getSlate(date = today()) {
  const p = statsProvider();
  const games = p.name === 'demo'
    ? await p.schedule(date)
    : await cached(`schedule:${p.name}:${date}`, HOUR, () => p.schedule(date));
  if (oddsApiProvider.enabled()) {
    try {
      const events = await getOddsEvents();
      for (const g of games) {
        // tipoff is UTC, so an evening ET game can fall on the next UTC day: match within ~18h of 7pm ET
        const e = events.find((x) => x.home === g.home && x.away === g.away
          && Math.abs(Date.parse(x.tipoff) - Date.parse(`${date}T23:00:00Z`)) < 18 * HOUR * 1000);
        if (e) { g.eventId = e.eventId; g.tipoff ||= e.tipoff; }
      }
    } catch (err) {
      console.warn('[odds] events unavailable:', err.message);
    }
  } else if (demo()) {
    for (const g of games) g.eventId = `demo:${g.gameId}`;
  }
  return games;
}

export async function gameFor(team, date = today()) {
  const slate = await getSlate(date);
  return slate.find((g) => g.home === team || g.away === team) || null;
}

// ---------- injuries ----------
export async function getInjuries() {
  if (demo() || config.injuryProvider === 'demo') return demoInjuries();
  return cached('injuries:espn', 30 * 60, () => espnInjuryProvider.load());
}

export function injuryFor(injuries, player) {
  const n = normName(player.name);
  return injuries.find((i) => normName(i.name) === n && (!i.team || i.team === player.team))
    || injuries.find((i) => normName(i.name) === n) || null;
}

// ---------- odds ----------
async function getOddsEvents() {
  return cached('odds:events', 30 * 60, () => oddsApiProvider.events());
}

async function eventProps(game) {
  if (!game?.eventId) return [];
  if (game.eventId.startsWith('demo:')) return demoEventProps(game.gameId, game.date);
  return cached(`odds:props:${game.eventId}`, config.oddsTtlMin * 60, () => oddsApiProvider.eventProps(game.eventId));
}

/**
 * All bookmaker lines for one player + stat in tonight's game, with the best over and under
 * flagged. "Best" for an over = lowest line, then highest price; for an under = highest line,
 * then highest price.
 */
export async function getPlayerLines(player, stat, date = today()) {
  const game = await gameFor(player.team, date);
  if (!game) return { game: null, lines: [], source: null };
  const rows = await eventProps(game);
  const n = normName(player.name);
  const lines = rows.filter((r) => r.stat === stat && normName(r.player) === n)
    .map((r) => ({ book: r.book, bookTitle: r.bookTitle, line: r.line, over: r.over, under: r.under, updated: r.updated }))
    .sort((a, b) => a.line - b.line || a.bookTitle.localeCompare(b.bookTitle));
  const pick = (cmp) => lines.filter((l) => l.over && l.under).reduce((best, l) => (!best || cmp(l, best) ? l : best), null);
  const bestOver = pick((l, b) => l.line < b.line || (l.line === b.line && l.over > b.over));
  const bestUnder = pick((l, b) => l.line > b.line || (l.line === b.line && l.under > b.under));
  for (const l of lines) { l.bestOver = l === bestOver; l.bestUnder = l === bestUnder; }
  const source = game.eventId?.startsWith('demo:') ? 'demo' : oddsApiProvider.enabled() ? 'The Odds API' : null;
  return { game, lines, source, cacheAgeSec: game.eventId ? cacheAge(`odds:props:${game.eventId}`) : null };
}

export function status() {
  return {
    today: today(),
    statsProvider: statsProvider().name,
    injuryProvider: demo() ? 'demo' : config.injuryProvider,
    odds: demo() ? 'demo' : oddsApiProvider.enabled() ? 'The Odds API' : 'disabled (no ODDS_API_KEY)',
    oddsQuota: quota,
    keys: { balldontlie: Boolean(config.balldontlieKey), oddsApi: Boolean(config.oddsKey) },
  };
}
