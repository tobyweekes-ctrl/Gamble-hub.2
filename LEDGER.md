# Results ledger

The running record of how the predictions have done. Only graded games count. Figures before 21 Oct 2026 come from the owner's earlier records in the Betting Analysis project and were not recomputed here.

## Record to 20 Oct 2026 (55 games graded)

- **Market favourite:** won 39 of 55 (71%).
- **Market 1X2 Brier:** 0.420. A know-nothing forecast scores 0.667; lower is better.
- **Model v2 (goal rates only):** lost clearly to the market, Brier 0.568 against 0.407 on the same 10 weekend games.
- **Model v3 (70% market-implied, 30% goal rates):** 0.447 in a back-test, which is not a forward test. Only 2 forward v3 predictions so far.
- The model has not beaten the market anywhere.
- The Champions League nights on 14 and 20 Oct averaged 4.8 goals per game. Not a trend.

## Bets (as reported by the owner)

- **Wed 14 Oct, 5-fold:** cashed out for £15 profit. The Over 2.5 leg then lost.
- **Thu 15 Oct, 6-fold at 20.52:** won, £140.
- **19-21 Oct, 7-fold suggested by Claude:** lost on Fenerbahçe and Porto.

## Wed 21 Oct, Champions League matchday 3 (graded 21 Oct)

Scores agree on two sources: BBC Sport scores page and UEFA match data.

| id | Fixture | Score | Market H/D/A | Favourite won? |
|---|---|---|---|---|
| uc10 | Como 1907 v Manchester United | 4-1 | 43/25/32 | yes |
| uc11 | Lille v Galatasaray | 2-4 | 43/26/31 | no |
| uc12 | Aston Villa v Viking | 3-1 | 78/14/8 | yes |
| uc13 | Bayern Munich v Arsenal | 2-2 | 45/25/30 | no (draw) |
| uc14 | Club Brugge v Racing Lens | 3-0 | 49/23/28 | yes |
| uc15 | Inter Milan v Shakhtar Donetsk | 1-0 | 79/14/7 | yes |
| uc16 | Real Madrid v RB Leipzig | 4-1 | 78/13/9 | yes |
| uc17 | Real Betis v Feyenoord | 1-0 | 60/21/19 | yes |
| uc18 | Sporting CP v LASK | 2-3 | 79/14/7 | no |

- **Market:** favourite won 6 of 9. 3-way Brier 0.492 on these 9 games. BTTS calls 6 of 9, Over 2.5 calls 7 of 9.
- **Model:** only 2 entries (uc10, uc13), both using the unverified team-profile estimates. Brier 0.693 against the market's 0.672 on the same two games, so the model lost narrowly. Two games mean nothing either way.
- **Goals:** 3.8 per game on the night.

## Record to 21 Oct 2026 (64 games graded)

- **Market favourite:** won 45 of 64 (70%).
- **Market 1X2 Brier:** about 0.430. This combines 0.420 on the first 55 games with 0.492 on these 9.
- The model has still not beaten the market anywhere. Forward v3 sample: 4 games.

## Model change, 22 Oct 2026

From the 2026-10-21-weekly round, "model" means the independent model v4 (`tools/model/`), which is built without bookmaker prices. Before that it meant ensemble v3, the 70/30 market blend. Log entries carry the model version, so the two are never mixed.

Backtest of v4 on seasons it never saw (2025/26 and 2026/27 to date, 2,313 matches; see `data/model/backtest.json`):

| | Brier (3-way) | Log-loss |
|---|---|---|
| Our model | 0.6073 | 1.014 |
| Bet365 pre-match | 0.5978 | 1.000 |
| Closing prices | 0.5974 | 0.998 |

- **Value bets:** flat stakes on every 1X2 edge above 5% placed 1,138 bets and returned -17.0% per unit (95% range -26% to -7%). The price shortened after the bet 46% of the time. Over 2.5 edges also lost.
- **Verdict:** the model is calibrated, but it is less accurate than the bookmaker. Its disagreements have not been bargains so far.

## Model update v4.1, 22 Oct 2026

**Changes:**
- Earlier seasons count for less (a squad-change discount).
- Elo regresses between seasons.
- The shots model uses 2026/27 xG.

