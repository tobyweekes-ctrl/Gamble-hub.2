// stats.nba.com provider (the same endpoints the nba_api Python package wraps).
// One leaguegamelog call returns every player box score of a season, so a whole season costs
// ~2 requests (game log + player index) instead of one per player.
// Note: stats.nba.com blocks many cloud/datacenter IPs; it works from home connections.
import { fetchJson } from '../http.mjs';
import { teamAbbr } from '../teams.mjs';
import { parseMinutes } from '../util.mjs';

const BASE = 'https://stats.nba.com/stats';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nba.com/',
  Origin: 'https://www.nba.com',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
};

async function call(endpoint, params) {
  const url = `${BASE}/${endpoint}?${new URLSearchParams(params)}`;
  const { json } = await fetchJson(url, { headers: HEADERS, minGapMs: 800, timeoutMs: 30000 });
  return json;
}

/** resultSets[name] -> array of objects keyed by header */
export function rows(json, name) {
  const sets = json.resultSets || (json.resultSet ? [json.resultSet] : []);
  const set = name ? sets.find((s) => s.name === name) : sets[0];
  if (!set) return [];
  return set.rowSet.map((r) => Object.fromEntries(set.headers.map((h, i) => [h, r[i]])));
}

/** "LAL vs. BOS" (home) | "LAL @ BOS" (away) */
export function parseMatchup(m) {
  const home = m.includes('vs.');
  const opp = m.split(home ? 'vs.' : '@')[1].trim();
  return { home, opp: teamAbbr(opp) };
}

export function normaliseGameLog(rs) {
  return rs.map((r) => {
    const { home, opp } = parseMatchup(r.MATCHUP);
    return {
      playerId: String(r.PLAYER_ID),
      gameId: String(r.GAME_ID),
      date: String(r.GAME_DATE).slice(0, 10),
      team: teamAbbr(r.TEAM_ABBREVIATION),
      opp,
      home,
      min: parseMinutes(r.MIN),
      pts: r.PTS ?? 0, reb: r.REB ?? 0, ast: r.AST ?? 0,
      fg3m: r.FG3M ?? 0, fg3a: r.FG3A ?? 0, fgm: r.FGM ?? 0, fga: r.FGA ?? 0,
      ftm: r.FTM ?? 0, fta: r.FTA ?? 0, oreb: r.OREB ?? 0, dreb: r.DREB ?? 0,
      tov: r.TOV ?? 0, stl: r.STL ?? 0, blk: r.BLK ?? 0, pf: r.PF ?? 0, pm: r.PLUS_MINUS ?? 0,
    };
  });
}

export const nbaStatsProvider = {
  name: 'stats.nba.com',

  async loadSeason(season) {
    const [logJson, idxJson] = await Promise.all([
      call('leaguegamelog', {
        Counter: 0, Direction: 'ASC', LeagueID: '00', PlayerOrTeam: 'P',
        Season: season, SeasonType: 'Regular Season', Sorter: 'DATE',
      }),
      call('playerindex', { LeagueID: '00', Season: season, Historical: 0 }).catch(() => null),
    ]);
    const logRows = rows(logJson);
    const games = normaliseGameLog(logRows);

    const pos = new Map();
    if (idxJson) for (const r of rows(idxJson)) pos.set(String(r.PERSON_ID), r.POSITION || '');

    const players = new Map();
    for (const r of logRows) {
      players.set(String(r.PLAYER_ID), {
        id: String(r.PLAYER_ID),
        name: r.PLAYER_NAME,
        team: teamAbbr(r.TEAM_ABBREVIATION), // rows are date-ascending, so the last write is the current team
        pos: pos.get(String(r.PLAYER_ID)) || '',
      });
    }
    // roster players who haven't played yet (injured / new signings)
    if (idxJson) {
      for (const r of rows(idxJson)) {
        const id = String(r.PERSON_ID);
        if (!players.has(id) && r.TEAM_ABBREVIATION) {
          players.set(id, { id, name: `${r.PLAYER_FIRST_NAME} ${r.PLAYER_LAST_NAME}`, team: teamAbbr(r.TEAM_ABBREVIATION), pos: r.POSITION || '' });
        }
      }
    }
    return { season, source: this.name, players: [...players.values()], games };
  },

  async schedule(date) {
    const json = await call('scoreboardv2', { GameDate: date, LeagueID: '00', DayOffset: 0 });
    return rows(json, 'GameHeader').map((g) => ({
      gameId: String(g.GAME_ID),
      date,
      tipoff: null, // scoreboardv2 only gives local text like "7:30 pm ET" in status
      status: g.GAME_STATUS_TEXT?.trim() || '',
      home: teamAbbr(g.HOME_TEAM_ID),
      away: teamAbbr(g.VISITOR_TEAM_ID),
    }));
  },
};
