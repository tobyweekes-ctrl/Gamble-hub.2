# Data files

- `rounds/<seedVersion>.json`: one file per weekly build. It is the input to `tools/build-seed.mjs`.
- `results.json`: final scores, keyed by fixture id. The builder copies the last 28 days into the app as `SEED_RESULTS`, so the browser grades its own prediction log.
- `ledger.json`: written by the builder. It snapshots every priced fixture before kick-off: market, goal model on its own, blend and raw goal rates. Scores are added from `results.json`. It is the input to `tools/fit-blend.mjs`. Don't edit it by hand.

## Round file

```json
{
  "seedVersion": "2026-10-23-weekly",
  "dataUpdated": "Fri 23 Oct, 09:00",
  "notes": ["Fri 23 - Thu 29 Oct 2026. Prices from ..."],
  "leagues": ["Premier League", "Championship", "Champions League", "Bundesliga", "Serie A", "Ligue 1"],
  "leagueQuality": { "Premier League": "researched" },
  "tables": {
    "Premier League": {
      "source": "footballwebpages.co.uk", "asOf": "Fri 23 Oct",
      "teams": { "Arsenal": { "pos": 1, "p": 8, "gf": 16, "ga": 5 } }
    }
  },
  "fixtures": [
    {
      "league": "Premier League", "home": "Arsenal", "away": "Everton",
      "kickoff": "2026-10-24T15:00:00+01:00",
      "odds1x2": [ { "source": "kickoff.co.uk Bet365", "h": 1.4, "d": "9/2", "a": 8.0 } ],
      "oddsBtts": [ { "source": "kickoff.co.uk Bet365", "yes": 2.1, "no": 1.7 } ],
      "oddsOu25": [ { "source": "kickoff.co.uk Bet365", "over": 1.75, "under": 2.05 } ],
      "teamNews": "Reported by <source>: ...",
      "form": "", "h2h": "", "referee": ""
    }
  ]
}
```

- **Prices** are decimal numbers or fractional strings ("9/2"). List every source you have; the builder removes the margin and averages them. Leave a market out entirely if it isn't priced; never estimate a price.
- **Tables** need the whole league, so the league average is right. A team missing from its league's table gets no goal rates, and that fixture becomes "market-implied". Champions League fixtures have no table and are always market-implied.
- **Kick-off** is ISO with the UK offset: +01:00 until Sat 24 Oct 2026, then +00:00 from Sun 25 Oct (the clocks go back).
- **Ids** are generated from league, date and team names, so rebuilding the same fixture before kick-off updates it rather than duplicating it. Set `"id"` yourself only to keep an older id.
- **Team news** is shown as reported and never changes the numbers. Lineup factors are only applied when confirmed, and a weekly build is always days before team sheets.

## results.json

```json
{ "pl-20261024-arse-ever": { "kickoff": "2026-10-24T15:00:00+01:00", "score": [2, 0],
    "sources": ["footballwebpages.co.uk", "bbc.co.uk"], "note": "" } }
```

Give two sources where possible. Write `"note": "single source"` when there is only one. Leave out a game whose score you couldn't find.

## Model files

- **`raw/`** (not committed): the inputs, re-downloaded each week.
  - `sh tools/model/fetch.sh`: football-data.co.uk results and match stats for England tiers 1-3 and the top two tiers of Germany, Italy and France, 2021/22 onwards.
  - `node tools/model/fetch-europe.mjs`: UEFA club-competition fixtures for those countries' clubs.
  - `node tools/model/fetch-lineups.mjs [--since YYYY-MM-DD] [--upcoming]`: ESPN starting XIs and player match stats, cached in `raw/lineups/`, plus announced lineups for the next 3 days.
- **`model/backtest.json`**: the out-of-sample test, written by `tools/model/backtest.mjs`. It covers accuracy against Bet365 and closing prices, a per-league breakdown, calibration, the value-bet simulation and the context-factor measurements. The site's backtest note is built from it.
- **`model/players.json`**: the player model's fitted parameters (shrinkage, dispersion, whether match context is used per stat) and its out-of-sample test for 1+ shots on target, 2+ shots, 1+ fouls committed, 1+ fouls won and booked. Written by `tools/model/backtest-players.mjs`.
- **`model/season.json`**: the season simulator's output from `tools/model/season-sim.mjs`. It has projected points and title, top-4, promotion and relegation chances.
- **`model/context.json`**: the context factors and the calibration the weekly build applies, both measured on the validation seasons only.
- **`tools/model/config.json`**: model settings chosen by `tools/model/tune.mjs` on the validation seasons.

Each built fixture also carries:

- **`model`**: our model's probabilities, expected goals, component models, context notes and expected match stats.
- **`prices`**: the first listed source's actual decimal prices, used for the edge calculation on the mispricing list.
