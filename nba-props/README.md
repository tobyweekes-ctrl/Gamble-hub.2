# Prop Desk: NBA player prop analyser

Search a player, pick a stat, and get tonight's lines by bookmaker, a modelled over/under
probability, the no-vig edge and a verdict. For analysis only. Gamble responsibly. 18+.

## Stack

- **Node 22, zero npm dependencies.** The server uses `node:http` and built-in `fetch`; tests use `node:test`.
  Nothing to install, nothing to audit, and it starts instantly.
- **Server-side data layer.** All third-party calls and API keys stay on the server. The browser only talks to `/api/*`.
- **Two-level cache:** in-memory in front of JSON files in `cache/`. It shares one in-flight call between concurrent
  callers, serves the stale copy if an upstream fails, keeps completed seasons forever and throttles each host.
- **Vanilla ES-module frontend, no build step.** Hand-drawn SVG charts (phase 3). Fast, small and keyboard-first.
- **Model in its own module** (`server/model/`, phase 2) as pure functions with the weights in one config object,
  shared by the API and `scripts/backtest.mjs`.

## Run

```bash
cp .env.example .env      # add keys (optional, see below)
npm start                 # http://localhost:5177
npm run warm              # optional: pre-fetch both seasons, slate, injuries
npm test
STATS_PROVIDER=demo npm start   # fully offline synthetic league (fictional players)
```

## Data sources

| Data | Source | Cost / caching |
|---|---|---|
| Box scores, both seasons | `stats.nba.com` `leaguegamelog` (what `nba_api` wraps); 1 call per season | past season: cached forever; current: 3h |
| Positions | `stats.nba.com` `playerindex` | with the season |
| Box scores (alternative) | balldontlie `/stats` (`STATS_PROVIDER=balldontlie`, ALL-STAR tier) | full pull once, then a date-incremental top-up |
| Tonight's games | `scoreboardv2`, or balldontlie `/games` | 1h |
| Prop lines | The Odds API: `/events` (free) + `/events/{id}/odds` with all 8 prop markets in one call, only for games you open | `ODDS_TTL_MIN` (10 min) |
| Injuries | ESPN public injury report | 30 min |

From these the data layer works out pace, offensive and defensive rating, usage rate,
**defence vs position** (stat allowed per minute to guards, forwards and centres, relative to
league average and shrunk toward 1 for small samples), rest days, back-to-backs, and
**absences and returns** (team games missed, minutes in each game since coming back).

Note: stats.nba.com blocks many cloud and datacenter IPs. It works from a home connection. If it
is blocked for you, use `STATS_PROVIDER=balldontlie`.

## Layout

```
server/
  index.mjs            HTTP server + API routes
  env.mjs, cache.mjs, http.mjs, teams.mjs, stats.mjs, util.mjs
  providers/           nbaStats, balldontlie, oddsApi, espnInjuries, demo
  data/derive.mjs      pure derivations (pace, usage, position defence, absences)
  data/store.mjs       provider selection, caching, indexed League, search, lines
  model/               (phase 2)
web/                   index.html, app.js, styles.css
scripts/               warm-cache.mjs, backtest.mjs (phase 2)
test/
```

## API

`GET /api/health` · `/api/players/search?q=` · `/api/player/:id` · `/api/player/:id/lines?stat=pts`
· `/api/slate?date=` · `/api/injuries` · `/api/teams` · `/api/stats`

Stat keys: `pts reb ast fg3m pra pr pa ra`.
