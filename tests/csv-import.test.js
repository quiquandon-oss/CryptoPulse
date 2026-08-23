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

describe('mapNeverless() — CSV import parsing', () => {
  let scope;

  beforeAll(() => {
    const src = [
      extractConst('NEVERLESS_SEED_CUTOFF'),
      extractFunctions('csvNum', 'csvDate', 'mapNeverless'),
    ].join('\n\n');
    const META = { BTC: {}, ETH: {}, SOL: {}, LINK: {}, HYPE: {} };
    const state = { fx: 1.155 };
    let _uid = 0;
    const uid = () => 'test' + (_uid++);
    scope = evalInScope(src, { META, state, uid });
  });

  it('regression: a Trade row dated on the seed cutoff date is skipped (already in the seed lump sum)', () => {
    const rows = [{ Type: 'Trade', Date: '2026-04-11T12:00:00Z', 'Amount received': '10', 'Asset received': 'LINK', 'Amount sent': '90', 'Asset sent': 'USDT', 'USD price of asset received': '9', ID: 'a' }];
    expect(scope.mapNeverless(rows)).toHaveLength(0);
  });

  it('regression: a Trade row dated well before the seed cutoff is skipped (real bug, real fix)', () => {
    // Actual shape of the bug: re-importing the full lifetime Neverless
    // statement used to re-add every one of these on top of the seed's
    // already-inclusive lump sum -- confirmed against a real prior import
    // that took LINK from 65.93 to 693.31 this way.
    const rows = [{ Type: 'Trade', Date: '2025-08-16T20:28:20Z', 'Amount received': '1.27434982151963284', 'Asset received': 'LINK', 'Amount sent': '24.99', 'Asset sent': 'EURC', 'USD price of asset received': '22.871121740514', ID: '283cf7e2-c0a4-47c5-9de5-43a8288e9860' }];
    expect(scope.mapNeverless(rows)).toHaveLength(0);
  });

  it('a Trade row dated after the seed cutoff is imported as a real buy', () => {
    const rows = [{ Type: 'Trade', Date: '2026-08-21T09:30:02Z', 'Amount received': '2', 'Asset received': 'LINK', 'Amount sent': '19.6', 'Asset sent': 'EURC', 'USD price of asset received': '11.429714057189', ID: 'eb0e434b-2525-41a2-891b-0dbcf8d9eb22' }];
    const parsed = scope.mapNeverless(rows);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].asset).toBe('LINK');
    expect(parsed[0].qty).toBeCloseTo(2, 8);
    expect(parsed[0].isReward).toBeUndefined();
  });

  it('regression: a post-cutoff Deposit row (no counter-asset) is imported, not silently dropped', () => {
    // Previously the Type==='Trade' filter dropped every Deposit row
    // entirely -- including genuine external transfers-in like this one.
    const rows = [{ Type: 'Deposit', Date: '2026-05-10T00:35:13Z', 'Amount received': '0.0014', 'Asset received': 'LINK', 'Amount sent': '', 'Asset sent': '', 'USD price of asset received': '10.389376654023', ID: '840fd809-7a5e-4dd5-9193-9174978a785a' }];
    const parsed = scope.mapNeverless(rows);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].asset).toBe('LINK');
    expect(parsed[0].qty).toBeCloseTo(0.0014, 8);
    expect(parsed[0].isReward).toBe(true);
    expect(parsed[0].eur).toBe(0); // $0-cost, same treatment as Revolut staking rewards
  });

  it('a post-cutoff Deposit row is treated as $0-cost even though a real USD price is present in the export', () => {
    // Deliberate: same reasoning as Revolut's staking rewards -- these are
    // consistently sub-$1 dust (daily interest paid in-kind), not a
    // deliberate purchase decision worth tracking a precise cost basis for.
    const rows = [{ Type: 'Deposit', Date: '2026-06-01T00:02:16Z', 'Amount received': '0.000001', 'Asset received': 'BTC', 'Amount sent': '', 'Asset sent': '', 'USD price of asset received': '95000', ID: 'x' }];
    const parsed = scope.mapNeverless(rows);
    expect(parsed[0].usd).toBe(0);
    expect(parsed[0].price).toBe(0);
  });

  it('a Deposit row for an untracked asset is skipped', () => {
    const rows = [{ Type: 'Deposit', Date: '2026-05-10T00:00:00Z', 'Amount received': '10', 'Asset received': 'DOGE', 'Amount sent': '', 'Asset sent': '', 'USD price of asset received': '0.1', ID: 'x' }];
    expect(scope.mapNeverless(rows)).toHaveLength(0);
  });

  it('a Deposit row that DOES have a counter-asset (i.e. is actually a Trade misfiled, or malformed) is not treated as a reward deposit', () => {
    const rows = [{ Type: 'Deposit', Date: '2026-05-10T00:00:00Z', 'Amount received': '10', 'Asset received': 'LINK', 'Amount sent': '5', 'Asset sent': 'USDT', 'USD price of asset received': '9', ID: 'x' }];
    expect(scope.mapNeverless(rows)).toHaveLength(0);
  });

  it('a Trade row where the counter-asset is a crypto-to-crypto swap (not a stablecoin) is skipped, not mis-imported', () => {
    // Known scope limitation, not fixed here: crypto-to-crypto trades
    // (e.g. LINK swapped for XPL) aren't reflected as a LINK reduction.
    // All real occurrences of this in the actual statement predate the
    // seed cutoff anyway, so they're excluded by that filter regardless.
    const rows = [{ Type: 'Trade', Date: '2026-08-21T09:30:02Z', 'Amount received': '100', 'Asset received': 'XPL', 'Amount sent': '5', 'Asset sent': 'LINK', 'USD price of asset received': '1.3', ID: 'x' }];
    expect(scope.mapNeverless(rows)).toHaveLength(0);
  });

  it('end-to-end: the real post-cutoff LINK rows from the actual uploaded statement produce exactly 2 buys + 1 reward, not 95 double-counted historical rows', () => {
    const rows = [
      // pre-cutoff historical noise -- must be excluded
      { Type: 'Trade', Date: '2025-08-16T20:28:20Z', 'Amount received': '1.27', 'Asset received': 'LINK', 'Amount sent': '24.99', 'Asset sent': 'EURC', 'USD price of asset received': '22.87', ID: 'old1' },
      { Type: 'Deposit', Date: '2026-03-29T02:11:07Z', 'Amount received': '7.55722224', 'Asset received': 'LINK', 'Amount sent': '', 'Asset sent': '', 'USD price of asset received': '8.48', ID: 'old2' },
      // real post-cutoff activity -- must be included
      { Type: 'Deposit', Date: '2026-05-10T00:35:13Z', 'Amount received': '0.0014', 'Asset received': 'LINK', 'Amount sent': '', 'Asset sent': '', 'USD price of asset received': '10.39', ID: 'new1' },
      { Type: 'Trade', Date: '2026-08-21T09:30:02Z', 'Amount received': '2', 'Asset received': 'LINK', 'Amount sent': '19.6', 'Asset sent': 'EURC', 'USD price of asset received': '11.43', ID: 'new2' },
      { Type: 'Trade', Date: '2026-08-23T01:16:29Z', 'Amount received': '0.478', 'Asset received': 'LINK', 'Amount sent': '4.79', 'Asset sent': 'EURC', 'USD price of asset received': '11.68', ID: 'new3' },
    ];
    const parsed = scope.mapNeverless(rows);
    expect(parsed).toHaveLength(3);
    expect(parsed.filter(t => t.isReward).length).toBe(1);
    expect(parsed.filter(t => !t.isReward).length).toBe(2); // the "2 LINK transactions" Olivier expected
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
