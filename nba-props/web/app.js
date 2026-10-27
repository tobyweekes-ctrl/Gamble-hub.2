// Phase 1 data inspector: search -> player profile, absences, tonight's lines, raw game log.
// The full results view (model, chart, splits) replaces the body of renderPlayer in phase 3.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? '–' : Number(x).toFixed(d));

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const state = { stats: {}, stat: 'pts', player: null };

// ---------- status + slate ----------
async function loadStatus() {
  const s = await api('/api/health');
  const demo = s.statsProvider === 'demo';
  $('#status').innerHTML = `${demo ? '<span class="demo">DEMO DATA</span> ' : ''}stats <b>${esc(s.statsProvider)}</b> · odds <b>${esc(s.odds)}</b>${s.oddsQuota?.remaining != null ? ` (${s.oddsQuota.remaining} left)` : ''} · inj <b>${esc(s.injuryProvider)}</b> · <b>${esc(s.today)}</b>`;
}
async function loadSlate() {
  try {
    const games = await api('/api/slate');
    $('#slate').innerHTML = games.length
      ? games.map((g) => `<div class="g"><b>${g.away}</b> @ <b>${g.home}</b> ${g.tipoff ? new Date(g.tipoff).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : esc(g.status)}</div>`).join('')
      : '<div class="g">No games today</div>';
  } catch (e) {
    $('#slate').innerHTML = `<div class="g err">slate: ${esc(e.message)}</div>`;
  }
}

// ---------- search / autocomplete ----------
const input = $('#q');
const ac = $('#ac');
let results = [], sel = -1, timer;

function renderAc() {
  ac.hidden = !results.length;
  input.setAttribute('aria-expanded', String(!ac.hidden));
  ac.innerHTML = results.map((p, i) => `<li role="option" data-i="${i}" aria-selected="${i === sel}">
    <span>${esc(p.name)} <span class="meta">${p.team} · ${esc(p.pos)}</span></span>
    <span class="meta">${fmt(p.pts)} / ${fmt(p.reb)} / ${fmt(p.ast)} · ${fmt(p.min)}m</span></li>`).join('');
}
input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const q = input.value.trim();
    results = q.length < 2 ? [] : await api(`/api/players/search?q=${encodeURIComponent(q)}`).catch(() => []);
    sel = results.length ? 0 : -1;
    renderAc();
  }, 120);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { sel = Math.min(results.length - 1, sel + 1); renderAc(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); renderAc(); e.preventDefault(); }
  else if (e.key === 'Enter' && results[sel]) choose(results[sel]);
  else if (e.key === 'Escape') { results = []; renderAc(); input.blur(); }
});
ac.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (li) choose(results[Number(li.dataset.i)]);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); input.select(); }
});

function choose(p) {
  results = []; renderAc();
  input.value = p.name;
  input.blur();
  location.hash = `#/p/${p.id}/${state.stat}`;
}

// ---------- player view ----------
async function route() {
  const m = location.hash.match(/^#\/p\/([^/]+)(?:\/(\w+))?/);
  if (!m) { $('#view').innerHTML = '<p class="empty">Press / and search a player.</p>'; return; }
  state.stat = state.stats[m[2]] ? m[2] : 'pts';
  $('#view').innerHTML = '<p class="empty">Loading…</p>';
  try {
    const [d, lines] = await Promise.all([api(`/api/player/${m[1]}`), api(`/api/player/${m[1]}/lines?stat=${state.stat}`)]);
    state.player = d;
    renderPlayer(d, lines);
  } catch (e) {
    $('#view').innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

function flags(d) {
  const out = [];
  if (d.injury) out.push(`<span class="flag ${d.injury.status === 'Out' ? 'neg' : 'warn'}">${esc(d.injury.status)} · ${esc(d.injury.injury)}</span>`);
  const a = d.absence;
  if (a.status === 'returned') out.push(`<span class="flag warn">Back ${a.gamesSinceReturn}g after missing ${a.gamesMissed} · min ${a.minutesSinceReturn.join(', ')} (was ${fmt(a.minutesBefore)})</span>`);
  if (a.status === 'absent') out.push(`<span class="flag neg">Missed last ${a.gamesMissed} team games</span>`);
  if (d.game?.restDays === 0) out.push('<span class="flag warn">Back-to-back</span>');
  return out.join(' ');
}

function renderPlayer(d, lines) {
  const p = d.player, g = d.game;
  const statKeys = Object.keys(state.stats);
  const avgRows = Object.entries(d.averages).map(([k, a]) => `<tr><td>${k}</td><td>${a.gp}</td><td>${fmt(a.min)}</td><td>${fmt(a.usg)}</td>${statKeys.map((s) => `<td>${fmt(a[s])}</td>`).join('')}</tr>`).join('');
  const lineRows = lines.lines.map((l) => `<tr class="${l.bestOver || l.bestUnder ? 'best' : ''}"><td>${esc(l.bookTitle)}</td><td>${fmt(l.line)}</td><td>${fmt(l.over, 2)}</td><td>${fmt(l.under, 2)}</td><td>${l.bestOver ? 'best over' : ''}${l.bestOver && l.bestUnder ? ' · ' : ''}${l.bestUnder ? 'best under' : ''}</td></tr>`).join('');
  const cols = ['date', 'opp', 'min', 'usg', 'pts', 'reb', 'ast', 'fg3m', 'fga', 'fta', 'tov', 'pm'];
  const logRows = d.logs.map((r) => `<tr>${cols.map((c) => `<td>${c === 'opp' ? (r.home ? 'v ' : '@ ') + r.opp : c === 'min' || c === 'usg' ? fmt(r[c]) : esc(r[c])}</td>`).join('')}</tr>`).join('');

  $('#view').innerHTML = `
    <div class="ph">
      <h2>${esc(p.name)}</h2>
      <span class="sub">${p.team} · ${esc(p.pos) || '–'} · ${g ? `${g.home ? 'vs' : '@'} ${g.opp} tonight · rest ${g.restDays ?? '–'}d (opp ${g.oppRestDays ?? '–'}d)` : 'no game today'}</span>
      ${flags(d)}
    </div>
    <div class="chips" role="group" aria-label="Stat">${statKeys.map((s) => `<button aria-pressed="${s === state.stat}" data-s="${s}">${state.stats[s].short}</button>`).join('')}</div>
    <div class="block"><h3>Lines · ${state.stats[state.stat].label}${lines.source ? ` · ${esc(lines.source)}` : ''}</h3>
      ${lines.lines.length ? `<div class="scroll"><table><tr><th>Book</th><th>Line</th><th>Over</th><th>Under</th><th></th></tr>${lineRows}</table></div>` : `<p class="empty">${g ? 'No lines posted for this market.' : 'No game today.'}</p>`}
    </div>
    <div class="block"><h3>Averages</h3><div class="scroll"><table><tr><th>Split</th><th>GP</th><th>Min</th><th>Usg%</th>${statKeys.map((s) => `<th>${state.stats[s].short}</th>`).join('')}</tr>${avgRows}</table></div></div>
    <div class="block"><h3>Game log · last ${d.logs.length}</h3><div class="scroll"><table><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>${logRows}</table></div></div>`;
  $('.chips').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) location.hash = `#/p/${p.id}/${b.dataset.s}`;
  });
}

window.addEventListener('hashchange', route);
state.stats = await api('/api/stats');
loadStatus();
loadSlate();
route();
