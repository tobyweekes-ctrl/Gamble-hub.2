// Runs the app's inline script in a Node vm with a stubbed DOM and localStorage,
// and returns the pieces the tools need. The tools use the app's own maths this
// way rather than a copy of it, so the two can't drift apart.

import vm from 'node:vm';

export const SEED_BEGIN = '// BEGIN GENERATED SEED';
export const SEED_END = '// END GENERATED SEED\n';

export function appScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (scripts.length !== 1) throw new Error(`Expected one inline <script>, found ${scripts.length}`);
  return scripts[0];
}

// A DOM stub that accepts any property access or call.
function stub() {
  return new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : stub()),
    set: () => true,
    apply: () => stub(),
  });
}

export function loadApp(html, { now } = {}) {
  const code = appScript(html) + `
;globalThis.__out = { SEED_MATCHES, SEED_VERSION, SEED_RESULTS, LEAGUE_ORDER, MODEL_VERSION,
  computeModelProbs, quickProbs, predictionsLog: () => predictionsLog };`;
  new vm.Script(code, { filename: 'index.html<script>' }); // syntax check first
  const store = new Map();
  const RealDate = Date;
  const FixedDate = now == null ? RealDate : class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return new RealDate(now).getTime(); }
  };
  const ctx = {
    console, Date: FixedDate, Math, JSON, Intl,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    document: stub(), window: stub(), navigator: stub(),
    setTimeout: () => 0, clearTimeout: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'index.html<script>' });
  return ctx.__out;
}
