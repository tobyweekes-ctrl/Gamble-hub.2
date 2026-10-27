// fetch wrapper: per-host throttling, timeout, limited retries with backoff.
const lastCall = new Map(); // host -> timestamp of last request start
const queues = new Map(); // host -> promise chain, so requests to one host are serialised

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url.replace(/apiKey=[^&]+/, 'apiKey=***')}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {string} url
 * @param {{headers?:object, minGapMs?:number, timeoutMs?:number, retries?:number}} opts
 * @returns {Promise<{json:any, headers:Headers}>}
 */
export function fetchJson(url, { headers = {}, minGapMs = 250, timeoutMs = 20000, retries = 2 } = {}) {
  const host = new URL(url).host;
  const prev = queues.get(host) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = (lastCall.get(host) || 0) + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall.set(host, Date.now());
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          // 4xx (except 429) won't get better on retry
          if (res.status !== 429 && res.status < 500) throw new HttpError(res.status, url, body);
          if (attempt >= retries) throw new HttpError(res.status, url, body);
        } else {
          return { json: await res.json(), headers: res.headers };
        }
      } catch (err) {
        if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
        if (attempt >= retries) throw err;
      }
      await sleep(1000 * 2 ** attempt);
    }
  });
  queues.set(host, run);
  return run;
}
