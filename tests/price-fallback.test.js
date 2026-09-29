import { describe, it, expect } from 'vitest';
import { extractConst, extractFunctions, evalInScope } from './helpers/extract.js';

// Regression: a held asset with no live price used to be repriced at the frozen
// build-time TODAY constant (2026-06-26), collapsing the last point of the
// Total Portfolio Value chart (~$4,204 -> ~$2,438 with real holdings).

const HISTORY = () => ({
  BTC: { '2026-04-11': 60000, '2026-06-26': 59724, '2026-09-27': 84000, '2026-09-28': 84100 },
  LINK: { '2026-04-11': 7, '2026-06-26': 7.32, '2026-09-27': 15, '2026-09-28': 15.2 },
});

function makeScope(prices) {
  const src = [
    extractConst('START'),
    extractConst('syms'),
    extractFunctions('days', 'qtyOf', 'histPx', 'pxUsd', 'seriesUSD'),
  ].join('\n\n');
  const state = {
    ccy: 'USD',
    fx: 1.14,
    prices,
    txs: [
      { asset: 'BTC', date: '2026-04-20', type: 'buy', qty: 0.02 },
      { asset: 'LINK', date: '2026-04-20', type: 'buy', qty: 100 },
    ],
  };
  return evalInScope(src, {
    state,
    PRICE_HISTORY: HISTORY(),
    NOW: () => '2026-09-29',
    interestEUR: () => 0,
    FX0: 1.1385,
  });
}

describe('pxUsd() — fallback when there is no live price', () => {
  it('uses the live price when present', () => {
    const s = makeScope({ BTC: { usd: 85000 } });
    expect(s.pxUsd('BTC')).toBe(85000);
  });

  it('falls back to the most recent known price, NOT the frozen 2026-06-26 constant', () => {
    const s = makeScope({});
    expect(s.pxUsd('BTC')).toBe(84100);
    expect(s.pxUsd('LINK')).toBe(15.2);
    expect(s.pxUsd('BTC')).not.toBe(59724);
  });

  it('returns 0 for undefined and for an asset with no history at all, without throwing', () => {
    const s = makeScope({});
    expect(s.pxUsd(undefined)).toBe(0);
    expect(s.pxUsd('DOGE')).toBe(0);
  });
});

describe('seriesUSD(\'ALL\') — today\'s point with missing live prices', () => {
  const last = (arr) => arr[arr.length - 1];
  const expectedYesterday = 0.02 * 84100 + 100 * 15.2;

  it('with NO live prices, today\'s point does not collapse to June-26 pricing', () => {
    const s = makeScope({});
    const series = s.seriesUSD('ALL');
    expect(last(series).x).toBe('2026-09-29');
    expect(last(series).y).toBeCloseTo(expectedYesterday, 6);
    const staleJune = 0.02 * 59724 + 100 * 7.32;
    expect(last(series).y).toBeGreaterThan(staleJune * 1.5);
  });

  it('with only ONE asset live, the other carries its latest known price', () => {
    const s = makeScope({ BTC: { usd: 85000 } });
    expect(last(s.seriesUSD('ALL')).y).toBeCloseTo(0.02 * 85000 + 100 * 15.2, 6);
  });

  it('normal case: with all live prices, today\'s point uses them; earlier days use history', () => {
    const s = makeScope({ BTC: { usd: 85000 }, LINK: { usd: 16 } });
    const series = s.seriesUSD('ALL');
    expect(last(series).y).toBeCloseTo(0.02 * 85000 + 100 * 16, 6);
    const yesterday = series.find((p) => p.x === '2026-09-28');
    expect(yesterday.y).toBeCloseTo(expectedYesterday, 6);
  });

  it('single-coin view shows that coin\'s price, and also carries the latest known price without live data', () => {
    const s = makeScope({});
    expect(last(s.seriesUSD('BTC')).y).toBe(84100);
  });
});
