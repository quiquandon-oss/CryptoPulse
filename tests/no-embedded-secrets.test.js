import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// sec-v1: the public page ships no credential; protected Worker routes get the per-device token from localStorage.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const grab = (name) => { const i = html.indexOf(`function ${name}(`); let d = 0, j = html.indexOf('{', i);
  for (; j < html.length; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) break; } return html.slice(i, j + 1); };
const constBlock = (name) => { const i = html.indexOf(`const ${name}=`); return html.slice(i, html.indexOf('];', i) + 2); };

describe('no credentials in the page', () => {
  it('no KEY/SECRET/TOKEN constant holds a literal value, and the retired names are gone', () => {
    const lits = [...html.matchAll(/const ([A-Z_]*(KEY|SECRET|TOKEN)[A-Z_]*)\s*=\s*'([^']*)'/g)]
      .filter((m) => !/STORAGE|CACHE_KEY|STATE_KEY$/.test(m[1]));
    expect(lits.map((m) => m[1])).toEqual([]);
    for (const n of ['APP_SECRET', 'FRED_KEY', 'CG_API_KEY=', 'SOSO_API_KEY=', "'X-App-Secret'", 'x-soso-api-key', 'x-cg-demo-api-key', '&key=']) {
      expect(html.includes(n), n).toBe(false);
    }
  });
  it('the alert sheet secret comes from this device, and sync refuses to run without it', () => {
    expect(html).toContain("alertSecret=localStorage.getItem(ALERT_WRITE_SECRET_STORAGE)");
    expect(html).toContain("Sync status: alert sheet secret not set (Settings)");
  });
});

describe('route list parity with the Worker (when the PulseWorker checkout has sec-v1)', () => {
  it('V1_PROTECTED_ROUTES is identical on both sides', () => {
    let src; try { src = readFileSync(new URL('../../PulseWorker/worker.js', import.meta.url), 'utf8'); } catch { return; }
    if (!src.includes('const V1_PROTECTED_ROUTES')) return;
    const w = new Function(src.slice(src.indexOf('const V1_PROTECTED_ROUTES'), src.indexOf(']);', src.indexOf('const V1_PROTECTED_ROUTES')) + 3) + '; return [...V1_PROTECTED_ROUTES];')();
    const f = new Function(constBlock('V1_PROTECTED_ROUTES') + '; return V1_PROTECTED_ROUTES;')();
    expect([...f].sort()).toEqual([...w].sort());
  });
});

describe('fetch wrapper and proxies', () => {
  const W = 'https://sentiment-ff75.quiquandon.workers.dev';
  function env(token) {
    const store = token ? { cp_v1_access_token: token } : {};
    const calls = [];
    const window = { fetch: async (i, init) => { calls.push([i, init]); return { ok: true }; } };
    const localStorage = { getItem: (k) => store[k] ?? null };
    const location = { href: 'https://quiquandon-oss.github.io/CryptoPulse/' };
    const iife = html.slice(html.indexOf('(function installV1AuthFetch(){'), html.indexOf('})();', html.indexOf('(function installV1AuthFetch(){')) + 5);
    const api = new Function('window', 'localStorage', 'location', 'Headers', 'URL', 'URLSearchParams',
      `const PULSE_WORKER_URL='${W}';const V1_TOKEN_STORAGE='cp_v1_access_token';${constBlock('V1_PROTECTED_ROUTES')}\n${grab('v1TokenFor')}\n${iife}\n
       const fetch=(...a)=>window.fetch(...a);${grab('cgFetch')}\n${grab('sosoFetch')}\nreturn { fetch: window.fetch, cgFetch, sosoFetch };`)(window, localStorage, location, Headers, URL, URLSearchParams);
    return { api, calls };
  }
  it('adds X-V1-Token only to protected Worker routes, never to public ones or other hosts', async () => {
    const { api, calls } = env('tok');
    await api.fetch(`${W}/txs-backup`);
    await api.fetch(`${W}/txs-backup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await api.fetch(`${W}/history`);
    await api.fetch(`${W}/history`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    await api.fetch('https://api.hyperliquid.xyz/info', { method: 'POST' });
    const tok = calls.map(([, init]) => init && init.headers instanceof Headers ? init.headers.get('X-V1-Token') : null);
    expect(tok).toEqual(['tok', 'tok', null, 'tok', null]);
    expect(calls[1][1].headers.get('Content-Type')).toBe('application/json');
  });
  it('sends nothing extra when this device has no token', async () => {
    const { api, calls } = env(null);
    await api.fetch(`${W}/txs-backup`);
    expect(calls[0][1]).toBeUndefined();
  });
  it('CoinGecko and SoSoValue calls go through the Worker proxy with the same path and query', async () => {
    const { api, calls } = env(null);
    await api.cgFetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=90');
    await api.sosoFetch('https://openapi.sosovalue.com/openapi/v1/etfs/summary-history?symbol=BTC&country_code=US&limit=30');
    expect(calls.map((c) => c[0])).toEqual([
      `${W}/api-proxy/coingecko?vs_currency=usd&days=90&path=%2Fcoins%2Fbitcoin%2Fmarket_chart`,
      `${W}/api-proxy/sosovalue?symbol=BTC&country_code=US&limit=30&path=%2Fetfs%2Fsummary-history`,
    ]);
  });
});
