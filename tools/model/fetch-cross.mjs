#!/usr/bin/env node
// Data for the cross-league model (tools/model/cross.mjs), used for Europa League and
// Conference League fixtures, whose clubs come from all over Europe:
//   - football-data.co.uk league results for Scotland, Belgium, the Netherlands,
//     Portugal, Turkey, Greece and Spain (main files), and Austria, Denmark, Norway,
//     Sweden, Poland, Romania, Switzerland, Finland and Ireland ("new" files)
//   - every Champions League, Europa League and Conference League result since 2021
//     (UEFA match data, qualifiers included), which link the leagues together.
// Writes data/raw/cross/.
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'data/raw/cross');
mkdirSync(dir, { recursive: true });
const curl = (url, out) => execFileSync('curl', ['-sSfL', '--compressed', '-m', '90', ...(out ? ['-o', out] : []), url], { encoding: 'utf8', maxBuffer: 128e6 });

export const MAIN = ['SC0', 'SC1', 'B1', 'N1', 'P1', 'T1', 'G1', 'SP1', 'SP2'];
export const NEW = ['AUT', 'DNK', 'NOR', 'SWE', 'POL', 'ROU', 'SWZ', 'FIN', 'IRL'];
const SEASONS = ['2122', '2223', '2324', '2425', '2526', '2627'];
for (const s of SEASONS) for (const d of MAIN) {
  try { curl(`https://www.football-data.co.uk/mmz4281/${s}/${d}.csv`, path.join(dir, `${d}-${s}.csv`)); } catch { console.log(`missing ${d} ${s}`); }
}
for (const c of NEW) {
  try { curl(`https://www.football-data.co.uk/new/${c}.csv`, path.join(dir, `${c}.csv`)); } catch { console.log(`missing ${c}`); }
}
const COMPS = { 1: 'Champions League', 14: 'Europa League', 2019: 'Conference League' };
const out = [];
const now = new Date();
for (const [id, comp] of Object.entries(COMPS)) {
  for (let y = 2021; y <= now.getUTCFullYear(); y++) {
    for (const [from, to] of [[`${y}-01-01`, `${y}-06-30`], [`${y}-07-01`, `${y}-12-31`]]) {
      for (let offset = 0; ; offset += 100) {
        const page = JSON.parse(curl(`https://match.uefa.com/v5/matches?competitionId=${id}&fromDate=${from}&toDate=${to}&limit=100&offset=${offset}&order=ASC`));
        for (const m of page) {
          const s = m.score?.total, reg = m.score?.regular;
          out.push({
            comp, date: m.kickOffTime?.dateTime, status: m.status, round: m.round?.metaData?.name || '',
            home: m.homeTeam?.internationalName, homeId: m.homeTeam?.id, homeCountry: m.homeTeam?.countryCode,
            away: m.awayTeam?.internationalName, awayId: m.awayTeam?.id, awayCountry: m.awayTeam?.countryCode,
            // 90-minute score where given (extra time is not part of the goals model)
            hg: reg ? reg.home : s ? s.home : null, ag: reg ? reg.away : s ? s.away : null,
          });
        }
        if (page.length < 100) break;
      }
    }
  }
}
out.sort((a, b) => (a.date < b.date ? -1 : 1));
writeFileSync(path.join(dir, 'uefa.json'), JSON.stringify(out));
console.log(`${out.length} UEFA club matches`);
