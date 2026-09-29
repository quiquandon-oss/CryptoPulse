import { describe, it, expect } from 'vitest';
import { extractConst, extractFunctions, evalInScope } from './helpers/extract.js';

// Regression: from 2026-09-29 10:15 UTC every /history log had btc_price=null —
// getPrices() never checked the HTTP status, never retried a 429, and reported
// "live prices" even when nothing had loaded.

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const CG_OK = { bitcoin: { usd: 85000, eur: 74000, usd_24h_change: 1.5 }, chainlink: { usd: 16, eur: 14, usd_24h_change: -0.5 } };
const HL_MIDS = { BTC: '84500.5', LINK: '15.9', ETH: '2700' };

function makeScope({ cgResponses, hl, prices = {}, extraTxs = [] }) {
  const src = [
    extractConst('META'),
    extractConst('syms'),
    extractFunctions('qtyOf', 'fetchCoinGeckoPrices', 'fetchHyperliquidMids', 'getPrices'),
  ].join('\n\n');
  const calls = { cg: 0, hl: 0 };
  const status = [];
  const state = {
    prices,
    fx: 1.14,
    txs: [
      { asset: 'BTC', date: '2026-04-20', type: 'buy', qty: 0.02 },
      { asset: 'LINK', date: '2026-04-20', type: 'buy', qty: 100 },
      ...extraTxs,
    ],
  };
  const PRICE_HISTORY = { BTC: { '2026-09-28': 84100 }, LINK: { '2026-09-28': 15.2 } };
  const scope = evalInScope(src, {
    state,
    PRICE_HISTORY,
    NOW: () => '2026-09-29',
    FX0: 1.1385,
    CG: 'https://cg.test',
    LS: { px() {} },
    setStatus: (ok) => status.push(ok),
    setTimeout: (fn) => fn(),
    cgFetch: async () => {
      const r = cgResponses[Math.min(calls.cg, cgResponses.length - 1)];
      calls.cg++;
      if (r instanceof Error) throw r;
      return r;
    },
    fetch: async () => {
      calls.hl++;
      if (hl instanceof Error) throw hl;
      return hl;
    },
  });
  return { scope, state, calls, status, PRICE_HISTORY };
}

describe('getPrices()', () => {
  it('normal case: CoinGecko answers, prices are set, status is live, no fallback used', async () => {
    const t = makeScope({ cgResponses: [json(200, CG_OK)], hl: json(200, HL_MIDS) });
    await t.scope.getPrices();
    expect(t.state.prices.BTC.usd).toBe(85000);
    expect(t.state.prices.LINK.usd).toBe(16);
    expect(t.status).toEqual([true]);
    expect(t.calls.hl).toBe(0);
    expect(t.PRICE_HISTORY.BTC['2026-09-29']).toBe(85000);
  });

  it('retries a 429 and succeeds without touching the fallback', async () => {
    const t = makeScope({ cgResponses: [json(429, {}), json(429, {}), json(200, CG_OK)], hl: json(200, HL_MIDS) });
    await t.scope.getPrices();
    expect(t.calls.cg).toBe(3);
    expect(t.state.prices.BTC.usd).toBe(85000);
    expect(t.status).toEqual([true]);
    expect(t.calls.hl).toBe(0);
  });

  it('a persistent CoinGecko error falls back to Hyperliquid and still reports live', async () => {
    const t = makeScope({ cgResponses: [json(429, {})], hl: json(200, HL_MIDS) });
    await t.scope.getPrices();
    expect(t.state.prices.BTC.usd).toBe(84500.5);
    expect(t.state.prices.LINK.usd).toBe(15.9);
    expect(t.state.prices.BTC.eur).toBeCloseTo(84500.5 / 1.14, 6);
    expect(t.status).toEqual([true]);
  });

  it('a 200 response that is really an error body (no coin keys) is treated as missing, not as success', async () => {
    const t = makeScope({ cgResponses: [json(200, { status: { error_code: 10005 } })], hl: json(200, HL_MIDS) });
    await t.scope.getPrices();
    expect(t.state.prices.BTC.usd).toBe(84500.5);
    expect(t.status).toEqual([true]);
  });

  it('partial CoinGecko answer: only the missing asset comes from the fallback', async () => {
    const t = makeScope({ cgResponses: [json(200, { bitcoin: CG_OK.bitcoin })], hl: json(200, HL_MIDS) });
    await t.scope.getPrices();
    expect(t.state.prices.BTC.usd).toBe(85000);
    expect(t.state.prices.LINK.usd).toBe(15.9);
    expect(t.status).toEqual([true]);
  });

  it('both sources down: keeps last known prices, reports NOT live, does not throw, does not stamp today with a stale price', async () => {
    const stale = { BTC: { usd: 83000, fetchedAt: 1 }, LINK: { usd: 15, fetchedAt: 1 } };
    const t = makeScope({ cgResponses: [new Error('network')], hl: new Error('network'), prices: { ...stale } });
    await t.scope.getPrices();
    expect(t.state.prices.BTC.usd).toBe(83000);
    expect(t.status).toEqual([false]);
    expect(t.PRICE_HISTORY.BTC['2026-09-29']).toBeUndefined();
  });

  it('an asset with zero net quantity does not force the status to "not live"', async () => {
    const extraTxs = [
      { asset: 'ETH', date: '2026-05-01', type: 'buy', qty: 1 },
      { asset: 'ETH', date: '2026-06-01', type: 'sell', qty: 1 },
    ];
    const t = makeScope({ cgResponses: [json(200, CG_OK)], hl: new Error('unused'), extraTxs });
    await t.scope.getPrices();
    expect(t.status).toEqual([true]);
  });
});