**Test seasons:** Brier 0.6070, log-loss 1.0136 (v4: 0.6073 / 1.014). Bet365: 0.5978 / 0.9997.

**Value bets:** 1X2 edges above 5% still lost money, returning -18.9% per unit (95% range -29% to -9%).

**Lineups:** measured from 6,700 ESPN XIs, and not applied because they did not improve the test seasons (log-loss 1.0169 with them against 1.0152 without). Confirmed lineups are shown on the site from the lineup-time runs.

Log entries from this round are under `independent-v4.1-2026-10-22`.

## Thu 22 Oct 2026: Europa League and Conference League (cross-league model)

35 games graded; Kairat v Panathinaikos was already in play when the model went up and has no prediction. Predictions are the site version of 17:34 UK, before every kick-off (added to `data/ledger.json` with `tools/ledger-from-history.mjs`). Scores from match.uefa.com and ESPN, which agreed on all 35.

| Market | Our model | Know-nothing guess | Bet365, 10 priced games |
|---|---|---|---|
| Win/draw/loss | favourite won 16/35; Brier 0.620, log-loss 1.024 | 0.667 / 1.099 | Bet365 favourite 6/10 (ours 5/10); Brier 0.53 v ours 0.58 |
| BTTS | 18/35 calls right; log-loss 0.704 | 0.693 | level on log-loss (0.711) |
| Over 2.5 | 21/35 calls right; log-loss 0.676 | 0.693 | Bet365 better (0.543 v 0.586) |

Read: better than guessing on the result and Over 2.5, no better on BTTS (as the backtest said), and behind Bet365 on the few games with prices. One night is far too small to judge.

## Player model by position (test seasons 2025/26-2026/27, 46,000 player-matches)

Checked because most player-prop "value" flags against Unibet were 1+ shots on target for midfielders and full-backs. The model is calibrated within each position group, so those flags are not a position bias:

| Market | Defenders: predicted / actual | Midfielders | Forwards |
|---|---|---|---|
| 1+ shots on target | 13.6% / 13.9% | 28.6% / 29.3% | 49.2% / 49.8% |
| 2+ shots | 11.6% / 12.0% | 29.8% / 31.3% | 52.2% / 54.5% |
| 1+ fouls committed | 57.5% / 57.4% | 62.2% / 60.7% | 63.0% / 61.2% |
| Booked | 15.2% / 16.8% | 14.4% / 15.2% | 9.7% / 10.1% |

Unibet's player prices imply far higher chances on average (booked about 27%, 1+ fouls about 80%), so most of the gap is bookmaker margin. Whether the few flagged prices are real value is being tested: every price is logged (`data/props/log.jsonl`) and graded (`data/props/graded.json`).

## Model v4.2 (23 Oct 2026, overnight refinement)

Everything below was chosen on the validation seasons (2023/24, 2024/25) and only then scored on the test seasons (2025/26, 2026/27 to date). A change is kept only if validation chose it.

**Kept**
- **Log pooling of the three components** (weighted geometric mean, then calibrated) in place of a weighted average. Two-fold CV on validation: 0.9910 v 0.9912. Weights goals 0.55, shots 0.55, Elo 0. Test seasons, 2,313 matches: log-loss 1.0128 (v4.1: 1.0136), Brier 0.6065 (0.6070). Bet365: 0.9997 / 0.5978. Still behind the bookmaker; value bets on 1X2 edges above 5% still lose (-16.3% per unit, 1,121 bets).
- **Cross-league (European) model:** slower time decay and no extra between-season discount (xi 0.001, season discount 1; was 0.0015 and 0.7). Validation 0.9169 (0.9194); test 0.9484 (0.9519), against 1.0385 for base rates.

