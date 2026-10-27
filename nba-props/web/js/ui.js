// Shared helpers and state for the frontend.
export const state = { stats: {} };
/** ask the shell to refresh the status bar (e.g. after a call that may spend Odds API credits) */
export const refreshStatus = () => window.dispatchEvent(new Event('status:refresh'));
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = (x, d = 1) => (x == null || Number.isNaN(Number(x)) ? '–' : Number(x).toFixed(d));
export const pct = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
/** signed percentage with pos/neg colouring */
export const edge = (x, d = 1) => (x == null ? '<span class="dim">–</span>' : `<span class="${x > 0 ? 'pos' : x < 0 ? 'neg' : ''}">${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%</span>`);
export const signed = (x, d = 1) => (x == null ? '–' : `${x > 0 ? '+' : ''}${Number(x).toFixed(d)}`);

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
