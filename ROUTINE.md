# Weekly update routine

This runs every Friday morning (UK time) as a scheduled Claude session, and can also be run by hand. Its job is to grade last week's games, refit our model, load the next 7 days and publish the site.

The predictions come from **our own model** (`tools/model/`), which is fitted on match results and never sees bookmaker prices. Bookmaker prices are still collected each week, but only to compare against and to find possible mispricing. Never fabricate results, odds, lineups, xG or injuries. A gap is labelled, not filled.

## Scope

- **Premier League, Championship, Champions League:** every fixture in the window.
- **Bundesliga, Serie A, Ligue 1:** every fixture in the window involving a team that is in that league's top 4 on the day of the build.
- **Window:** from the build until the following Thursday, 23:59 UK time.

## Steps

1. **Read** `LEDGER.md`, `data/README.md` and the latest file in `data/rounds/`.
2. **Results.** Run `node tools/results.mjs`. It checks every finished fixture in `data/rounds/` against BBC Sport and ESPN, and stores scores where both agree. A score found in only one place is marked "single source", and a disagreement is listed and not stored. List anything not found or in conflict in `LEDGER.md`. A missing score may be added by hand from two sources.
3. **Grade** in `LEDGER.md`:
   - market and model 3-way Brier;
   - favourite hit rate;
   - BTTS and Over 2.5 where priced.

   Use `node tools/fit-blend.mjs data/ledger.json` for the Brier figures. Say plainly when the model loses. Do not change any weight below a few hundred graded games; the fitter refuses below 300.
4. **Refresh the model data:**
   - `sh tools/model/fetch.sh` downloads results and match stats from football-data.co.uk.
   - `node tools/model/fetch-europe.mjs` downloads European fixtures and results from UEFA.
   - On the first Friday of each month, also run:
     - `node tools/model/backtest.mjs` (about 15 minutes). It refreshes the context factors and the backtest summary shown on the site.
     - `node tools/model/fetch-lineups.mjs` then `node tools/model/backtest-players.mjs` (about 6 minutes). These refresh the player model's parameters and its test.
   - Re-tune (`node tools/model/tune.mjs`, about 30 minutes, then the backtest) only at the start of a season, not week to week.
5. **Build the next round:** run `node tools/make-round.mjs`. It writes `data/rounds/<YYYY-MM-DD>-weekly.json`:
   - BBC Sport tables and fixtures, with UK kick-off times;
   - the top-4 filter for Bundesliga, Serie A and Ligue 1;
   - Bet365 1X2, BTTS and Over 2.5 prices from kickoff.co.uk match pages, after checking the page's match date.

   It prints any gaps (a missing price or table). Fill a gap by hand only from a named source, and never estimate. Lineups are not known on Friday morning; the lineup-time runs add them.
6. **Build and check:**
   - `node tools/model/season-sim.mjs` plays out the rest of each league season 10,000 times with the model, for the site's season simulator. It takes about 30 seconds, and any "warning" means a team name needs adding to `TEAM_ALIASES`.
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

## Lineup-time updates

Separate scheduled sessions run at Fri 19:00, Sat 11:20, 14:00 and 17:00, and Sun 13:00 and 15:15 (UK time). Team sheets come out about 60-75 minutes before kick-off. Each run:

1. `sh tools/model/fetch.sh` and `node tools/model/fetch-europe.mjs`. The model needs the results data to build.
2. `node tools/lineup-update.mjs`. This updates the latest round file:
   - results for finished games;
   - confirmed XIs from ESPN, naming each side's missing regulars and any back-up goalkeeper;
   - fresh Bet365 prices for games not yet started.

   It then reruns the season simulator and rebuilds the site under the same round, tagged with the time, so visitors keep their draft slip.
3. `node tools/verify.mjs --browser`, then publish as in step 7, on a branch named `claude/lineups-YYYY-MM-DD-HHMM`.
4. Report which fixtures got lineups and which regulars are missing. Also report the top of the mispricing list now that prices reflect team news.

Lineups change the model's numbers only if the monthly backtest found that lineup adjustments improve accuracy on the test seasons (`lineup.enabled` in `data/model/context.json`). Until then they are shown, not applied.

If no lineups are announced yet (for example a 12:30 kick-off whose team sheets are late), the run still refreshes prices and results, and says so.

## Sources

**Used by the scripts (21-22 Oct 2026):**
- BBC Sport: fixtures, results (`?filter=results`) and tables, read from the page's embedded data.
- kickoff.co.uk: match pages with Bet365 1X2, BTTS and O/U 2.5.
- ESPN API (`site.api.espn.com`): lineups, player match stats and results.
- football-data.co.uk: historical results and stats for the model.
- UEFA match data (`match.uefa.com`): European fixtures.

**Blocked from the cloud environment:**
- footballwebpages.co.uk: returns 403 to automated requests.
- sofascore, fbref, whoscored: all return 403.

**Worked before (owner's own sessions):**
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
