#!/usr/bin/env node
// Adds ledger entries (data/ledger.json) for fixtures that the site published but
// the ledger did not record, taken from the version of index.html in a given git
// commit. Only fixtures that had NOT kicked off when that commit was made are
// taken, and the entry is stamped with the commit time, so nothing is logged after
// the fact. Used once for the 22 Oct 2026 European ties, which were published
// before the ledger logged games without bookmaker prices.
//
// Usage: node tools/ledger-from-history.mjs <commit> [league regex]
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from './lib/app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [sha, leagueRe = '.'] = process.argv.slice(2);
const at = execFileSync('git', ['show', '-s', '--format=%cI', sha], { cwd: root, encoding: 'utf8' }).trim();
const html = execFileSync('git', ['show', `${sha}:index.html`], { cwd: root, encoding: 'utf8', maxBuffer: 64e6 });
const app = loadApp(html);
const ledgerPath = path.join(root, 'data/ledger.json');
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const pct = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +(+v).toFixed(1)]));
let added = 0;
for (const m of app.SEED_MATCHES) {
  if (!new RegExp(leagueRe).test(m.league) || !m.model || Date.parse(m.kickoff) <= Date.parse(at)) continue;
  if (ledger.some(e => e.id === m.id && e.modelVersion === app.MODEL_VERSION)) continue;
  ledger.push({
    id: m.id, league: m.league, fixture: `${m.home} vs ${m.away}`, kickoff: m.kickoff,
    loggedAt: new Date(at).toISOString(), modelVersion: app.MODEL_VERSION, seedVersion: app.SEED_VERSION, fromCommit: sha,
    market: { h: m.hw, d: m.dw, a: m.aw }, btts: m.btts, ou25: m.ou25,
    goalModel: pct({ h: m.model.hw, d: m.model.dw, a: m.model.aw }),
    modelMarkets: { btts: m.model.btts, ou25: m.model.ou25, expH: m.model.expH, expA: m.model.expA },
    confidence: m.model.confidence ? m.model.confidence.level : null,
    blend: null, modelBasis: 'independent', prices: m.prices || null, inputs: null, result: null,
  });
  added++;
}
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1) + '\n');
console.log(`${added} entries from ${sha.slice(0, 7)} (${at})`);
