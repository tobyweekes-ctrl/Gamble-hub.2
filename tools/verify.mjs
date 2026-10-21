#!/usr/bin/env node
// Checks index.html before it goes live.
//
// Usage: node tools/verify.mjs [--browser]
//
// 1. index.html and matchday-ledger.html are identical.
// 2. The inline script compiles.
// 3. It runs in a Node vm with a stubbed DOM and localStorage, and every fixture
//    in SEED_MATCHES passes basic data checks (unique ids, valid kickoff, 1X2 sums
//    to 100, two-way markets 0-100 or null, league listed in LEAGUE_ORDER).
// 4. With --browser, renders the page once in Chromium and fails on any page error.
//
// Prints a one-line summary per fixture: market 1X2, model 1X2 and the model basis.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const copy = readFileSync(path.join(root, 'matchday-ledger.html'), 'utf8');
const errors = [];
if (html !== copy) errors.push('matchday-ledger.html differs from index.html');

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length !== 1) throw new Error(`Expected one inline <script>, found ${scripts.length}`);
const code = scripts[0] + `
;globalThis.__out = { SEED_MATCHES, SEED_VERSION, LEAGUE_ORDER, MODEL_VERSION,
  computeModelProbs, predictionsLog: () => predictionsLog,
  SEED_RESULTS: typeof SEED_RESULTS !== 'undefined' ? SEED_RESULTS : null };`;

new vm.Script(code, { filename: 'index.html<script>' }); // syntax check

// A DOM stub that accepts any property access or call.
const stub = () => new Proxy(function () {}, {
  get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : stub(),
  set: () => true,
  apply: () => stub(),
});
const store = new Map();
const ctx = {
  console, Date, Math, JSON, Intl,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  document: stub(), window: stub(), navigator: stub(),
  setTimeout: () => 0, clearTimeout: () => {},
};
vm.createContext(ctx);
vm.runInContext(code, ctx, { filename: 'index.html<script>' });
const out = ctx.__out;

const ids = new Set();
const ok2 = v => v === null || (typeof v === 'number' && v >= 0 && v <= 100);
for (const m of out.SEED_MATCHES) {
  const tag = m.id || '(no id)';
  if (!m.id || ids.has(m.id)) errors.push(`${tag}: missing or duplicate id`);
  ids.add(m.id);
  if (!out.LEAGUE_ORDER.includes(m.league)) errors.push(`${tag}: league "${m.league}" not in LEAGUE_ORDER`);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(m.kickoff) || isNaN(Date.parse(m.kickoff))) {
    errors.push(`${tag}: bad kickoff ${m.kickoff}`);
  }
  const has1x2 = [m.hw, m.dw, m.aw].every(v => typeof v === 'number');
  if (has1x2 && Math.abs(m.hw + m.dw + m.aw - 100) > 0.01) errors.push(`${tag}: 1X2 sums to ${m.hw + m.dw + m.aw}`);
  if (!has1x2 && [m.hw, m.dw, m.aw].some(v => v != null)) errors.push(`${tag}: partial 1X2`);
  if (!ok2(m.btts ?? null) || !ok2(m.ou25 ?? null)) errors.push(`${tag}: BTTS/O2.5 out of range`);
  for (const s of ['H', 'A']) {
    if (m['lineupStatus' + s] === 'confirmed' && !m.lineupNote) errors.push(`${tag}: confirmed lineup without a note`);
  }
  const mp = out.computeModelProbs(m);
  const mk = has1x2 ? `${m.hw}/${m.dw}/${m.aw}` : 'no price';
  const md = mp ? `${mp.hw}/${mp.dw}/${mp.aw} (${mp.basis})` : 'no model';
  console.log(`${m.id.padEnd(6)} ${m.league.padEnd(17)} ${(m.home + ' v ' + m.away).padEnd(44)} market ${mk.padEnd(9)} model ${md}`);
}
const results = out.SEED_RESULTS || {};
for (const [id, r] of Object.entries(results)) {
  if (!Array.isArray(r) || r.length !== 2 || !r.every(Number.isInteger)) errors.push(`SEED_RESULTS ${id}: bad score`);
}
console.log(`\n${out.SEED_MATCHES.length} fixtures, ${Object.keys(results).length} seeded results, seed ${out.SEED_VERSION}, model ${out.MODEL_VERSION}`);
console.log(`Prediction log entries created on first load: ${out.predictionsLog().length}`);

if (process.argv.includes('--browser')) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { ({ chromium } = require(path.join(process.execPath, '../../lib/node_modules/playwright'))); }
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto('file://' + path.join(root, 'index.html'));
  await page.waitForTimeout(500);
  const rows = await page.evaluate(() => document.querySelectorAll('#leagues .league-body > *').length);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await page.screenshot({ path: path.join(process.env.VERIFY_SHOT_DIR || root, 'verify-shot.png') });
  await browser.close();
  pageErrors.forEach(e => errors.push('browser: ' + e));
  if (wide) errors.push('browser: page scrolls horizontally at phone width');
  console.log(`Browser render: ${rows} elements in league bodies, ${pageErrors.length} page errors`);
}

if (errors.length) {
  console.error('\nFAILED:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log('\nAll checks passed.');
