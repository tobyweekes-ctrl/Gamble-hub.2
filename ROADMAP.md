# Matchday Ledger: roadmap

Status as of Wed 21 Oct 2026. 55 games graded. The market favourite won 39 of 55 (71%). Market 1X2 Brier is 0.420, against 0.667 for a know-nothing guess. The model has not beaten the market anywhere. Only 2 forward predictions exist for ensemble v3. The v3 figure of 0.447 is a back-test, not a forward test.

This file says what to build, in what order and what has to be true first. It does not claim the app is calibrated or profitable. There is no evidence for either.

## 0. Housekeeping (now)

- **The deployed file is stale.** In this repo, `index.html` is the 11 Sep build. It has no `SEED_VERSION`, model toggle, ensemble or prediction log. `matchday-ledger.html` is missing. GitHub Pages is serving that old build. Upload the current file as both `index.html` and `matchday-ledger.html` before anything else.
- `matchday-ledger.pdf` is a printout of the old build and can go.

## 1. Things we can do now, with no new data

| # | Item | Gate before acting |
|---|------|--------------------|
| 1.1 | Log and grade every fixture before kick-off. Market and model are logged separately; this is already in the round workflow. | None. Never skip a round. |
| 1.2 | **Also log the goal-rate model on its own (the 30% part), not just the blend.** Without it, the 70/30 weight cannot be fitted later. | Needed from the next round. Games logged without it cannot be used for the weight fit. |
| 1.3 | Also log the raw inputs: gfH/gaH/gfA/gaA, the league average, and the lineup and competition factors applied. Without them, the shrink toward the league average cannot be fitted. | Same as 1.2. |
| 1.4 | Fit the market weight with `tools/fit-blend.mjs`: chronological hold-out plus a bootstrap interval. | At least 300 graded games with 1.2 logged. The script refuses below that. Change the weight only if the hold-out interval is clearly below zero. |
| 1.5 | Fit the league-average shrink (currently halfway, for the Premier League) the same way. | Needs 1.3 logged and a few hundred Premier League games. Not built yet. |
| 1.6 | Track favourite hit rate and Brier separately by league and by competition, for example Champions League nights against weekend league games. | Describe only. Don't tune per league on small samples. |

Synthetic test run (not real data): with 800 games where the market *is* the true probability, a 240-game hold-out still could not separate a weight of 0.70 from 1.00. Expect "a few hundred" to mean 500 or more before a weight change is clearly supported.

Running the fitter:

```
node tools/fit-blend.mjs graded.json [--min 300] [--holdout 0.3] [--current 0.7]
```

The input format is in the header of `tools/fit-blend.mjs`. It is one record per graded game: `market` and `goalModel` triples, `kickoff` and the final score. The app's log export will need to be mapped to that format.

## 2. Needs data or tools we can't reliably get from here

In rough order of expected value per unit of effort:

1. **Closing odds from a sharp book (Pinnacle)** and odds movement. The closing price is the best public forecast. It is also the benchmark for whether a bet had value (closing-line value).
2. **Your own bet records**: stake, price taken, bookmaker, time, and cash-outs. With item 1 these measure real profit and whether you beat the closing price. This is the only honest test of an edge.
3. **Expected goals (xG) and shot data**, per team, home and away. Goals are noisy, and this is the biggest single upgrade to the 30% goal model.
4. **Team strength ratings** (Elo or fitted) across several seasons and linked leagues. These would replace the six-game goal rates, which are the weakest input.
5. **Full market coverage**: priced BTTS, O/U 2.5 and correct score for every game, so totals are fitted rather than relying on the 2.8 prior.
6. **Historical backtest**: several seasons of odds and results run in code before trusting any change. This needs items 1, 3 and 4 historically.
7. **Official lineups** (about an hour before kick-off) plus a live injury and suspension feed. Lineup factors then apply on confirmed information only, which is already the rule.
8. **Player-level data**: minutes, ratings, finishing and goalkeeper form, so a missing striker or keeper is worth a number. Depends on item 7.
9. **Match context**: rest days, travel, rotation risk, how much the game matters, referee and cards, weather. Every new factor needs its own hold-out test.
10. **Automation**: scheduled collection of results and odds, so the ledger fills itself. This needs a server or scheduled job; GitHub Pages alone cannot do it.

## 3. Staking and accumulators (last, and only with evidence)

- Accas have no edge while the model is built on the market. Multiplying legs multiplies the bookmaker margin. Say so on every slip.
- Same-game and correlated legs are not independent, so multiplying their probabilities misprices them. Price them jointly, or don't combine them.
- Fractional Kelly (for example a quarter of the Kelly stake) only once item 2.2 shows a positive closing-line value over several hundred bets. Until then, use flat small stakes or none.

## Rules that don't change

- Never fabricate results, odds, lineups, xG or injuries. Label gaps, and mark single-source scores.
- Don't tune on fewer than a few hundred graded games. Report honestly when the model loses.
- Refresh log entries only before kick-off.
