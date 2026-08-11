import { describe, it, expect, beforeAll } from 'vitest';
import { extractFunctions, extractConst, evalInScope } from './helpers/extract.js';

describe('mapRevolut() — CSV import parsing', () => {
  let scope;

  beforeAll(() => {
    const src = [
      extractConst('IDR_PER_EUR'),
      extractConst('MONTHS'),
      extractFunctions('csvNum', 'csvDate', 'fxOnDate', 'mapRevolut'),
    ].join('\n\n');
    const META = { BTC: {}, ETH: {}, SOL: {}, LINK: {}, HYPE: {} };
    const state = { fx: 1.155 };
    let _uid = 0;
    const uid = () => 'test' + (_uid++);
    scope = evalInScope(src, { META, state, uid });
  });

  it('regression: IDR-denominated rows are NOT treated as EUR (real bug, real fix)', () => {
    // A row with a raw number + "IDR" suffix, no $/€ symbol at all —
    // previously silently fell through to the EUR branch, treating e.g.
    // 138,920.02 IDR as €138,920.02 (wrong by a factor of ~17,800x).
    const rows = [{ Type: 'Buy', Symbol: 'BTC', Quantity: '0.001', Price: '138,920.02 IDR', Date: 'Apr 10, 2026, 3:41:03 PM' }];
    const parsed = scope.mapRevolut(rows);
    expect(parsed).toHaveLength(1);
    // Real EUR value should be tiny (IDR/EUR is roughly 17,000-18,000:1),
    // nowhere near treating 138,920.02 as a raw EUR price.
    expect(parsed[0].eur).toBeLessThan(20);
  });

  it('regression: staking reward rows (blank price) are imported, not silently dropped', () => {
    const rows = [{ Type: 'Staking reward', Symbol: 'ETH', Quantity: '0.00000343', Price: '', Date: 'Aug 1, 2026, 12:00:00 AM' }];
    const parsed = scope.mapRevolut(rows);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].isReward).toBe(true);
    expect(parsed[0].eur).toBe(0); // $0-cost acquisition, by design — see the actual commit for the reasoning
    expect(parsed[0].qty).toBeCloseTo(0.00000343, 10);
  });

  it('a normal USD-priced buy row parses correctly', () => {
    const rows = [{ Type: 'Buy - Revolut X', Symbol: 'LINK', Quantity: '10', Price: '$8.50', Date: 'Jun 1, 2026, 9:00:00 AM' }];
    const parsed = scope.mapRevolut(rows);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].usd).toBeCloseTo(8.50, 2);
    expect(parsed[0].ccy).toBe('USD');
  });

  it('unrecognized transaction types (transfers, non-staking rewards) are correctly ignored', () => {
    const rows = [{ Type: 'Referral reward', Symbol: 'BTC', Quantity: '0.001', Price: '$50', Date: 'Jun 1, 2026, 9:00:00 AM' }];
    expect(scope.mapRevolut(rows)).toHaveLength(0);
  });

  it('rows for unknown/fiat symbols are correctly skipped', () => {
    const rows = [{ Type: 'Buy', Symbol: 'EUR', Quantity: '100', Price: '$110', Date: 'Jun 1, 2026, 9:00:00 AM' }];
    expect(scope.mapRevolut(rows)).toHaveLength(0);
  });
});
