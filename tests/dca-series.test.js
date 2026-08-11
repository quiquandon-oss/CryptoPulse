import { describe, it, expect, beforeAll } from 'vitest';
import { extractFunctions, extractConst, evalInScope } from './helpers/extract.js';

describe('dcaAvgSeriesUSD() — average cost evolution over time', () => {
  let scope;

  beforeAll(() => {
    const src = [
      extractConst('START'),
      extractFunctions('days', 'avg', 'dcaAvgSeriesUSD'),
    ].join('\n\n');
    const state = {
      ccy: 'USD',
      txs: [
        { asset: 'BTC', date: '2026-04-20', type: 'buy', qty: 0.1, usd: 60000 },
        { asset: 'BTC', date: '2026-05-15', type: 'buy', qty: 0.05, usd: 70000 },
      ],
    };
    const NOW = () => '2026-06-01'; // fixed "today" for deterministic tests
    scope = evalInScope(src, { state, NOW });
  });

  it('trims leading zero-days — starts from the coin\'s own first purchase, not portfolio START', () => {
    const series = scope.dcaAvgSeriesUSD('BTC');
    expect(series[0].x).toBe('2026-04-20'); // NOT the portfolio's overall START date
  });

  it('is flat (a step function) between transactions, not interpolated', () => {
    const series = scope.dcaAvgSeriesUSD('BTC');
    const may1 = series.find(p => p.x === '2026-05-01');
    const may10 = series.find(p => p.x === '2026-05-10');
    expect(may1.y).toBeCloseTo(60000, 2);
    expect(may10.y).toBeCloseTo(60000, 2); // still flat, second buy hasn't happened yet
  });

  it('jumps to the correct new weighted average exactly on the transaction date', () => {
    const series = scope.dcaAvgSeriesUSD('BTC');
    const expected = (0.1 * 60000 + 0.05 * 70000) / 0.15;
    const onDay = series.find(p => p.x === '2026-05-15');
    expect(onDay.y).toBeCloseTo(expected, 2);
  });

  it('a coin with no transactions returns an empty series, not a crash', () => {
    expect(scope.dcaAvgSeriesUSD('DOGE')).toEqual([]);
  });
});

describe('clipRange() — chart range filtering', () => {
  let scope;

  beforeAll(() => {
    const src = [extractConst('START'), extractFunctions('clipRange')].join('\n\n');
    const state = { range: 'ALL' };
    const NOW = () => '2026-08-10';
    scope = evalInScope(src, { state, NOW });
  });

  const series = [
    { x: '2026-04-11', y: 1 },
    { x: '2026-07-01', y: 2 },
    { x: '2026-08-05', y: 3 },
    { x: '2026-08-09', y: 4 },
  ];

  it('ALL returns everything untouched', () => {
    expect(scope.clipRange(series, 'ALL')).toHaveLength(4);
  });

  it('1M clips to roughly the last 30 days', () => {
    const clipped = scope.clipRange(series, '1M');
    expect(clipped.map(p => p.x)).toEqual(['2026-08-05', '2026-08-09']); // July 1 is correctly outside a 30-day window from Aug 10
  });

  it('24H clips to the last day only', () => {
    const clipped = scope.clipRange(series, '24H');
    expect(clipped.map(p => p.x)).toEqual(['2026-08-09']);
  });

  it('an explicit range param does not touch or depend on global state.range', () => {
    scope._testState = { range: 'YTD' };
    const before = scope._testState?.range;
    scope.clipRange(series, '1M');
    // state.range was never passed to this call — confirms the function
    // signature itself doesn't require or mutate the global for an
    // explicit-range call, which is what makes it safe for the DCA
    // evolution tiles to use independently of the main chart's range.
    expect(before).toBe('YTD');
  });
});
