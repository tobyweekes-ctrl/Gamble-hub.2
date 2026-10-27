// The Odds API v4 (https://the-odds-api.com). Lines come from the API only; no bookmaker scraping.
// Quota: /events is free; /events/{id}/odds costs (#markets x #regions) per call, so we request all
// prop markets for one game in a single call, only when a player in that game is viewed, and cache it.
import { fetchJson } from '../http.mjs';
import { config } from '../env.mjs';
import { teamAbbr } from '../teams.mjs';
import { STATS, statForMarket } from '../stats.mjs';

const BASE = 'https://api.the-odds-api.com/v4/sports/basketball_nba';
export const quota = { remaining: null, used: null, lastCost: null };

async function call(path, params = {}) {
  if (!config.oddsKey) throw new Error('ODDS_API_KEY is not set');
  const qs = new URLSearchParams({ apiKey: config.oddsKey, ...params });
  const { json, headers } = await fetchJson(`${BASE}${path}?${qs}`, { minGapMs: 300 });
  const rem = headers.get('x-requests-remaining');
  if (rem != null) {
    quota.remaining = Number(rem);
    quota.used = Number(headers.get('x-requests-used'));
    quota.lastCost = Number(headers.get('x-requests-last'));
  }
  return json;
}

export function normaliseEvents(events) {
  return events.map((e) => ({
    eventId: e.id,
    tipoff: e.commence_time,
    home: teamAbbr(e.home_team),
    away: teamAbbr(e.away_team),
  }));
}

/** Flatten a bookmaker/markets/outcomes tree into one row per (player, stat, bookmaker, line). */
export function normaliseEventOdds(json) {
  const out = [];
  for (const bk of json.bookmakers || []) {
    for (const m of bk.markets || []) {
      const stat = statForMarket(m.key);
      if (!stat) continue;
      const byKey = new Map();
      for (const o of m.outcomes || []) {
        const player = o.description;
        if (!player || o.point == null) continue;
        const k = `${player}|${o.point}`;
        const row = byKey.get(k) || { player, stat, book: bk.key, bookTitle: bk.title, line: o.point, over: null, under: null, updated: m.last_update || bk.last_update };
        if (/^over$/i.test(o.name)) row.over = o.price;
        else if (/^under$/i.test(o.name)) row.under = o.price;
        byKey.set(k, row);
      }
      out.push(...byKey.values());
    }
  }
  return out;
}

export const oddsApiProvider = {
  name: 'The Odds API',
  enabled: () => Boolean(config.oddsKey),
  async events() {
    return normaliseEvents(await call('/events', { dateFormat: 'iso' }));
  },
  async eventProps(eventId) {
    const markets = Object.values(STATS).map((s) => s.market).join(',');
    const json = await call(`/events/${eventId}/odds`, {
      regions: config.oddsRegions, markets, oddsFormat: 'decimal', dateFormat: 'iso',
    });
    return normaliseEventOdds(json);
  },
};
