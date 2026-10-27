// Player page (phase 2 layout): verdict, per-book model table, manual line entry, minutes,
// adjustments, hit rates, averages, game log. Phase 3 replaces the layout and adds the chart.
import { $, $$, esc, fmt, pct, edge, signed, api, debounce, state, refreshStatus } from './ui.js';

const S = { id: null, stat: 'pts', profile: null, res: null, minutes: null, preview: null };

const FLAG_LABEL = { returning: 'Return ramp', 'first-game-back': 'First game back', 'no-history': 'No history', 'manual-minutes': 'Manual minutes' };

export async function renderPlayer(view, id, stat) {
  if (S.id !== id) { S.minutes = null; S.preview = null; }
  S.id = id; S.stat = stat;
  view.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const [profile, res] = await Promise.all([api(`/api/player/${id}`), fetchAnalysis()]);
    S.profile = profile; S.res = res;
    view.innerHTML = shell(profile);
    bindShell(view);
    renderModel();
    refreshStatus();
  } catch (e) {
    view.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

function fetchAnalysis() {
  const q = new URLSearchParams({ stat: S.stat });
  if (S.minutes != null) q.set('min', S.minutes);
  if (S.preview) for (const k of ['line', 'over', 'under', 'book']) if (S.preview[k] !== '' && S.preview[k] != null) q.set(k, S.preview[k]);
  return api(`/api/player/${S.id}/analysis?${q}`);
}

async function rerun() {
  try {
    S.res = await fetchAnalysis();
    renderModel();
  } catch (e) {
    $('#model').innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

// ---------- static parts ----------
function flags(d) {
  const out = [];
  if (d.injury) out.push(`<span class="flag ${d.injury.status === 'Out' ? 'neg' : 'warn'}">${esc(d.injury.status)} · ${esc(d.injury.injury)}</span>`);
  const a = d.absence;
  if (a.status === 'returned') out.push(`<span class="flag warn">Back ${a.gamesSinceReturn}g after missing ${a.gamesMissed}</span>`);
  if (a.status === 'absent') out.push(`<span class="flag neg">Missed last ${a.gamesMissed} team games</span>`);
  if (d.game?.restDays === 0) out.push('<span class="flag warn">Back-to-back</span>');
  return out.join(' ');
}

function shell(d) {
  const p = d.player, g = d.game;
  const keys = Object.keys(state.stats);
  const avgRows = Object.entries(d.averages).map(([k, a]) => `<tr><td>${k}</td><td>${a.gp}</td><td>${fmt(a.min)}</td><td>${fmt(a.usg)}</td>${keys.map((s) => `<td>${fmt(a[s])}</td>`).join('')}</tr>`).join('');
  const cols = ['date', 'opp', 'min', 'usg', 'pts', 'reb', 'ast', 'fg3m', 'fga', 'fta', 'tov', 'pm'];
  const logRows = d.logs.map((r) => `<tr>${cols.map((c) => `<td>${c === 'opp' ? (r.home ? 'v ' : '@ ') + r.opp : c === 'min' || c === 'usg' ? fmt(r[c]) : esc(r[c])}</td>`).join('')}</tr>`).join('');
  return `
    <div class="ph">
      <h2>${esc(p.name)}</h2>
      <span class="sub">${p.team} · ${esc(p.pos) || '–'} · ${g ? `${g.home ? 'vs' : '@'} ${g.opp} tonight · rest ${g.restDays ?? '–'}d (opp ${g.oppRestDays ?? '–'}d)` : 'no game today'}</span>
      ${flags(d)}
    </div>
    <div class="chips" role="group" aria-label="Stat">${keys.map((s) => `<button aria-pressed="${s === S.stat}" data-s="${s}">${state.stats[s].short}</button>`).join('')}</div>
    <div id="model"></div>
    <div class="block"><h3>Averages</h3><div class="scroll"><table><tr><th>Split</th><th>GP</th><th>Min</th><th>Usg%</th>${keys.map((s) => `<th>${state.stats[s].short}</th>`).join('')}</tr>${avgRows}</table></div></div>
    <div class="block"><h3>Game log · last ${d.logs.length}</h3><div class="scroll"><table><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>${logRows}</table></div></div>`;
}

function bindShell(view) {
  $('.chips', view).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) location.hash = `#/p/${S.id}/${b.dataset.s}`;
  });
}

