#!/usr/bin/env node
// Downloads Champions League, Europa League and Conference League fixtures and
// results (UEFA match data) for English, German, Italian and French clubs into
// data/raw/europe.json. Used for rest days / midweek European games, and for the
// Champions League fixtures themselves.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPS = { 1: 'Champions League', 14: 'Europa League', 2019: 'Conference League' };
const COUNTRIES = new Set(['ENG', 'GER', 'ITA', 'FRA']);
const out = [];
const now = new Date();
for (const [id, comp] of Object.entries(COMPS)) {
  for (let y = 2021; y <= now.getUTCFullYear(); y++) {
    for (const [from, to] of [[`${y}-01-01`, `${y}-06-30`], [`${y}-07-01`, `${y}-12-31`]]) {
      for (let offset = 0; ; offset += 100) {
        const url = `https://match.uefa.com/v5/matches?competitionId=${id}&fromDate=${from}&toDate=${to}&limit=100&offset=${offset}&order=ASC`;
        // curl rather than fetch: it honours the HTTPS proxy settings of cloud sessions.
        const page = JSON.parse(execFileSync('curl', ['-sSf', '-m', '60', url], { encoding: 'utf8', maxBuffer: 64e6 }));
        for (const m of page) {
          const hc = m.homeTeam?.countryCode, ac = m.awayTeam?.countryCode;
          if (!COUNTRIES.has(hc) && !COUNTRIES.has(ac)) continue;
          const s = m.score?.total;
          out.push({
            comp, date: m.kickOffTime?.dateTime, status: m.status, round: m.round?.metaData?.name || '',
            home: m.homeTeam?.internationalName, homeCountry: hc, away: m.awayTeam?.internationalName, awayCountry: ac,
            hg: s ? s.home : null, ag: s ? s.away : null,
          });
        }
        if (page.length < 100) break;
      }
    }
  }
}
out.sort((a, b) => (a.date < b.date ? -1 : 1));
writeFileSync(path.join(root, 'data/raw/europe.json'), JSON.stringify(out));
console.log(`${out.length} European matches involving ENG/GER/ITA/FRA clubs`);
