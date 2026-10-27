// Canonical team table. Abbreviations follow stats.nba.com; other sources are mapped onto these.
export const TEAMS = [
  ['ATL', 1610612737, 'Atlanta Hawks'], ['BOS', 1610612738, 'Boston Celtics'],
  ['BKN', 1610612751, 'Brooklyn Nets'], ['CHA', 1610612766, 'Charlotte Hornets'],
  ['CHI', 1610612741, 'Chicago Bulls'], ['CLE', 1610612739, 'Cleveland Cavaliers'],
  ['DAL', 1610612742, 'Dallas Mavericks'], ['DEN', 1610612743, 'Denver Nuggets'],
  ['DET', 1610612765, 'Detroit Pistons'], ['GSW', 1610612744, 'Golden State Warriors'],
  ['HOU', 1610612745, 'Houston Rockets'], ['IND', 1610612754, 'Indiana Pacers'],
  ['LAC', 1610612746, 'Los Angeles Clippers'], ['LAL', 1610612747, 'Los Angeles Lakers'],
  ['MEM', 1610612763, 'Memphis Grizzlies'], ['MIA', 1610612748, 'Miami Heat'],
  ['MIL', 1610612749, 'Milwaukee Bucks'], ['MIN', 1610612750, 'Minnesota Timberwolves'],
  ['NOP', 1610612740, 'New Orleans Pelicans'], ['NYK', 1610612752, 'New York Knicks'],
  ['OKC', 1610612760, 'Oklahoma City Thunder'], ['ORL', 1610612753, 'Orlando Magic'],
  ['PHI', 1610612755, 'Philadelphia 76ers'], ['PHX', 1610612756, 'Phoenix Suns'],
  ['POR', 1610612757, 'Portland Trail Blazers'], ['SAC', 1610612758, 'Sacramento Kings'],
  ['SAS', 1610612759, 'San Antonio Spurs'], ['TOR', 1610612761, 'Toronto Raptors'],
  ['UTA', 1610612762, 'Utah Jazz'], ['WAS', 1610612764, 'Washington Wizards'],
].map(([abbr, nbaId, name]) => ({ abbr, nbaId, name }));

const byAbbr = new Map(TEAMS.map((t) => [t.abbr, t]));
const ALIASES = {
  GS: 'GSW', NY: 'NYK', NO: 'NOP', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', PHO: 'PHX', BRK: 'BKN',
  CHO: 'CHA', NOR: 'NOP', 'LA CLIPPERS': 'LAC', 'LA LAKERS': 'LAL',
};
const byName = new Map(TEAMS.map((t) => [t.name.toUpperCase(), t.abbr]));

/** Map any abbreviation, full name or nba.com id onto our canonical abbreviation. */
export function teamAbbr(x) {
  if (x == null) return null;
  if (typeof x === 'number' || /^\d{10}$/.test(String(x))) {
    return TEAMS.find((t) => t.nbaId === Number(x))?.abbr ?? null;
  }
  const s = String(x).trim().toUpperCase();
  if (byAbbr.has(s)) return s;
  if (ALIASES[s]) return ALIASES[s];
  if (byName.has(s)) return byName.get(s);
  return null;
}

export const team = (abbr) => byAbbr.get(teamAbbr(abbr));