// ---------- model ----------
function renderModel() {
  const el = $('#model');
  const res = S.res;
  if (!res.game) { el.innerHTML = '<p class="empty">No game today, so there is nothing to price.</p>'; return; }
  const a = res.analysis;
  if (a.error) { el.innerHTML = `<p class="empty">${esc(a.error)}</p>`; return; }
  const label = state.stats[S.stat].label;
  el.innerHTML = `
    ${verdictStrip(a)}
    <div class="block"><h3>Lines · ${esc(label)}${res.linesSource ? ` · ${esc(res.linesSource)}` : ''}${res.oddsAgeSec != null ? ` · ${Math.round(res.oddsAgeSec / 60)}m old` : ''}</h3>
      ${linesTable(a)}
    </div>
    ${manualForm(a)}
    <div class="grid2">
      ${minutesBlock(a)}
      ${factorsBlock(a)}
    </div>
    ${hitBlock(a)}`;
  bindModel(el);
}

function verdictStrip(a) {
  const h = a.headline;
  const p = a.projection;
  const side = h?.side;
  const price = side ? (side === 'over' ? h.over : h.under) : null;
  const cls = side ? 'pos' : 'dim';
  return `<div class="verdict">
    <div class="v-main"><span class="v-word ${cls}">${h ? h.verdict : '–'}</span>${h?.confidence ? `<span class="v-conf">${h.confidence}</span>` : ''}</div>
    <dl>
      ${h ? `<div><dt>${side ? 'Best bet' : 'Closest'}</dt><dd>${esc(h.bookTitle)} ${side ? side[0] : (h.leanSide || 'o')[0]}${fmt(h.line)}${price ? ` @ ${fmt(price, 2)}` : ''}</dd></div>
      <div><dt>Edge</dt><dd>${edge(h.leanEdge)}</dd></div>
      <div><dt>EV</dt><dd>${edge(side ? h.ev[side] : h.leanSide ? h.ev[h.leanSide] : null)}</dd></div>
      <div><dt>Model O / U</dt><dd>${pct(h.model.over)} / ${pct(h.model.under)}</dd></div>` : '<div><dt>Lines</dt><dd>none posted; add one below</dd></div>'}
      <div><dt>Projection</dt><dd>${fmt(p.mean)} <span class="dim">±${fmt(p.sd)}</span></dd></div>
      <div><dt>Model line</dt><dd>${fmt(p.modelLine)}</dd></div>
      <div><dt>Minutes</dt><dd>${fmt(p.minutes.proj)} <span class="dim">±${fmt(p.minutes.sd)}</span></dd></div>
    </dl>
    <p class="v-notes">Threshold ${pct(a.config.threshold, 0)} edge vs no-vig · ${esc(p.family)}${p.dispersion > 0.005 ? ` (1/k ${fmt(p.dispersion, 3)})` : ''} · data quality ${Math.round(a.quality.score * 100)}%${a.quality.notes.length ? `: ${a.quality.notes.map(esc).join('; ')}` : ''}${a.consensus ? ` · market ${pct(a.consensus.over)} over ${fmt(a.consensus.line)} (${a.consensus.books} books)` : ''}</p>
  </div>`;
}

function lineRow(e) {
  const evBest = e.leanSide ? e.ev[e.leanSide] : null;
  const tag = e.source === 'manual' ? '<span class="tag">MANUAL</span>' : e.source === 'preview' ? '<span class="tag">PREVIEW</span>' : '';
  const actions = e.source === 'preview' ? '' : `<button class="mini" data-take="${esc(e.id)}">Take</button>${e.source === 'manual' ? `<button class="mini ghost" data-del="${esc(e.id)}" title="Delete line">×</button>` : ''}`;
  return `<tr class="${e.side ? 'rec' : ''}" data-row="${esc(e.id)}">
    <td>${esc(e.bookTitle)} ${tag}</td><td>${fmt(e.line)}</td>
    <td class="${e.bestOver ? 'best' : ''}">${fmt(e.over, 2)}</td><td class="${e.bestUnder ? 'best' : ''}">${fmt(e.under, 2)}</td>
    <td>${pct(e.fair?.over)}${e.fair?.estimated ? '<span class="dim">*</span>' : ''}</td><td>${pct(e.model.over)}</td>
    <td>${edge(e.edge.over)}</td><td>${edge(e.edge.under)}</td><td>${edge(evBest)}</td>
    <td class="verdict-cell ${e.side ? 'pos' : 'dim'}">${e.verdict}${e.confidence ? ` <span class="dim">${e.confidence[0]}</span>` : ''}</td>
    <td class="actions">${actions}</td></tr>`;
}

