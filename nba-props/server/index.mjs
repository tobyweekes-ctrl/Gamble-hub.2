// HTTP server: JSON API under /api, static frontend from /web. No framework, no dependencies.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { config, ROOT } from './env.mjs';
import { cacheInfo } from './cache.mjs';
import { STATS } from './stats.mjs';
import { round } from './util.mjs';
import {
  getLeague, searchPlayers, averages, getSlate, gameFor, getInjuries, injuryFor, getPlayerLines, status, today,
} from './data/store.mjs';

const WEB = join(ROOT, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const routes = [];
const get = (pattern, handler) => routes.push({ re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

get('/api/health', async () => ({ ok: true, ...status(), cache: cacheInfo() }));

get('/api/stats', async () => STATS);

get('/api/players/search', async (_p, q) => {
  const L = await getLeague();
  return searchPlayers(L, q.get('q') || '', Number(q.get('limit') || 10));
});

get('/api/slate', async (_p, q) => getSlate(q.get('date') || today()));

get('/api/injuries', async () => getInjuries());

get('/api/teams', async () => {
  const L = await getLeague();
  const cur = L.bySeason[L.current], prev = L.bySeason[L.previous];
  return {
    current: L.current, previous: L.previous,
    league: { [L.current]: cur.summary.league, [L.previous]: prev.summary.league },
    teams: Object.fromEntries(Object.keys(prev.summary.teams).concat(Object.keys(cur.summary.teams)).map((t) => [t, {
      [L.current]: cur.summary.teams[t] || null,
      [L.previous]: prev.summary.teams[t] || null,
      posDef: { [L.current]: cur.posDef[t] || null, [L.previous]: prev.posDef[t] || null },
    }])),
  };
});

get('/api/player/:id', async ({ id }) => {
  const L = await getLeague();
  const p = L.players.get(id);
  if (!p) throw Object.assign(new Error('player not found'), { status: 404 });
  const logs = L.playerLogs(id);
  const cur = logs.filter((r) => r.season === L.current);
  const prev = logs.filter((r) => r.season === L.previous);
  const [game, injuries] = await Promise.all([gameFor(p.team), getInjuries().catch(() => [])]);
  const opp = game ? (game.home === p.team ? game.away : game.home) : null;
  return {
    player: { ...p },
    game: game && { ...game, opp, home: game.home === p.team, restDays: L.restDays(p.team, L.today), oppRestDays: L.restDays(opp, L.today) },
    injury: injuryFor(injuries, p),
    absence: L.absence(id),
    averages: {
      [L.current]: averages(cur),
      [L.previous]: averages(prev),
      last5: averages(logs.slice(-5)),
      last10: averages(logs.slice(-10)),
    },
    logs: logs.slice(-40).reverse().map((r) => ({ ...r, usg: round(r.usg) })),
  };
});

get('/api/player/:id/lines', async ({ id }, q) => {
  const L = await getLeague();
  const p = L.players.get(id);
  if (!p) throw Object.assign(new Error('player not found'), { status: 404 });
  const stat = q.get('stat') || 'pts';
  if (!STATS[stat]) throw Object.assign(new Error(`unknown stat ${stat}`), { status: 400 });
  return getPlayerLines(p, stat);
});

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB, rel);
  if (!file.startsWith(WEB)) return false;
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const route = routes.find((r) => r.re.test(url.pathname));
    if (!route) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"not found"}'); }
    const t0 = Date.now();
    try {
      const params = Object.fromEntries(Object.entries(url.pathname.match(route.re).groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      const data = await route.handler(params, url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Server-Timing': `app;dur=${Date.now() - t0}` });
      res.end(JSON.stringify(data));
    } catch (err) {
      const code = err.status || 502;
      if (code >= 500) console.error(`[api] ${url.pathname}:`, err.message);
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  if (!(await serveStatic(url.pathname, res))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(config.port, () => {
  const s = status();
  console.log(`nba-props on http://localhost:${config.port}  stats=${s.statsProvider} odds=${s.odds} injuries=${s.injuryProvider} today=${s.today}`);
  // warm the league in the background so the first search is instant
  getLeague().then((L) => console.log(`league ready: ${L.players.size} players, ${L.bySeason[L.current].rows.length + L.bySeason[L.previous].rows.length} box scores`))
    .catch((e) => console.error('league load failed:', e.message));
});
