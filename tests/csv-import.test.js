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

  it('regression: IDR round-up micro-buys with Quantity/Value scaled down 1000x are corrected (real bug, real fix)', () => {
    // Actual row from a real statement: Revolut's own export gives
    // Quantity 0.00005847 / Value "10.00 IDR" for what should be
    // 0.05847 LINK / 10,000.00 IDR (a plausible round-up amount — 10 IDR
    // literally isn't a real transaction size). Price itself (171,026.21
    // IDR/LINK) is correctly scaled — only qty was wrong, which the
    // existing price-outlier check can't catch since price-per-unit here
    // is fine either way.
    const rows = [{ Type: 'Buy', Symbol: 'LINK', Quantity: '0.00005847', Price: '171,026.21 IDR', Value: '10.00 IDR', Date: 'Aug 18, 2026, 1:08:49 PM' }];
    const parsed = scope.mapRevolut(rows);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].qty).toBeCloseTo(0.05847, 6); // corrected, not the raw 0.00005847
  });

  it('regression: the smaller 2.00 IDR round-up variant is also corrected', () => {
    const rows = [{ Type: 'Buy', Symbol: 'LINK', Quantity: '0.00001332', Price: '150,087.56 IDR', Value: '2.00 IDR', Date: 'Aug 10, 2026, 6:57:27 PM' }];
    const parsed = scope.mapRevolut(rows);
    expect(parsed[0].qty).toBeCloseTo(0.01332, 6);
  });

  it('a genuine, correctly-sized IDR buy (Value well above the 1000 IDR floor) is left untouched', () => {
    // Guards against the fix over-correcting a real, normal-sized IDR
    // transaction that just happens to be IDR-denominated.
    const rows = [{ Type: 'Buy', Symbol: 'LINK', Quantity: '1.16', Price: '150,000.00 IDR', Value: '174,000.00 IDR', Date: 'Aug 18, 2026, 1:08:49 PM' }];
    const parsed = scope.mapRevolut(rows);
    expect(parsed[0].qty).toBeCloseTo(1.16, 6); // unchanged
  });

  it('a real BTC buy at a high EUR price is never touched by the IDR-quantity correction, even if tiny', () => {
    // BTC is excluded from findIdrQtyBugCandidates' scope (see that
    // function's comment) because BTC EUR prices can legitimately be five
    // or six figures -- confirming here that the IMPORT-TIME fix (which
    // only fires on the isIdr branch, not this asset-exclusion) doesn't
    // touch a real EUR-priced BTC row either, since it was never IDR to
    // begin with.
    const rows = [{ Type: 'Buy', Symbol: 'BTC', Quantity: '0.0001', Price: '€85,000.00', Date: 'Aug 18, 2026, 1:08:49 PM' }];
    const parsed = scope.mapRevolut(rows);
    expect(parsed[0].qty).toBeCloseTo(0.0001, 8); // unchanged -- not an IDR row at all
  });
});

describe('findIdrQtyBugCandidates() — one-time repair for already-imported bad rows', () => {
  function bindWithState(txs) {
    const src = extractFunctions('findIdrQtyBugCandidates');
    return evalInScope(src, { state: { txs } });
  }

  const idrBugRow = { acct: 'Revolut', asset: 'LINK', ccy: 'EUR', price: 171026.21, qty: 0.00005847, date: '2026-08-18' };

  it('flags the exact known bug pattern: non-BTC, EUR, huge raw price, tiny qty', () => {
    expect(bindWithState([idrBugRow]).findIdrQtyBugCandidates()).toEqual([idrBugRow]);
  });

  it('never flags BTC regardless of price/qty shape', () => {
    const btcRow = { ...idrBugRow, asset: 'BTC' };
    expect(bindWithState([btcRow]).findIdrQtyBugCandidates()).toEqual([]);
  });

  it('never flags a normal-sized transaction', () => {
    const normalRow = { acct: 'Revolut', asset: 'LINK', ccy: 'EUR', price: 8.5, qty: 2.3, date: '2026-08-18' };
    expect(bindWithState([normalRow]).findIdrQtyBugCandidates()).toEqual([]);
  });

  it('never flags a non-Revolut (Neverless) transaction', () => {
    const neverlessRow = { ...idrBugRow, acct: 'Neverless' };
    expect(bindWithState([neverlessRow]).findIdrQtyBugCandidates()).toEqual([]);
  });

  it('correctly identifies only the affected rows out of a mixed batch', () => {
    const mixed = [
      idrBugRow,
      { ...idrBugRow, asset: 'BTC' },
      { acct: 'Revolut', asset: 'ETH', ccy: 'EUR', price: 1900, qty: 0.001, date: '2026-08-18' },
      { ...idrBugRow, asset: 'HYPE', price: 149661.47, qty: 0.00006681 },
    ];
    const found = bindWithState(mixed).findIdrQtyBugCandidates();
    expect(found).toHaveLength(2);
    expect(found.map(t => t.asset).sort()).toEqual(['HYPE', 'LINK']);
  });
});
