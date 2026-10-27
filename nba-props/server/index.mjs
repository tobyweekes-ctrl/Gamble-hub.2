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
import { listEntries, addEntry, updateEntry, deleteEntry, betLog, grade } from './data/userdata.mjs';
import { analyse } from './model/index.mjs';
import { parsePrice } from './model/odds.mjs';

const WEB = join(ROOT, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const routes = [];
const route = (method) => (pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });
const get = route('GET'), post = route('POST'), patch = route('PATCH'), del = route('DELETE');
const fail = (status, msg) => { throw Object.assign(new Error(msg), { status }); };

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

// ---------- model ----------
async function playerAndGame(id) {
  const L = await getLeague();
  const p = L.players.get(id) || fail(404, 'player not found');
  const g = await gameFor(p.team);
  const game = g && { date: L.today, gameId: g.gameId, team: p.team, opp: g.home === p.team ? g.away : g.home, home: g.home === p.team, tipoff: g.tipoff };
  return { L, p, game };
}

/** Run the model on every line we have for this player + stat: books, saved manual lines, a preview line. */
async function runAnalysis(id, stat, { preview = null, minutesOverride = null } = {}) {
  if (!STATS[stat]) fail(400, `unknown stat ${stat}`);
  const { L, p, game } = await playerAndGame(id);
  if (!game) return { player: p, game: null, analysis: null };
  const [feed, injuries] = await Promise.all([getPlayerLines(p, stat), getInjuries().catch(() => [])]);
  const manual = listEntries().filter((e) => e.source === 'manual' && e.playerId === id && e.stat === stat && e.date === L.today);
  const lines = [
    ...feed.lines.map((l) => ({ ...l, id: `api:${l.book}:${l.line}`, source: feed.source })),
    ...manual.map((e) => ({ id: e.id, book: e.book, bookTitle: e.book, line: e.line, over: e.over, under: e.under, source: 'manual' })),
    ...(preview ? [{ ...preview, id: 'preview', bookTitle: preview.book || 'Preview', source: 'preview' }] : []),
  ];
  const analysis = analyse({ L, playerId: id, game, stat, lines, opts: { injuries, spread: feed.spread, minutesOverride } });
  return { player: p, game: { ...game, spread: feed.spread }, linesSource: feed.source, oddsAgeSec: feed.cacheAgeSec, analysis, manual };
}

get('/api/player/:id/analysis', async ({ id }, q) => {
  const num = (k) => (q.get(k) != null && q.get(k) !== '' ? Number(q.get(k)) : null);
  const preview = num('line') != null ? { line: num('line'), over: q.get('over'), under: q.get('under'), book: q.get('book') || 'Preview' } : null;
  return runAnalysis(id, q.get('stat') || 'pts', { preview, minutesOverride: num('min') });
});

// ---------- manual lines + bet log ----------
function validBet(bet, over, under) {
  if (!bet) return null;
  if (!['over', 'under'].includes(bet.side)) fail(400, 'bet.side must be over or under');
  const price = parsePrice(bet.price ?? (bet.side === 'over' ? over : under)) || fail(400, 'bet needs a price');
  const stake = Number(bet.stake ?? 1);
  if (!(stake > 0)) fail(400, 'stake must be positive');
  return { side: bet.side, stake, price, takenAt: new Date().toISOString() };
}

post('/api/entries', async (_p, _q, body) => {
  const { playerId, stat, book, source = 'manual' } = body;
  const line = Number(body.line);
  if (!STATS[stat]) fail(400, `unknown stat ${stat}`);
  if (!Number.isFinite(line) || line < 0) fail(400, 'line must be a number');
  const over = parsePrice(body.over), under = parsePrice(body.under);
  if (!over && !under) fail(400, 'enter at least one price (decimal 1.91, fractional 10/11 or American -110)');
  if (!book || !String(book).trim()) fail(400, 'bookie name required');
  const { p, game } = await playerAndGame(playerId);
  if (!game) fail(400, `${p.name} has no game today`);
  const res = await runAnalysis(playerId, stat, { preview: { line, over, under, book } });
  const e = res.analysis?.evals.find((x) => x.id === 'preview');
  return addEntry({
    source: source === 'api' ? 'api' : 'manual',
    date: game.date, gameId: game.gameId, playerId, playerName: p.name, team: p.team, opp: game.opp, home: game.home,
    stat, line, over, under, book: String(book).trim().slice(0, 40),
    model: e && {
      pOver: e.model.over, pUnder: e.model.under, edgeOver: e.edge.over, edgeUnder: e.edge.under,
      evOver: e.ev.over, evUnder: e.ev.under, verdict: e.verdict, confidence: e.confidence,
      mean: res.analysis.projection.mean, minutes: res.analysis.projection.minutes.proj,
    },
    bet: validBet(body.bet, over, under),
  });
});

patch('/api/entries/:id', async ({ id }, _q, body) => {
  const e = listEntries().find((x) => x.id === id) || fail(404, 'entry not found');
  const out = updateEntry(id, { bet: body.bet === null ? null : validBet(body.bet, e.over, e.under) });
  return out;
});

del('/api/entries/:id', async ({ id }) => ({ deleted: deleteEntry(id) }));

get('/api/entries', async (_p, q) => {
  const L = await getLeague();
  return listEntries()
    .filter((e) => (!q.get('date') || e.date === q.get('date')) && (!q.get('playerId') || e.playerId === q.get('playerId')) && (!q.get('stat') || e.stat === q.get('stat')))
    .map((e) => ({ ...e, result: grade(L, e) }));
});

get('/api/bets', async () => betLog(await getLeague()));

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e5) fail(413, 'body too large');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { fail(400, 'invalid JSON'); }
}

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
    const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"not found"}'); }
    const t0 = Date.now();
    try {
      const params = Object.fromEntries(Object.entries(url.pathname.match(route.re).groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      const data = await route.handler(params, url.searchParams, await readBody(req));
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
