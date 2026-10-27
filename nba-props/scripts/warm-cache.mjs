// Pre-fetch and cache everything a session needs: both seasons, today's slate, injuries.
// Run once before opening the app (npm run warm); past seasons are cached for good.
import { getLeague, getSlate, getInjuries, status } from '../server/data/store.mjs';
import { cacheInfo } from '../server/cache.mjs';

const t0 = Date.now();
console.log('providers:', status());
const L = await getLeague();
console.log(`league: ${L.players.size} players; ${L.current} ${L.bySeason[L.current].rows.length} rows; ${L.previous} ${L.bySeason[L.previous].rows.length} rows`);
const slate = await getSlate();
console.log(`slate ${L.today}: ${slate.map((g) => `${g.away}@${g.home}`).join(' ') || 'no games'}`);
const inj = await getInjuries().catch((e) => (console.warn('injuries failed:', e.message), []));
console.log(`injuries: ${inj.length} entries`);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`, cacheInfo());
