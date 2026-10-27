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
- **Model in its own module** (`server/model/`) as pure functions with every weight in `server/model/config.mjs`,
  shared by the API and `scripts/backtest.mjs`.

## Run

```bash
cp .env.example .env      # add keys (optional, see below)
npm start                 # http://localhost:5177
npm run warm              # optional: pre-fetch both seasons, slate, injuries
npm run backtest          # model on last season's games; report in reports/
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
| Game spread (optional) | Added to the same call when `ODDS_FETCH_SPREADS=true` (+1 market); **off by default** | with the props |
| Injuries | ESPN public injury report | 30 min |

From these the data layer works out pace, offensive and defensive rating, usage rate,
**defence vs position** (stat allowed per minute to guards, forwards and centres, relative to
league average and shrunk toward 1 for small samples), rest days, back-to-backs, and
**absences and returns** (team games missed, minutes in each game since coming back).

Note: stats.nba.com blocks many cloud and datacenter IPs. It works from a home connection. If it
is blocked for you, use `STATS_PROVIDER=balldontlie`.

## Model (`server/model/`)

For each player, stat and line:

1. **Minutes** (`minutes.mjs`), as an explicit step, each adjustment listed in the UI:
   - base minutes: this season's recency-weighted minutes with the current team, blended with last season
     (`n/(n+5)`, or `n/(n+2)` after a team change)
   - return from injury: first game back = 75% of pre-injury; then follow minutes since return plus a ramp; wider spread
   - teammates out: his own with/without history (shrunk to small samples), else a positional share of the
     absent player's minutes
   - blowout risk: expected margin from the spread (if `ODDS_FETCH_SPREADS=true`) or team net ratings; his own
     minutes in past blowouts vs normal games
   - back-to-back; optional manual minutes override
2. **Per-minute rate** (`projection.mjs`) for pts, reb, ast and 3PM: this season vs last season `n/(n+12)`
   (3PM `n/(n+20)`), then 70% season, 20% last 10, 10% last 5. Multiplied by home/away, back-to-back, matchup
   pace, opponent defence vs his position (guards / forwards / centres), head-to-head (`n/(n+15)`, capped ±10%),
   and the usage bump from teammates out. Combos sum their parts.
3. **Distribution** (`distributions.mjs`): negative binomial with dispersion fitted to his game-to-game spread
   (it falls back to Poisson when the data show no extra spread, as with most 3PM), mixed over the minutes
   uncertainty, plus the uncertainty of the estimate itself (sampling error + `modelCv`).
4. **No-vig edge** (`odds.mjs`, `evaluate.mjs`): implied probabilities with the margin removed (multiplicative,
   or power); one-sided prices assume a 5% margin. Edge = model probability − no-vig probability.
5. **Verdict**: OVER / UNDER only if edge ≥ `threshold` (4%) **and** EV > 0 at the offered price; else PASS.
   Confidence HIGH / MEDIUM / LOW from edge size and a data-quality score.
6. **Hit rates** vs the exact line: last 5, 10, 20, this season, last season.

### Season blending and team changes

The weight on this season is `n / (n + k)` where n = games this season. With `k = 12` (scoring rates):
0 games → 100% last season, 5 → 29%, 15 → 56%, 40 → 77%. Minutes use `k = 5` because roles settle quickly.
Team pace and defence use `k = 15` team games. After a team change, per-minute production carries over (skill
travels) but last season's minutes count far less (`k = 2`), and only games with the new team set the minutes base.

### Backtest (`npm run backtest`)

`node scripts/backtest.mjs --season 2025-26 [--from --to] [--stats pts,reb] [--set adjust.defWeight=0.6] [--dump]`

Only data from before each game is used (team stats come from a weekly snapshot). Three sections, kept separate:

1. **Accuracy + calibration**, which need no lines: projection error vs season-average and last-10 baselines,
   Brier score and calibration buckets, and a *spread* ratio (1.00 = the predicted uncertainty matches reality).
2. **ROI vs ESTIMATED lines**, clearly labelled. There are no free historical prop lines, so each line is estimated
   (0.6 × last-10 + 0.4 × season average, rounded to x.5, 1.91 both sides). Real books are sharper, so this ROI
   overstates what you would get. Treat it as a sanity check only.
3. **ROI vs REAL lines**: every Odds API fetch is saved (`userdata/live/odds/`) and graded at the latest
   pre-tip-off price, together with your manual lines. This starts empty and grows as you use the app.

### Manual lines and bet log

Add any bookie's line (fractional `10/11`, decimal or American; one side is enough) on the player page. It is
evaluated exactly like feed lines and **saved on the server** (`userdata/<demo|live>/entries.json`), with the
model's numbers at the time. **Take** marks any line as a bet (side, stake, price). The **Bets** page grades bets
from box scores (DNP = void) and shows W-L, profit and ROI, split by bets with and against the model's pick.
Demo and live data are stored separately.

## Layout

```
server/
  index.mjs            HTTP server + API routes
  env.mjs, cache.mjs, http.mjs, teams.mjs, stats.mjs, util.mjs
  providers/           nbaStats, balldontlie, oddsApi, espnInjuries, demo
  data/derive.mjs      pure derivations (pace, usage, position defence, absences)
  data/store.mjs       provider selection, caching, indexed League, search, lines
  data/userdata.mjs    manual lines, bet log, odds snapshots, grading
  model/               config, context, minutes, projection, distributions, odds, evaluate
web/                   index.html, styles.css, js/ (app, player, bets, ui)
scripts/               warm-cache.mjs, backtest.mjs
userdata/, reports/    created at runtime, gitignored
test/
```

## API

`GET /api/health` · `/api/players/search?q=` · `/api/player/:id` · `/api/player/:id/lines?stat=pts`
· `/api/player/:id/analysis?stat=pts[&line=&over=&under=&book=][&min=]` · `/api/slate?date=` · `/api/injuries`
· `/api/teams` · `/api/stats` · `GET/POST /api/entries` · `PATCH/DELETE /api/entries/:id` · `GET /api/bets`

Stat keys: `pts reb ast fg3m pra pr pa ra`.