function linesTable(a) {
  const evals = a.evals.filter((e) => e.source !== 'preview');
  if (!evals.length) return '<p class="empty">No lines for this market. Add your bookie\'s line below.</p>';
  return `<div class="scroll"><table class="lines">
    <tr><th>Book</th><th>Line</th><th>Over</th><th>Under</th><th>No-vig O</th><th>Model O</th><th>Edge O</th><th>Edge U</th><th>EV</th><th>Verdict</th><th></th></tr>
    ${evals.map(lineRow).join('')}
  </table></div><p class="hint">Edge = model probability − bookmaker's no-vig probability. EV per 1 unit at the offered price. <span class="best-key">Best price</span> highlighted.${evals.some((e) => e.fair?.estimated) ? ' * one price only: margin assumed.' : ''}</p>`;
}

function manualForm(a) {
  const p = S.preview || {};
  const prev = a.evals.find((e) => e.source === 'preview');
  return `<div class="block"><h3>Add a line · any bookie</h3>
    <form id="manual" class="manual" autocomplete="off">
      <label>Bookie<input name="book" required maxlength="40" placeholder="Bet365" value="${esc(p.book || '')}"></label>
      <label>Line<input name="line" required inputmode="decimal" placeholder="22.5" value="${esc(p.line ?? '')}"></label>
      <label>Over<input name="over" placeholder="10/11" value="${esc(p.over || '')}"></label>
      <label>Under<input name="under" placeholder="5/6" value="${esc(p.under || '')}"></label>
      <div class="manual-actions">
        <button type="submit" class="btn">Save line</button>
        <span class="betbox"><select name="side" aria-label="Side"><option value="">Bet side</option><option value="over">Over</option><option value="under">Under</option></select><input name="stake" inputmode="decimal" placeholder="Stake" aria-label="Stake"><button type="button" class="btn" id="save-bet">Save + bet</button></span>
      </div>
    </form>
    <p class="hint">Prices as fractional (10/11), decimal (1.91) or American (-110). One side is enough; the margin is then assumed. Lines are saved on the server and feed the bet log and real-line backtest.</p>
    ${prev ? `<div class="scroll"><table class="lines"><tr><th>Preview</th><th>Line</th><th>Over</th><th>Under</th><th>No-vig O</th><th>Model O</th><th>Edge O</th><th>Edge U</th><th>EV</th><th>Verdict</th><th></th></tr>${lineRow(prev)}</table></div>` : ''}
    <p id="manual-msg" class="hint"></p>
  </div>`;
}

