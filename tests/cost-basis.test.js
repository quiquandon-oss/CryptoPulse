import { describe, it, expect, beforeAll } from 'vitest';
import { extractFunctions, evalInScope } from './helpers/extract.js';

describe('avg() / qtyOf() — weighted-average cost basis', () => {
  let scope;

  beforeAll(() => {
    const src = extractFunctions('avg', 'qtyOf');
    const state = {
      ccy: 'USD',
      txs: [
        { asset: 'BTC', date: '2026-04-20', type: 'buy', qty: 0.1, usd: 60000, eur: 51063 },
        { asset: 'BTC', date: '2026-05-15', type: 'buy', qty: 0.05, usd: 70000, eur: 60344 },
        { asset: 'BTC', date: '2026-06-01', type: 'sell', qty: 0.05, usd: 68000, eur: 58620 },
        { asset: 'BTC', date: '2026-06-20', type: 'buy', qty: 0.02, usd: 65000, eur: 56034 },
      ],
    };
    scope = evalInScope(src, { state });
    scope._state = state;
  });

  it('a single buy sets the average to its own price', () => {
    expect(scope.avg('BTC', 'USD', '2026-04-20')).toBeCloseTo(60000, 2);
  });

  it('a second buy at a different price moves the weighted average correctly', () => {
    const expected = (0.1 * 60000 + 0.05 * 70000) / 0.15;
    expect(scope.avg('BTC', 'USD', '2026-05-15')).toBeCloseTo(expected, 2);
  });

  it('a sell does NOT change the average cost — only reduces quantity', () => {
    const beforeSell = scope.avg('BTC', 'USD', '2026-05-15');
    const afterSell = scope.avg('BTC', 'USD', '2026-06-01');
    expect(afterSell).toBeCloseTo(beforeSell, 2);
  });

  it('date cutoff correctly excludes future transactions', () => {
    expect(scope.avg('BTC', 'USD', '2026-04-15')).toBe(0); // before any purchase
  });

  it('qtyOf correctly nets buys and sells as of a given date', () => {
    expect(scope.qtyOf('BTC', '2026-05-15')).toBeCloseTo(0.15, 8);
    expect(scope.qtyOf('BTC', '2026-06-01')).toBeCloseTo(0.10, 8);
    expect(scope.qtyOf('BTC', '2026-06-20')).toBeCloseTo(0.12, 8);
  });

  it('backward compatibility: avg(a) and avg(a,ccy) with no date still work (used throughout the app)', () => {
    // These are the call shapes every OTHER part of the app already uses —
    // must keep working exactly as before the date param was added.
    expect(scope.avg('BTC')).toBeGreaterThan(0);
    expect(scope.avg('BTC', 'EUR')).toBeGreaterThan(0);
  });
});
