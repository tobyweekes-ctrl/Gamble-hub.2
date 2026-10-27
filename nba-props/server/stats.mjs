// Stat definitions shared by data layer, model and UI.
export const STATS = {
  pts: { label: 'Points', short: 'PTS', parts: ['pts'], market: 'player_points' },
  reb: { label: 'Rebounds', short: 'REB', parts: ['reb'], market: 'player_rebounds' },
  ast: { label: 'Assists', short: 'AST', parts: ['ast'], market: 'player_assists' },
  fg3m: { label: '3-Pointers Made', short: '3PM', parts: ['fg3m'], market: 'player_threes' },
  pra: { label: 'Pts + Reb + Ast', short: 'PRA', parts: ['pts', 'reb', 'ast'], market: 'player_points_rebounds_assists' },
  pr: { label: 'Pts + Reb', short: 'P+R', parts: ['pts', 'reb'], market: 'player_points_rebounds' },
  pa: { label: 'Pts + Ast', short: 'P+A', parts: ['pts', 'ast'], market: 'player_points_assists' },
  ra: { label: 'Reb + Ast', short: 'R+A', parts: ['reb', 'ast'], market: 'player_rebounds_assists' },
};
export const STAT_KEYS = Object.keys(STATS);
export const statValue = (row, stat) => STATS[stat].parts.reduce((s, k) => s + (row[k] ?? 0), 0);
export const statForMarket = (market) => STAT_KEYS.find((k) => STATS[k].market === market) ?? null;
