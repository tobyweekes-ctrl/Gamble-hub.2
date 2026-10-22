#!/usr/bin/env node
// Team shots for the cross-league shots model (cross.mjs): every match ESPN lists
// with team statistics, from season scoreboards (one request per competition and
// year), for European club competitions (qualifiers included) and the domestic
// leagues whose clubs play in them. ESPN uses one team id across competitions, so
// no name matching is needed between leagues.
// Writes data/raw/cross/espn-shots.json: [{ league, date, homeId, awayId, home, away, hg, ag, hs, as, hst, ast }]
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const ESPN_EUROPE = ['uefa.champions', 'uefa.europa', 'uefa.europa.conf', 'uefa.champions_qual', 'uefa.europa_qual', 'uefa.europa.conf_qual'];
export const ESPN_DOMESTIC = ['eng.1', 'eng.2', 'ger.1', 'ita.1', 'fra.1', 'esp.1', 'aut.1', 'den.1', 'nor.1', 'swe.1', 'rou.1', 'sui.1', 'gre.1', 'tur.1', 'por.1', 'ned.1', 'bel.1', 'sco.1'];
const get = url => new Promise(res => execFile('curl', ['-sSf', '--compressed', '-m', '90', url], { maxBuffer: 256e6 }, (e, out) => { try { res(e ? null : JSON.parse(out)); } catch { res(null); } }));
const stat = (c, n) => { const s = (c.statistics || []).find(x => x.name === n); return s ? Number(s.displayValue) : null; };
const jobs = [];
const now = new Date().getUTCFullYear();
for (const lg of [...ESPN_EUROPE, ...ESPN_DOMESTIC]) for (let y = 2021; y <= now; y++) jobs.push({ lg, y });
const out = [];
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < jobs.length) {
    const { lg, y } = jobs[i++];
    const d = await get(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${y}&limit=1000`);
    for (const e of d?.events || []) {
      const comp = e.competitions?.[0];
      if (!comp || !e.status?.type?.completed) continue;
      const h = comp.competitors.find(c => c.homeAway === 'home'), a = comp.competitors.find(c => c.homeAway === 'away');
      if (!h || !a) continue;
      out.push({ league: lg, id: e.id, date: e.date, homeId: h.team.id, awayId: a.team.id, home: h.team.displayName, away: a.team.displayName,
        hg: Number(h.score), ag: Number(a.score), hs: stat(h, 'totalShots'), as: stat(a, 'totalShots'), hst: stat(h, 'shotsOnTarget'), ast: stat(a, 'shotsOnTarget') });
    }
  }
}));
const seen = new Set();
const uniq = out.filter(m => !seen.has(m.id) && seen.add(m.id)).sort((a, b) => (a.date < b.date ? -1 : 1));
mkdirSync(path.join(root, 'data/raw/cross'), { recursive: true });
writeFileSync(path.join(root, 'data/raw/cross/espn-shots.json'), JSON.stringify(uniq));
const withShots = uniq.filter(m => m.hst != null && m.ast != null).length;
console.log(`${uniq.length} ESPN matches, ${withShots} with shots on target`);
