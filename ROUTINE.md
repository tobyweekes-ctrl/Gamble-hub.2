# Weekly update routine

This runs every Friday morning (UK time) as a scheduled Claude session, and can also be run by hand. Its job is to grade last week's games, refit our model, load the next 7 days and publish the site.

The predictions come from **our own model** (`tools/model/`), which is fitted on match results and never sees bookmaker prices. Bookmaker prices are still collected each week, but only to compare against and to find possible mispricing. Never fabricate results, odds, lineups, xG or injuries. A gap is labelled, not filled.

## Scope

- **Premier League, Championship, Champions League:** every fixture in the window.
- **Bundesliga, Serie A, Ligue 1:** every fixture in the window involving a team that is in that league's top 4 on the day of the build.
- **Window:** from the build until the following Thursday, 23:59 UK time.

## Steps

1. **Read** `LEDGER.md`, `data/README.md` and the latest file in `data/rounds/`.
2. **Results.** Find the final score of every fixture from the previous round (and any older id still pending in `LEDGER.md`). Use two sources where possible. Add each to `data/results.json`, with `"note": "single source"` where there is only one. Leave out anything not found and list it as "not found" in `LEDGER.md`.
3. **Grade** in `LEDGER.md`:
   - market and model 3-way Brier;
   - favourite hit rate;
   - BTTS and Over 2.5 where priced.

   Use `node tools/fit-blend.mjs data/ledger.json` for the Brier figures. Say plainly when the model loses. Do not change any weight below a few hundred graded games; the fitter refuses below 300.
4. **Refresh the model data:**
   - `sh tools/model/fetch.sh` downloads results and match stats from football-data.co.uk.
   - `node tools/model/fetch-europe.mjs` downloads European fixtures and results from UEFA.
   - On the first Friday of each month, also run `node tools/model/backtest.mjs` (about 15 minutes). It refreshes the context factors and the backtest summary shown on the site.
   - Re-tune (`node tools/model/tune.mjs`, about 30 minutes, then the backtest) only at the start of a season, not week to week.
5. **Research the next round:**
   - full league tables (P, GF, GA, position);
   - fixtures with UK kick-off times;
   - prices for 1X2, BTTS and Over 2.5;
   - reported team news.

   Write `data/rounds/<seedVersion>.json`, with seedVersion in the form `YYYY-MM-DD-weekly`. Flag any disagreement between sources in that fixture's `form` text.
6. **Build and check:**
   - `node tools/build-seed.mjs data/rounds/<seedVersion>.json`. This fits the model to every result before the round and stores its numbers on each fixture. Any "model:" warning, such as a team name not found, must be fixed in `TEAM_ALIASES` in `tools/model/data.mjs`.
   - `node tools/verify.mjs --browser` must pass. It checks the copy is identical, the script compiles, it runs in a Node vm, and the page renders in Chromium with no errors.
7. **Publish.** Commit on a new branch `claude/weekly-YYYY-MM-DD`, push, open a pull request into `main`, and merge it. GitHub Pages serves `main`. `verify-shot.png` is ignored by git. On 21 Oct 2026 the owner asked for weekly updates to go onto the website automatically. So if the session has no GitHub pull-request tools, merge the branch into `main` locally and push `main`, but only after `tools/verify.mjs --browser` has passed.
8. **Report** in the session:
   - what was graded;
   - the record to date;
   - the fixtures loaded and anything not found;
   - any source conflicts;
   - the model's own record against the bookmaker's for the graded games;
   - the top items on the mispricing list. These are only bets to check, and the backtest has to be quoted with them;
   - this reminder: an accumulator has no edge when the model is built on the market price.

## Sources

**Worked before:**
- kickoff.co.uk: its listings give 1X2. The match pages linked from them give Bet365 1X2, BTTS and O2.5.
- footballwebpages.co.uk: tables, fixtures, results.
- uefa.com league-phase page and bundesliga.com matchday pages.
- goal.com tables.
- t-online.de live tickers.
- theanalyst.com (Opta).
- tuttoatalanta and sky.it (Serie A).
- rg.org (US best-price odds roundups).

**Failed before:**
- ESPN: pages are JS-rendered.
- oddsportal and oddspedia: no scores.
- worldfootball.net: blocked by robots.

Preview-site lineup and suspension claims have been wrong before. Treat them as unverified.

## If the network blocks the sources

The cloud environment's network policy must allow the sites above. If they are refused (proxy 403, DNS failure), do not build a round from memory or from search-result summaries. Change nothing on the site, and report which hosts were refused. The site keeps its last fixtures, and the next run tries again.
