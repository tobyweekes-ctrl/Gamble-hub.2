// ESPN's public NBA injury report (site.api.espn.com). One request covers the league.
import { fetchJson } from '../http.mjs';
import { teamAbbr } from '../teams.mjs';

const URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';

export function normaliseInjuries(json) {
  const out = [];
  for (const t of json.injuries || []) {
    for (const i of t.injuries || []) {
      const a = i.athlete || {};
      const d = i.details || {};
      out.push({
        name: a.displayName,
        team: teamAbbr(a.team?.abbreviation) ?? teamAbbr(t.displayName),
        status: i.status || d.fantasyStatus?.description || 'Unknown', // Out | Day-To-Day | Questionable ...
        injury: [d.side && d.side !== 'Not Specified' ? d.side : null, d.type, d.detail].filter(Boolean).join(' '),
        returnDate: d.returnDate || null,
        updated: i.date || null,
        note: i.shortComment || '',
        source: 'ESPN',
      });
    }
  }
  return out;
}

export const espnInjuryProvider = {
  name: 'ESPN',
  async load() {
    const { json } = await fetchJson(URL, { minGapMs: 500 });
    return normaliseInjuries(json);
  },
};
