// Small shared helpers.

/** NBA season label for a date: games from August onward belong to the season starting that year. */
export function seasonOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 7 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
export const seasonStartYear = (season) => Number(season.slice(0, 4));
export const prevSeason = (season) => {
  const y = seasonStartYear(season) - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};

/** Today's date in US Eastern (the NBA's calendar), as YYYY-MM-DD. */
export function todayET(override) {
  if (override) return override;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

export const daysBetween = (a, b) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Normalise a person's name for cross-source matching (accents, punctuation, suffixes). */
export function normName(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`-]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "34:12" | "34" | 34.2 -> decimal minutes */
export function parseMinutes(m) {
  if (m == null || m === '') return 0;
  if (typeof m === 'number') return m;
  const [a, b] = String(m).split(':');
  return Number(a) + (b ? Number(b) / 60 : 0);
}

export const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
export function variance(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}
export const round = (x, d = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