**Tried and not kept (no gain on validation)**
- Shrinkage of team ratings towards the league mean in the domestic model: flat across settings (validation 0.9956-0.9997); the leagues have enough data.
- Off-target shots in the shots model's chance-quality measure (SoT + w x off-target shots): worse at every weight (w 0.1: 0.9983 v 0.9982).
- A shots component for the European model from ESPN team stats (36,209 matches; 443 clubs linked between UEFA and ESPN). Shots alone were much weaker than goals (validation 0.96 v 0.917), so validation gave it zero weight: ESPN's stats are patchy for smaller leagues and qualifiers. Kept in the code for re-testing.
- Direct models for BTTS and Over 2.5 (logistic on expected goals and shots) instead of recalibrated Poisson: all within 0.0003 of each other. BTTS test log-loss: league base rate 0.6865, current 0.6858, best alternative 0.6855. BTTS is close to unpredictable beyond its base rate with this data.

- Player-quality lineups: each XI's share of the team's usual shots on target and assists (and, separately, share of regulars) as a multiplier on expected goals, on 5,719 matches with ESPN lineups. Validation improved slightly (0.9901 v 0.9927) but the test seasons got worse (1.0171 v 1.0145), the same pattern as the regulars-only test in v4, so lineups stay off the numbers.
- Referee effect on yellow cards (Premier League, where football-data records referees): a referee's past card rate did not predict cards beyond the two teams' own rates (Poisson log-loss, test: 2.0748 with the referee, 2.0737 without). Referees' raw rates (0.88-1.22 of average) mostly reflect which games they are given.

**Player model: longer, weighted history (kept).** Player rates now use the last 730 days, each match weighted 0.5^(age / 365 days), in place of a flat 365 days. Chosen on validation (also tried 545/270, 730 flat, 730/180). Test log-loss, 46,000 player-matches: 1+ fouls committed 0.6516 (was 0.6535), 1+ fouls won 0.6402 (0.6421), 1+ shots on target 0.5240 (0.5257), 2+ shots 0.4954 (0.4973), booked 0.4134 (0.4142); still calibrated by position. 48 of 3,144 current Unibet player prices show value by the model (53 before).

Pipeline check: the lineup-time update was run end to end from a fresh clone (fetch, results, lineups, prices, Unibet props, grading, build, verify) and passed. That run showed the scheduled updates fetched only 150 days of ESPN lineups while the player model rates players on 365 days; they now fetch 370 days.

Log entries from this version are under `independent-v4.2-2026-10-23`.

## Weekend 23-24 Oct 2026 (v4.2, 19 games, graded 24 Oct)

