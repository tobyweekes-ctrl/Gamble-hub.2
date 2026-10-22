// Walk-forward predictions: for each week, fit on matches before the week and
// predict the week's matches in the five covered leagues. Nothing from the week
// itself (or later) is used. Shared by the tuning and the backtest report.

import { GROUPS, DIV_LEAGUE } from './data.mjs';
import { fitRatings, scoreGrid, marketsFromGrid, fitRho, runElo, eloProbs, fitEloLink } from './models.mjs';

const DAY = 864e5;
const WEEK = 7 * DAY;

export function weeks(matches, fromSeason, toDate = Infinity) {
  const evalMs = matches.filter(m => DIV_LEAGUE[m.div] && m.season >= fromSeason && m.date < toDate);
  if (!evalMs.length) return [];
  const out = [];
  // Weeks start on Tuesday 00:00 UTC, so a weekend and its midweek round fall together.
  let t = evalMs[0].date - ((new Date(evalMs[0].date).getUTCDay() + 5) % 7) * DAY;
  t = Math.floor(t / DAY) * DAY;
  const end = evalMs[evalMs.length - 1].date;
  for (; t <= end; t += WEEK) {
    const wk = evalMs.filter(m => m.date >= t && m.date < t + WEEK);
    if (wk.length) out.push({ asOf: t, matches: wk });
  }
  return out;
}

export function rateComponent(matches, wks, { xi, sigma, hKey, aKey, toGoals, seasonDiscount = 1 }) {
  // Returns Map(match -> {lh, la}) of expected GOALS from a rating model refitted each week.
  const out = new Map();
  for (const { asOf, matches: wk } of wks) {
    for (const g of Object.keys(GROUPS)) {
      const target = wk.filter(m => m.group === g);
      if (!target.length) continue;
      const gm = matches.filter(m => m.group === g && m.date < asOf && asOf - m.date < 1500 * DAY);
      const r = fitRatings(gm, { asOf, xi, sigma, hKey, aKey, seasonDiscount });
      const conv = toGoals ? goalsPerShot(gm, asOf) : null;
      for (const m of target) {
        const e = r.expected(m.div, m.home, m.away);
        if (!e) continue;
        const k = toGoals ? conv[m.div] : 1;
        if (!k) continue;
        out.set(m, { lh: e.h * k, la: e.a * k });
      }
    }
  }
  return out;
}

export function goalsPerShot(gm, asOf) {
  const conv = {};
  for (const m of gm) {
    if (asOf - m.date > 365 * DAY || m.hst == null) continue;
    conv[m.div] = conv[m.div] || { g: 0, s: 0 };
    conv[m.div].g += m.hg + m.ag; conv[m.div].s += m.hst + m.ast;
  }
  return Object.fromEntries(Object.entries(conv).map(([d, v]) => [d, v.g / v.s]));
}

// Dixon-Coles rho per group, re-estimated at the start of each season from the
// previous two years of goals-model expectations (kept simple: one value per season).
export function rhoBySeason(matches, goalsL, seasons) {
  const out = {};
  for (const s of seasons) {
    for (const g of Object.keys(GROUPS)) {
      const pairs = [];
      for (const [m, l] of goalsL) if (m.group === g && m.season < s) pairs.push({ lh: l.lh, la: l.la, hg: m.hg, ag: m.ag, w: 1 });
      out[`${g}|${s}`] = pairs.length > 300 ? fitRho(pairs) : -0.05;
    }
  }
  return out;
}

export function eloComponent(matches, wks, { k, hfa, carry = 1 }) {
  // Elo ratings are walk-forward by construction (pre-match ratings). The link from
  // rating gap to probabilities is refitted each week on the previous three years.
  const elo = runElo(matches, { k, hfa, carry });
  const out = new Map();
  let link = null, linkAt = -Infinity;
  for (const { asOf, matches: wk } of wks) {
    if (asOf - linkAt > 28 * DAY) {
      const samples = [];
      for (const m of matches) {
        if (m.date >= asOf || asOf - m.date > 3 * 365 * DAY) continue;
        const r = elo.pre.get(m);
        samples.push({ x: (r.rh + hfa - r.ra) / 100, o: m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2 });
      }
      link = fitEloLink(samples); linkAt = asOf;
    }
    for (const m of wk) {
      const r = elo.pre.get(m);
      const x = (r.rh + hfa - r.ra) / 100;
      const p = eloProbs(x, link);
      out.set(m, { h: p[0], d: p[1], a: p[2], x });
    }
  }
  return out;
}

export function probsFromL(l, rho) {
  const mk = marketsFromGrid(scoreGrid(l.lh, l.la, rho));
  return { h: mk.h, d: mk.d, a: mk.a, btts: mk.btts, o25: mk.o25 };
}

export const outcome = m => (m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2);
export function brier3(p, o) {
  return [p.h, p.d, p.a].reduce((s, x, i) => s + (x - (i === o ? 1 : 0)) ** 2, 0);
}
export function logloss3(p, o) {
  return -Math.log(Math.max([p.h, p.d, p.a][o], 1e-12));
}
