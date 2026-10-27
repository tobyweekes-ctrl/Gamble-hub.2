// The Odds API v4 (https://the-odds-api.com). Lines come from the API only; no bookmaker scraping.
// Quota: /events is free; /events/{id}/odds costs (#markets x #regions) per call, so we request all
// prop markets for one game in a single call, only when a player in that game is viewed, and cache it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchJson } from '../http.mjs';
import { config } from '../env.mjs';
import { teamAbbr } from '../teams.mjs';
import { STATS, statForMarket } from '../stats.mjs';

const BASE = 'https://api.the-odds-api.com/v4/sports/basketball_nba';
// Credits as reported by the API's response headers, saved so the counter survives restarts.
const QUOTA_FILE = join(config.cacheDir, 'odds-quota.json');
export const quota = { remaining: null, used: null, lastCost: null, updated: null };
try { Object.assign(quota, JSON.parse(readFileSync(QUOTA_FILE, 'utf8'))); } catch { /* none saved yet */ }

async function call(path, params = {}) {
  if (!config.oddsKey) throw new Error('ODDS_API_KEY is not set');
  const qs = new URLSearchParams({ apiKey: config.oddsKey, ...params });
  const { json, headers } = await fetchJson(`${BASE}${path}?${qs}`, { minGapMs: 300 });
  const rem = headers.get('x-requests-remaining');
  if (rem != null) {
    quota.remaining = Number(rem);
    quota.used = Number(headers.get('x-requests-used'));
    quota.lastCost = Number(headers.get('x-requests-last'));
    quota.updated = new Date().toISOString();
    try { writeFileSync(QUOTA_FILE, JSON.stringify(quota)); } catch { /* cache dir not writable */ }
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

/** Median home-team spread across books (negative = home favourite), or null. */
export function normaliseSpread(json) {
  const pts = [];
  for (const bk of json.bookmakers || []) {
    const m = (bk.markets || []).find((x) => x.key === 'spreads');
    const o = m?.outcomes?.find((x) => x.name === json.home_team);
    if (o?.point != null) pts.push(o.point);
  }
  if (!pts.length) return null;
  pts.sort((a, b) => a - b);
  return pts[Math.floor(pts.length / 2)];
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
  /** All prop markets for one game in one call (+ the spread if ODDS_FETCH_SPREADS is on). */
  async eventProps(eventId) {
    const markets = Object.values(STATS).map((s) => s.market);
    if (config.oddsFetchSpreads) markets.push('spreads');
    const json = await call(`/events/${eventId}/odds`, {
      regions: config.oddsRegions, markets: markets.join(','), oddsFormat: 'decimal', dateFormat: 'iso',
    });
    return { rows: normaliseEventOdds(json), homeSpread: config.oddsFetchSpreads ? normaliseSpread(json) : null };
  },
};
