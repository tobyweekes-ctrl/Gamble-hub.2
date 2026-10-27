// balldontlie.io provider. Box scores (/stats) need the ALL-STAR tier or above.
// A season is ~250 pages of 100 rows; past seasons are cached forever and the current season is
// topped up incrementally by date (see data/store.mjs), so the full pull happens once.
import { fetchJson } from '../http.mjs';
import { config } from '../env.mjs';
import { teamAbbr } from '../teams.mjs';
import { parseMinutes, seasonStartYear } from '../util.mjs';

const BASE = 'https://api.balldontlie.io/v1';

function call(path, params = {}) {
  if (!config.balldontlieKey) throw new Error('BALLDONTLIE_API_KEY is not set');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    for (const x of [].concat(v)) qs.append(k, x);
  }
  return fetchJson(`${BASE}${path}?${qs}`, {
    headers: { Authorization: config.balldontlieKey },
    minGapMs: Math.ceil(60000 / config.balldontlieRpm),
  }).then((r) => r.json);
}

async function paginate(path, params) {
  const out = [];
  let cursor;
  do {
    const page = await call(path, { ...params, per_page: 100, ...(cursor ? { cursor } : {}) });
    out.push(...page.data);
    cursor = page.meta?.next_cursor;
  } while (cursor);
  return out;
}

export function normaliseStat(s) {
  const g = s.game;
  const team = teamAbbr(s.team.abbreviation);
  const homeAbbr = teamAbbr(g.home_team?.abbreviation) ?? null;
  const home = homeAbbr ? homeAbbr === team : s.team.id === g.home_team_id;
  const oppAbbr = home
    ? teamAbbr(g.visitor_team?.abbreviation)
    : teamAbbr(g.home_team?.abbreviation);
  return {
    playerId: String(s.player.id),
    gameId: String(g.id),
    date: String(g.date).slice(0, 10),
    team,
    opp: oppAbbr,
    oppTeamId: home ? g.visitor_team_id : g.home_team_id,
    home,
    min: parseMinutes(s.min),
    pts: s.pts ?? 0, reb: s.reb ?? 0, ast: s.ast ?? 0,
    fg3m: s.fg3m ?? 0, fg3a: s.fg3a ?? 0, fgm: s.fgm ?? 0, fga: s.fga ?? 0,
    ftm: s.ftm ?? 0, fta: s.fta ?? 0, oreb: s.oreb ?? 0, dreb: s.dreb ?? 0,
    tov: s.turnover ?? 0, stl: s.stl ?? 0, blk: s.blk ?? 0, pf: s.pf ?? 0, pm: s.plus_minus ?? 0,
  };
}

export const balldontlieProvider = {
  name: 'balldontlie',

  /** @param {string} season e.g. "2026-27"; @param {string} [sinceDate] only fetch games on/after this date */
  async loadSeason(season, sinceDate) {
    const teams = await call('/teams').then((r) => r.data);
    const teamById = new Map(teams.map((t) => [t.id, teamAbbr(t.abbreviation)]));
    const raw = await paginate('/stats', {
      'seasons[]': seasonStartYear(season),
      postseason: 'false',
      ...(sinceDate ? { start_date: sinceDate } : {}),
    });
    const players = new Map();
    const games = [];
    for (const s of raw) {
      if (!s.min || parseMinutes(s.min) === 0) continue; // DNP rows
      const row = normaliseStat(s);
      if (!row.opp) row.opp = teamById.get(row.oppTeamId) ?? null;
      delete row.oppTeamId;
      games.push(row);
      players.set(row.playerId, {
        id: row.playerId,
        name: `${s.player.first_name} ${s.player.last_name}`,
        team: row.team,
        pos: s.player.position || '',
      });
    }
    games.sort((a, b) => a.date.localeCompare(b.date));
    return { season, source: this.name, players: [...players.values()], games };
  },

  async schedule(date) {
    const r = await call('/games', { 'dates[]': date, per_page: 100 });
    return r.data.map((g) => ({
      gameId: String(g.id),
      date,
      tipoff: g.datetime || null,
      status: g.status || '',
      home: teamAbbr(g.home_team.abbreviation),
      away: teamAbbr(g.visitor_team.abbreviation),
    }));
  },
};
