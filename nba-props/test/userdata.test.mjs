import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.USERDATA_DIR = mkdtempSync(join(tmpdir(), 'nbaud-'));
process.env.STATS_PROVIDER = 'nba';
const U = await import('../server/data/userdata.mjs');

const L = {
  today: '2026-11-05',
  playerLogs: (id) => (id === 'p1' ? [{ date: '2026-11-01', pts: 24, reb: 5, ast: 6, fg3m: 2 }] : []),
  teamDates: new Map([['AAA', ['2026-11-01']]]),
};

test('entries: add, bet, grade (win / loss / push / void / pending), summary', () => {
  const mk = (o) => U.addEntry({ source: 'manual', date: '2026-11-01', playerId: 'p1', team: 'AAA', stat: 'pts', line: 22.5, over: 1.91, under: 1.91, book: 'Bet365', ...o });
  const win = mk({ bet: { side: 'over', stake: 10, price: 1.91 }, model: { verdict: 'OVER' } });
  mk({ bet: { side: 'under', stake: 10, price: 2.0 }, model: { verdict: 'OVER' } });
  mk({ line: 24, bet: { side: 'over', stake: 5, price: 1.9 } });
  mk({ playerId: 'p2', bet: { side: 'over', stake: 5, price: 1.9 } }); // didn't play -> void
  mk({ date: '2026-11-06', bet: { side: 'over', stake: 5, price: 1.9 } }); // future -> pending
  mk({}); // a saved line without a bet is not in the bet log

  assert.equal(U.grade(L, win).betResult, 'win');
  const log = U.betLog(L);
  assert.equal(log.bets.length, 5);
  const s = log.summary;
  assert.deepEqual([s.settled.won, s.settled.lost, s.settled.push, s.void, s.pending], [1, 1, 1, 1, 1]);
  assert.ok(Math.abs(s.settled.profit - (10 * 0.91 - 10)) < 1e-9);
  assert.equal(s.settled.staked, 20); // pushes don't count as staked
  assert.equal(s.withModel.bets, 1);

  U.updateEntry(win.id, { bet: null });
  assert.equal(U.betLog(L).bets.length, 4);
  assert.ok(U.deleteEntry(win.id));
  assert.equal(U.listEntries().length, 5);
});

test('closing lines: latest snapshot before tip-off wins, later ones ignored', () => {
  const base = { date: '2026-11-01', eventId: 'e', gameId: 'g', home: 'AAA', away: 'BBB', tipoff: '2999-01-01T00:00:00Z' };
  U.recordOddsSnapshot({ ...base, rows: [{ player: 'X', stat: 'pts', book: 'dk', line: 20.5, over: 1.9, under: 1.9 }] });
  U.recordOddsSnapshot({ ...base, rows: [{ player: 'X', stat: 'pts', book: 'dk', line: 21.5, over: 1.9, under: 1.9 }] });
  U.recordOddsSnapshot({ ...base, tipoff: '2000-01-01T00:00:00Z', rows: [{ player: 'X', stat: 'pts', book: 'dk', line: 30.5, over: 1.9, under: 1.9 }] });
  const lines = U.loadClosingLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].line, 21.5);
});
