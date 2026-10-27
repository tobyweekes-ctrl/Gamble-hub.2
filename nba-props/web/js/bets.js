// Bet log: every bet you marked as taken, graded automatically from box scores.
import { esc, fmt, edge, api, state } from './ui.js';

export async function renderBets(view) {
  view.innerHTML = '<p class="empty">Loading…</p>';
  let log;
  try { log = await api('/api/bets'); } catch (e) { view.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const s = log.summary;
  const line = (x, label) => `<div><dt>${label}</dt><dd>${x.bets ? `${x.won}-${x.lost}${x.push ? `-${x.push}` : ''} · <span class="${x.profit > 0 ? 'pos' : x.profit < 0 ? 'neg' : ''}">${x.profit > 0 ? '+' : ''}${fmt(x.profit, 2)}</span> · ROI ${edge(x.roi)}` : '–'}</dd></div>`;
  const resCell = (b) => {
    const r = b.result;
    if (r.status === 'pending') return '<span class="dim">pending</span>';
    if (r.status === 'void') return `<span class="dim">void (${esc(r.reason)})</span>`;
    return `<span class="${r.betResult === 'win' ? 'pos' : r.betResult === 'loss' ? 'neg' : ''}">${r.betResult.toUpperCase()}</span> <span class="dim">${fmt(r.actual, 0)}</span>`;
  };
  view.innerHTML = `
    <div class="ph"><h2>Bet log</h2><span class="sub">${s.total} bets · ${s.pending} pending · ${s.void} void</span></div>
    <div class="verdict"><dl>
      ${line(s.settled, 'All settled')}
      ${line(s.withModel, 'With model')}
      ${line(s.againstModel, 'Against / no model pick')}
      <div><dt>Staked</dt><dd>${fmt(s.settled.staked, 2)}</dd></div>
    </dl></div>
    ${log.bets.length ? `<div class="scroll"><table class="lines">
      <tr><th>Date</th><th class="l">Player</th><th>Stat</th><th>Bet</th><th>Price</th><th>Stake</th><th>Book</th><th>Model then</th><th>Result</th><th>P/L</th><th></th></tr>
      ${log.bets.map((b) => `<tr>
        <td>${b.date}</td><td class="l"><a href="#/p/${esc(b.playerId)}/${esc(b.stat)}">${esc(b.playerName)}</a> <span class="dim">${b.team} ${b.home ? 'v' : '@'} ${b.opp}</span></td>
        <td>${state.stats[b.stat]?.short || b.stat}</td><td>${b.bet.side === 'over' ? 'o' : 'u'}${fmt(b.line)}</td><td>${fmt(b.bet.price, 2)}</td><td>${fmt(b.bet.stake, 2)}</td>
        <td>${esc(b.book)}${b.source === 'manual' ? ' <span class="tag">MANUAL</span>' : ''}</td>
        <td>${b.model ? `${esc(b.model.verdict)} ${edge(b.bet.side === 'over' ? b.model.edgeOver : b.model.edgeUnder)}` : '–'}</td>
        <td>${resCell(b)}</td>
        <td>${b.result.profit != null ? `<span class="${b.result.profit > 0 ? 'pos' : b.result.profit < 0 ? 'neg' : ''}">${b.result.profit > 0 ? '+' : ''}${fmt(b.result.profit, 2)}</span>` : '–'}</td>
        <td class="actions"><button class="mini ghost" data-untake="${esc(b.id)}" title="Remove from bet log (keeps the line)">Untake</button></td>
      </tr>`).join('')}
    </table></div>` : '<p class="empty">No bets yet. Open a player and press Take on a line, or add your bookie\'s line and use Save + bet.</p>'}
    <p class="hint">Edge shown is the model's edge on your side when you logged it. Bets settle from box scores once the game date has passed; a DNP is void.</p>`;
  view.onclick = async (e) => {
    const u = e.target.closest('[data-untake]');
    if (!u) return;
    u.disabled = true;
    await api(`/api/entries/${u.dataset.untake}`, { method: 'PATCH', body: { bet: null } });
    renderBets(view);
  };
}
