// Unibet's prices from the Kambi offering API (the public feed Unibet's own site
// uses; it allows cross-origin reads, so the app can also refresh it in the
// browser). Used for player props (fouls conceded, shots, shots on target, to get
// a card, red card) and match/team totals (cards, fouls, shots, shots on target),
// which no other reachable source prices. Not Bet365: prices are usually close
// but not identical.
import { execFileSync } from 'node:child_process';

export const KAMBI = 'https://eu-offering-api.kambicdn.com/offering/v2018/ubuk';
const Q = 'lang=en_GB&market=GB';
export const KAMBI_PATHS = {
  'Premier League': 'england/premier_league', Championship: 'england/the_championship',
  Bundesliga: 'germany/bundesliga', 'Serie A': 'italy/serie_a', 'Ligue 1': 'france/ligue_1',
  'Champions League': 'champions_league', 'Europa League': 'europa_league', 'Conference League': 'conference_league',
};
const get = url => { try { return JSON.parse(execFileSync('curl', ['-sSf', '--compressed', '-m', '40', url], { encoding: 'utf8', maxBuffer: 64e6 })); } catch { return null; } };

export const kambiEvents = league => (KAMBI_PATHS[league] ? get(`${KAMBI}/listView/football/${KAMBI_PATHS[league]}.json?${Q}`)?.events || [] : []);
export const kambiEventOffers = id => get(`${KAMBI}/betoffer/event/${id}.json?${Q}`);

// Player and totals markets from one event's bet offers. Shared shape with the
// browser refresh in index.html (parseKambiOffers there), so keep the two in step.
//   players: [{ name, mk: 'fc'|'sh'|'sot'|'yc'|'rc', k, odds }]   (k = at least k)
//   totals:  [{ scope: 'match'|'home'|'away', mk: 'cards'|'fouls'|'shots'|'sot', line, over, under }]
export function parseKambiOffers(data, homeName, awayName) {
  const players = [], totals = [];
  for (const b of data?.betOffers || []) {
    const lab = b.criterion?.label || '';
    if (/1st Half|2nd Half|\d\d:\d\d/.test(lab)) continue;
    const pm = /^Player's fouls conceded/.test(lab) ? 'fc' : /^Player's shots on target/.test(lab) ? 'sot' : /^Player's shots/.test(lab) ? 'sh'
      : /^To Get a Red Card/.test(lab) ? 'rc' : /^To Get a Card/.test(lab) ? 'yc' : null;
    if (pm) {
      for (const o of b.outcomes || []) {
        if (o.status !== 'OPEN' || !o.odds || !o.participant) continue;
        if (!(o.type === 'OT_OVER' || o.type === 'OT_YES')) continue;
        const k = pm === 'yc' || pm === 'rc' ? 1 : Math.round(o.line / 1000 + 0.5);
        players.push({ name: o.participant, mk: pm, k, odds: o.odds / 1000 });
      }
      continue;
    }
    const tm = /^Total Cards/.test(lab) ? 'cards' : /^Total Fouls conceded/.test(lab) ? 'fouls' : /^Total Shots on Target/.test(lab) ? 'sot' : /^Total Shots/.test(lab) ? 'shots' : null;
    if (!tm || b.betOfferType?.name !== 'Over/Under') continue;
    const rest = lab.replace(/\s*\(Settled using Opta data\)/, '').replace(/^Total (Cards|Fouls conceded|Shots on Target|Shots)\s*/, '').replace(/^(-|by|By)\s*/, '').trim();
    const scope = !rest ? 'match' : rest === homeName ? 'home' : rest === awayName ? 'away' : null;
    if (!scope) continue;
    const over = (b.outcomes || []).find(o => o.type === 'OT_OVER' && o.status === 'OPEN'), under = (b.outcomes || []).find(o => o.type === 'OT_UNDER' && o.status === 'OPEN');
    if (!over || !under) continue;
    totals.push({ scope, mk: tm, line: over.line / 1000, over: over.odds / 1000, under: under.odds / 1000 });
  }
  return { players, totals };
}
