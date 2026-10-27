// Minimal .env loader (no dependency). Values already in process.env win.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^['"]|['"]$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const e = process.env;
export const config = {
  port: Number(e.PORT || 5177),
  statsProvider: (e.STATS_PROVIDER || 'nba').toLowerCase(),
  injuryProvider: (e.INJURY_PROVIDER || 'espn').toLowerCase(),
  balldontlieKey: e.BALLDONTLIE_API_KEY || '',
  balldontlieRpm: Number(e.BALLDONTLIE_RPM || 60),
  oddsKey: e.ODDS_API_KEY || '',
  oddsRegions: e.ODDS_REGIONS || 'us',
  oddsTtlMin: Number(e.ODDS_TTL_MIN || 10),
  // Also fetch the game spread with the props (1 extra market per call) for the blowout model.
  // Off by default; without it the model estimates the margin from team ratings.
  oddsFetchSpreads: /^(1|true|yes)$/i.test(e.ODDS_FETCH_SPREADS || ''),
  cacheDir: e.CACHE_DIR || join(ROOT, 'cache'),
  userDataDir: e.USERDATA_DIR || null,
  // Fixed "today" for reproducible runs/tests (YYYY-MM-DD). Defaults to the real date (US Eastern).
  today: e.TODAY || null,
};

export const isDemo = () => config.statsProvider === 'demo';