- **Win/draw/loss:** log-loss 1.035 v Bet365 1.029; Brier 0.623 v 0.619. Favourite won 9/19 (Bet365's 8/19).
- **Over 2.5 called right:** 10/19 (Bet365 8/19). **BTTS called right:** 11/19 (Bet365 13/19).
- **Value bets (edge 5%+ v Bet365):** 1X2 1 of 8 won, -4.40 units; goals/BTTS 5 of 10 won, +2.83 units. In the 2,300-game backtest, goals disagreements lost about 5%, so this is not evidence of an edge.
- **Lineups:** on the 16 games with confirmed sheets, applying the lineup adjustment would have been worse (log-loss 1.038 v 1.026 without). Lineups stay off the numbers.
- **Player props (Unibet, 1,708 prices, 18 games):**
  - The model expected 23.4% to land, and 25.2% did. Unibet's prices implied 37.5%.
  - Value picks (5%+): 30 bets, +1.27 units. By market: shots 5 of 10 won, +7.17; shots on target 5 of 20 won, -5.90 (about 6.5 expected).
  - Shots are under-predicted in every probability band (for example, 64% predicted, 78% landed). Shots on target, fouls and cards are calibrated. To be checked on past seasons before any change.
- **Grader fix:** unused substitutes are no longer graded as losses. Unibet voids those bets.
- **Source conflict:** ESPN records Mikel Merino (Arsenal v Everton) with 0 fouls, but the owner reports the bookmaker settled his 1+ foul as a winner. Bookmakers settle on Opta data, so some foul gradings may differ.

## Full weekend 23-26 Oct 2026 (v4.2, 32 games, graded 27 Oct)

- **Win/draw/loss:** log-loss 0.956 v Bet365 0.966; Brier 0.568 v 0.575. Favourite won 16/32 (Bet365's 15/32). Ahead of Bet365 this weekend. On 2,313 test games we are behind, so one weekend changes nothing.
- **Over 2.5 called right:** 17/32 (Bet365 15/32). **BTTS called right:** 16/32 (Bet365 19/32).
- **Value bets (edge 5%+ v Bet365):**
  - 1X2: 3 of 15 won, -5.57 units (-37%).
  - Goals/BTTS: 9 of 18 won, +5.43 units (+30%).
  - The backtest says both lose over time (1X2 -16%, goals about -5%). No change.
- **Lineups:** on 22 games with confirmed sheets, the lineup adjustment would have made predictions worse (log-loss 1.062 v 1.053). Lineups stay off the numbers.
- **Data confidence:** "high" (team sheets confirmed) games were no easier to call than "medium" ones (16 each). Confidence describes the data, not how predictable a game is.
- **Player props (Unibet, 3,336 prices graded):**
  - The model's average is close: 24.9% predicted, 24.8% landed. Unibet's prices implied 39.2%.
  - Value picks (5%+), all: 61 bets, +0.23 units. Shots: 26 bets, +8.33. Shots on target: 33 bets, -6.10, with 8 won against 10.0 expected.
  - The shots under-prediction seen on Saturday did not hold over the whole weekend (33.3% predicted, 35.0% landed).
  - **Prices logged before lineups were confirmed:**
    - value picks 17 bets, -9.26 units (-54%);
    - players who then came off the bench: 27.8% predicted, 19.1% landed.
  - **Prices logged on confirmed lineups:** value picks 44 bets, +9.49 units (+22%), 16 won against 15.0 expected.
- **PSG v Lyon** was moved from Sun 25 to Mon 26 Oct; BBC and ESPN agree it finished 2-0. The fixture keeps its original id so the prediction logged before it still grades.

**Changes made**
- **Player-price value flags (site):** a price goes green only once both team sheets are out and the player starts. Before that, a gap shows as "wait for lineups". Starters are listed first in the biggest-gaps board.
- **Prop grading:** `data/props/graded.json` also reports `confirmed` and `preLineups` separately.
- **Results:** `tools/results.mjs` finds rescheduled league games, up to 7 days either side of the listed date. It takes the result only when BBC and ESPN agree on the date and score.
- **Team-name matching:** ESPN's short "Lyon" now matches "Olympique Lyonnais".
- **Model numbers:** unchanged. Nothing this weekend is enough evidence against the backtests.

## Heavy rotation and model-v-market disagreements (27 Oct 2026)

**Heavy rotation (tested; not applied).** Asked after the owner's point about cup rotation: does a side that starts few of its regulars do worse than the model expects? Tested on 5,700 league matches with ESPN lineups. Shares of regulars: median 85%, 10th percentile 69%.
- **Validation (2023/24-2024/25):**
  - Rotated sides concede more: under 70% of regulars, conceded x1.05 and scored x0.96; under 60%, conceded x1.11 and scored x1.03.
  - Validation chose the 60% threshold: log-loss 0.9946 against 1.0001 without, on 171 games.
- **Test (2025/26-2026/27, 157 games):** 0.9863 with the adjustment and 0.9863 without, so no gain. Bet365 scored 0.9784 on the same games.
- **The extreme cases are too few and point different ways:** under 50% of regulars, 48 validation and 67 test team-matches.
- **Weekend check:** this weekend's two most rotated sides both won: Newcastle (60% of regulars) 2-0 at Palace, and Wolves (67%) 1-0 v Watford.
- **So the numbers still don't move for lineups.** The site keeps showing changes and missing regulars, and lowers data confidence for 5+ changes.
- **What this can't tell us:** our data has no domestic cup games, where rotation is bigger and usually on both sides.
- The test is in `tools/model/backtest.mjs` (`heavyRotation` in `data/model/backtest.json`; `rotation` in `context.json`, on only if it improves the test matches).

**Model more bullish than Bet365 on home favourites.** On the test seasons there were 170 games where our model made the home side favourite at least 3 points above Bet365's margin-free price (example: West Ham v Southampton, 60% v 56%). Model average 63%, Bet365 56%, home side won 49%. When we disagree with the market, the market has usually been closer. That matches the blend weight of 0 fitted on validation.

## Pending

- **Round 2026-10-21-weekly:** 36 fixtures, Thu 22 to Wed 28 Oct. Grade them at the next weekly run.