function minutesBlock(a) {
  const m = a.projection.minutes;
  return `<div class="block"><h3>Minutes · ${fmt(m.proj)} ±${fmt(m.sd)}${m.flags.length ? ` · ${m.flags.map((f) => FLAG_LABEL[f] || f).join(', ')}` : ''}</h3>
    <div class="scroll"><table><tr><th>Step</th><th>Min</th><th>Why</th></tr>
    ${m.steps.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.key === 'base' ? fmt(s.value) : signed(s.value)}</td><td class="why">${esc(s.note || '')}</td></tr>`).join('')}
    </table></div>
    <form id="minform" class="inline"><label>Your minutes<input name="min" inputmode="decimal" placeholder="${fmt(m.proj)}" value="${S.minutes ?? ''}"></label><button class="btn">Apply</button>${S.minutes != null ? '<button type="button" class="btn ghost" id="minreset">Reset</button>' : ''}</form>
  </div>`;
}

function factorsBlock(a) {
  const p = a.projection;
  return `<div class="block"><h3>Rate · per 36 ${fmt(p.basePer36)} → ${fmt(p.per36)}</h3>
    <div class="scroll"><table><tr><th>Adjustment</th><th>×</th><th>Note</th></tr>
    <tr><td>Season blend</td><td>–</td><td class="why">${Math.round(p.seasonWeight * 100)}% this season, rest last season; recent form on top</td></tr>
    ${p.factors.map((f) => `<tr><td>${esc(f.label)}</td><td>${edge(f.value - 1)}</td><td class="why">${esc(f.note || '')}</td></tr>`).join('')}
    </table></div></div>`;
}

function hitBlock(a) {
  const h = a.hitRates;
  const row = (k, label) => {
    const x = h[k];
    return `<tr><td>${label}</td><td>${x.n}</td><td>${x.over}-${x.under}${x.push ? `-${x.push}` : ''}</td><td>${x.n ? pct(x.rate, 0) : '–'}</td><td>${fmt(x.avg)}</td></tr>`;
  };
  return `<div class="block"><h3>Hit rate vs ${fmt(h.line)}</h3>
    <div class="scroll"><table class="narrow"><tr><th>Window</th><th>GP</th><th>O-U</th><th>Over %</th><th>Avg</th></tr>
    ${row('last5', 'Last 5')}${row('last10', 'Last 10')}${row('last20', 'Last 20')}${row('season', 'This season')}${row('lastSeason', 'Last season')}
    </table></div></div>`;
}

// ---------- interactions ----------
function bindModel(el) {
  const form = $('#manual', el);
  const readForm = () => Object.fromEntries(new FormData(form));
  const preview = debounce(() => {
    const f = readForm();
    S.preview = f.line !== '' && (f.over || f.under) ? { line: f.line, over: f.over, under: f.under, book: f.book || 'Preview' } : null;
    rerun().then(() => {
      // restore focus after re-render
      const again = $('#manual');
      const name = document.activeElement?.name || lastFocus;
      if (again && name) { const i = again.elements[name]; if (i) { i.focus(); i.setSelectionRange?.(i.value.length, i.value.length); } }
    });
  }, 400);
  let lastFocus = null;
  form.addEventListener('input', (e) => { lastFocus = e.target.name; if (e.target.name !== 'side' && e.target.name !== 'stake') preview(); });

  async function save(withBet) {
    const f = readForm();
    const body = { playerId: S.id, stat: S.stat, line: f.line, over: f.over, under: f.under, book: f.book, source: 'manual' };
    if (withBet) {
      if (!f.side) return msg('Pick a side for the bet.', true);
      body.bet = { side: f.side, stake: f.stake || 1 };
    }
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await api('/api/entries', { method: 'POST', body });
      S.preview = null;
      await rerun();
      msg(withBet ? 'Line saved and bet logged.' : 'Line saved.');
    } catch (e) {
      buttons.forEach((b) => { b.disabled = false; });
      msg(e.message, true);
    }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); save(false); });
  $('#save-bet', el).addEventListener('click', () => save(true));

  $('#minform', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const v = new FormData(e.target).get('min');
    S.minutes = v === '' ? null : Number(v);
    rerun();
  });
  $('#minreset', el)?.addEventListener('click', () => { S.minutes = null; rerun(); });

  // onclick (not addEventListener): #model survives re-renders, so this must replace, not stack
  el.onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      await api(`/api/entries/${del.dataset.del}`, { method: 'DELETE' });
      return rerun();
    }
    const take = e.target.closest('[data-take]');
    if (take) openTake(take.dataset.take);
    const ok = e.target.closest('[data-confirm]');
    if (ok) { ok.disabled = true; confirmTake(ok.dataset.confirm, ok.closest('tr')); }
    if (e.target.closest('[data-cancel]')) e.target.closest('tr').remove();
  };
}

function msg(text, bad = false) {
  const m = $('#manual-msg');
  if (m) { m.textContent = text; m.className = `hint ${bad ? 'neg' : 'pos'}`; }
}

function openTake(id) {
  $$('.take-row').forEach((r) => r.remove());
  const e = S.res.analysis.evals.find((x) => x.id === id);
  const tr = $(`tr[data-row="${CSS.escape(id)}"]`);
  if (!e || !tr) return;
  const side = e.side || e.leanSide || 'over';
  const row = document.createElement('tr');
  row.className = 'take-row';
  row.innerHTML = `<td colspan="11"><span class="take">
    Bet <select name="side"><option value="over" ${side === 'over' ? 'selected' : ''}>Over ${fmt(e.line)} @ ${fmt(e.over, 2)}</option><option value="under" ${side === 'under' ? 'selected' : ''}>Under ${fmt(e.line)} @ ${fmt(e.under, 2)}</option></select>
    stake <input name="stake" inputmode="decimal" value="1" size="5">
    <button class="mini" data-confirm="${esc(id)}">Log bet</button><button class="mini ghost" data-cancel>Cancel</button></span></td>`;
  tr.after(row);
  $('input', row).focus();
}

async function confirmTake(id, row) {
  const e = S.res.analysis.evals.find((x) => x.id === id);
  const side = $('select', row).value;
  const stake = Number($('input', row).value) || 1;
  try {
    if (e.source === 'manual') {
      await api(`/api/entries/${id}`, { method: 'PATCH', body: { bet: { side, stake } } });
    } else {
      await api('/api/entries', { method: 'POST', body: { playerId: S.id, stat: S.stat, line: e.line, over: e.over, under: e.under, book: e.bookTitle, source: 'api', bet: { side, stake } } });
    }
    row.innerHTML = `<td colspan="11" class="pos">Bet logged: ${side} ${fmt(e.line)} @ ${fmt(side === 'over' ? e.over : e.under, 2)}, stake ${stake}. <a href="#/bets">Bet log</a></td>`;
  } catch (err) {
    row.innerHTML = `<td colspan="11" class="neg">${esc(err.message)}</td>`;
  }
}
