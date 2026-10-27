import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rows, parseMatchup, normaliseGameLog } from '../server/providers/nbaStats.mjs';
import { normaliseStat } from '../server/providers/balldontlie.mjs';
import { normaliseEventOdds, normaliseEvents } from '../server/providers/oddsApi.mjs';
import { normaliseInjuries } from '../server/providers/espnInjuries.mjs';
import { teamAbbr } from '../server/teams.mjs';

test('team aliases map to canonical abbreviations', () => {
  assert.equal(teamAbbr('GS'), 'GSW');
  assert.equal(teamAbbr('UTAH'), 'UTA');
  assert.equal(teamAbbr('Los Angeles Clippers'), 'LAC');
  assert.equal(teamAbbr('LA Clippers'), 'LAC');
  assert.equal(teamAbbr(1610612747), 'LAL');
  assert.equal(teamAbbr('nope'), null);
});

test('stats.nba.com resultSets -> normalised game log', () => {
  const json = { resultSets: [{ name: 'LeagueGameLog', headers: ['PLAYER_ID', 'PLAYER_NAME', 'TEAM_ABBREVIATION', 'GAME_ID', 'GAME_DATE', 'MATCHUP', 'MIN', 'PTS', 'REB', 'AST', 'FG3M', 'FGA', 'FTA', 'TOV'],
    rowSet: [[201939, 'Stephen Curry', 'GSW', '0022600011', '2026-10-22', 'GSW vs. LAL', 34, 31, 5, 7, 6, 21, 6, 3], [201939, 'Stephen Curry', 'GSW', '0022600025', '2026-10-24', 'GSW @ PHX', '36:30', 25, 4, 9, 4, 18, 4, 2]] }] };
  const r = rows(json);
  assert.equal(r.length, 2);
  const g = normaliseGameLog(r);
  assert.deepEqual([g[0].home, g[0].opp, g[0].pts], [true, 'LAL', 31]);
  assert.deepEqual([g[1].home, g[1].opp, g[1].min], [false, 'PHX', 36.5]);
  assert.deepEqual(parseMatchup('NOP @ UTA'), { home: false, opp: 'UTA' });
});

test('balldontlie stat row -> normalised', () => {
  const s = { min: '33', pts: 28, reb: 4, ast: 6, fg3m: 3, fga: 20, fta: 7, turnover: 2,
    player: { id: 115, first_name: 'A', last_name: 'B', position: 'G' },
    team: { id: 10, abbreviation: 'GSW' },
    game: { id: 9, date: '2026-10-22', home_team_id: 14, visitor_team_id: 10 } };
  const r = normaliseStat(s);
  assert.equal(r.home, false);
  assert.equal(r.oppTeamId, 14);
  assert.equal(r.tov, 2);
  assert.equal(r.min, 33);
});

test('Odds API event odds -> one row per player/line/book with both sides', () => {
  const json = { bookmakers: [
    { key: 'draftkings', title: 'DraftKings', markets: [{ key: 'player_points', last_update: 'x', outcomes: [
      { name: 'Over', description: 'Jalen Brunson', price: 1.87, point: 26.5 },
      { name: 'Under', description: 'Jalen Brunson', price: 1.95, point: 26.5 },
    ] }, { key: 'player_threes', outcomes: [{ name: 'Over', description: 'Jalen Brunson', price: 2.1, point: 2.5 }] }] },
    { key: 'fanduel', title: 'FanDuel', markets: [{ key: 'player_points_rebounds_assists', outcomes: [
      { name: 'Over', description: 'Jalen Brunson', price: 1.9, point: 36.5 }, { name: 'Under', description: 'Jalen Brunson', price: 1.9, point: 36.5 }] }] },
  ] };
  const out = normaliseEventOdds(json);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { player: 'Jalen Brunson', stat: 'pts', book: 'draftkings', bookTitle: 'DraftKings', line: 26.5, over: 1.87, under: 1.95, updated: 'x' });
  assert.equal(out[1].stat, 'fg3m');
  assert.equal(out[1].under, null);
  assert.equal(out[2].stat, 'pra');
  const ev = normaliseEvents([{ id: 'e1', commence_time: '2026-10-27T23:30:00Z', home_team: 'Boston Celtics', away_team: 'New York Knicks' }]);
  assert.deepEqual(ev[0], { eventId: 'e1', tipoff: '2026-10-27T23:30:00Z', home: 'BOS', away: 'NYK' });
});

test('ESPN injury report (real response, trimmed) -> normalised', () => {
  const json = JSON.parse(readFileSync(new URL('./fixtures/espn-injuries.json', import.meta.url)));
  const out = normaliseInjuries(json);
  assert.ok(out.length > 0);
  for (const i of out) {
    assert.ok(i.name);
    assert.ok(i.team, `team for ${i.name}`);
    assert.ok(i.status);
  }
});
