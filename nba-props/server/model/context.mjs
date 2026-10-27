// Gathers every input the model needs for one player in one game, using only data from before
// the game date. The same function feeds the live API and the backtest.
import { seasonOf, prevSeason, normName, mean } from '../util.mjs';
import { absenceInfo, restDays } from '../data/derive.mjs';

const OUT_STATUSES = /^(out|doubtful|suspended)/i;

/**
 * @param L  indexed league holding the box scores (rows on/after game.date are ignored)
 * @param playerId
 * @param game { date, team, opp, home }
 * @param opts.T  league snapshot to read team-level stats from (backtest: a weekly snapshot). Defaults to L.
 * @param opts.injuries  injury report rows (live)
 * @param opts.teammatesOut  explicit list of teammate ids out (backtest); overrides injuries
 * @param opts.spread  game spread from this team's perspective (negative = favourite), optional
 * @param opts.minutesOverride  user-entered minutes projection
 */
export function buildContext(L, playerId, game, opts = {}) {
  const T = opts.T || L;
  const player = L.players.get(playerId);
  const cur = seasonOf(game.date);
  const prev = prevSeason(cur);
  const logs = L.playerLogs(playerId).filter((r) => r.date < game.date);
  const curRows = logs.filter((r) => r.season === cur);
  const prevRows = logs.filter((r) => r.season === prev);
  const teamRows = curRows.filter((r) => r.team === game.team);
  // changed team since last season, or during this one
  const traded = (prevRows.length > 0 && prevRows.at(-1).team !== game.team) || curRows.some((r) => r.team !== game.team);

  const teamGamesBefore = (team) => (L.teamGameList.get(team) || []).filter((g) => g.date < game.date);
  const myTeamGames = teamGamesBefore(game.team);

  // teammates who were in the rotation lately (so their absence tonight is new information)
  const recentTeamGames = myTeamGames.slice(-4);
  const rotation = new Map(); // id -> {apps, min}
  for (const g of recentTeamGames) {
    for (const id of g.players) {
      if (id === playerId) continue;
      const r = L.playerLogs(id).find((x) => x.gameId === g.gameId);
      const e = rotation.get(id) || { apps: 0, min: 0 };
      e.apps++; e.min += r?.min || 0;
      rotation.set(id, e);
    }
  }
  const activeMates = [...rotation.entries()]
    .filter(([, e]) => e.apps >= 2 && e.min / e.apps >= 15)
    .map(([id, e]) => ({ id, name: L.players.get(id)?.name, group: L.groupOf(id), min: e.min / e.apps }));

  let teammatesOut;
  if (opts.teammatesOut) {
    const out = new Set(opts.teammatesOut);
    teammatesOut = activeMates.filter((m) => out.has(m.id));
  } else {
    const outNames = new Set((opts.injuries || []).filter((i) => i.team === game.team && OUT_STATUSES.test(i.status)).map((i) => normName(i.name)));
    teammatesOut = activeMates.filter((m) => outNames.has(normName(m.name)));
  }
  const outIds = new Set(teammatesOut.map((m) => m.id));
  const availableMates = activeMates.filter((m) => !outIds.has(m.id));

  // team-level numbers, last season blended into this season by games played
  const teamStat = (team) => {
    const c = T.bySeason[cur]?.summary.teams[team];
    const p = T.bySeason[prev]?.summary.teams[team];
    return { cur: c || null, prev: p || null };
  };
  const leagueStat = { cur: T.bySeason[cur]?.summary.league || null, prev: T.bySeason[prev]?.summary.league || null };
  const posDef = (team, group) => ({
    cur: T.bySeason[cur]?.posDef[team]?.[group] || null,
    prev: T.bySeason[prev]?.posDef[team]?.[group] || null,
    curGames: T.bySeason[cur]?.summary.teams[team]?.games || 0,
  });

  // final margin of each of the player's past games (for blowout minutes)
  const marginOf = (r) => {
    const t = L.tgIndex.get(`${r.gameId}|${r.team}`);
    return t && t.oppPts != null ? t.pts - t.oppPts : null;
  };

  return {
    player, game, cur, prev, logs, curRows, prevRows, teamRows, traded,
    group: L.groupOf(playerId),
    restDays: restDays(myTeamGames.map((g) => g.date), game.date),
    oppRestDays: restDays(teamGamesBefore(game.opp).map((g) => g.date), game.date),
    absence: absenceInfo(logs, myTeamGames, game.date),
    teammatesOut, availableMates,
    h2hRows: logs.filter((r) => r.opp === game.opp),
    team: teamStat(game.team), opp: teamStat(game.opp), league: leagueStat,
    posDef, marginOf,
    lineup: (r) => L.lineup(r.gameId, r.team),
    mateSeasons: (id) => new Set(L.playerLogs(id).filter((r) => r.date < game.date).map((r) => `${r.season}|${r.team}`)),
    spread: opts.spread ?? null,
    minutesOverride: opts.minutesOverride ?? null,
    recentMinutes: mean(teamRows.slice(-5).map((r) => r.min)),
  };
}
