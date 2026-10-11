import { describe, it, expect } from 'vitest';
import { extractFunctions, evalInScope } from './helpers/extract.js';

// The breakdown must use exactly computeComposite's arithmetic, so the
// displayed contributions add up to the composite actually saved.
const { computeCompositeBreakdown, computeComposite } = evalInScope(
  extractFunctions('computeCompositeBreakdown', 'computeComposite'), {}
);

const ALL = [
  { id: 'fng', label: 'Fear & Greed', weight: 14, confidence: 1.0 },
  { id: 'funding', label: 'Funding', weight: 15, confidence: 1.0 },
  { id: 'longshort', label: 'Long/Short', weight: 10, confidence: 0.5 },
  { id: 'foufi', label: 'Foufi', weight: 6, confidence: 0.4 },
];
const act = (id, score, extra = {}) => ({ ...ALL.find(s => s.id === id), baseWeight: ALL.find(s => s.id === id).weight, value: { score }, ...extra });

describe('computeCompositeBreakdown', () => {
  it('contributions sum to the same composite computeComposite returns', () => {
    const active = [act('fng', 20), act('funding', 70), act('longshort', 55)];
    const b = computeCompositeBreakdown(active, ALL, {});
    expect(b.composite).toBe(computeComposite(active));
    const effSum = b.rows.reduce((a, r) => a + r.effectiveWeightPct, 0);
    expect(effSum).toBeCloseTo(100, 9);
    const fng = b.rows.find(r => r.id === 'fng');
    expect(fng.effectiveWeightPct).toBeCloseTo(14 / (14 + 15 + 5) * 100, 9);
    expect(fng.direction).toBe('bearish');
    expect(fng.push).toBeCloseTo((20 - 50) * fng.effectiveWeightPct / 100, 9);
  });

  it('failed sources are excluded with their reason, never scored as neutral', () => {
    const b = computeCompositeBreakdown([act('fng', 80), act('funding', 60)], ALL, { foufi: { message: 'digest 41h old (>30h cutoff)' } });
    expect(b.rows.map(r => r.id)).not.toContain('foufi');
    expect(b.missing).toEqual([
      { id: 'longshort', label: 'Long/Short', baseWeight: 10, reason: 'No value this cycle' },
      { id: 'foufi', label: 'Foufi', baseWeight: 6, reason: 'digest 41h old (>30h cutoff)' },
    ]);
    expect(b.completeness).toBeCloseTo(29 / 45, 9);
    expect(b.composite).toBe(computeComposite([act('fng', 80), act('funding', 60)]));
  });

  it('a Foufi driver boost shows the boosted effective weight and keeps the base weight visible', () => {
    const active = [act('fng', 50), act('funding', 50, { weight: 15 * 1.5, driverBoosted: true })];
    const b = computeCompositeBreakdown(active, ALL, {});
    const f = b.rows.find(r => r.id === 'funding');
    expect(f.baseWeight).toBe(15);
    expect(f.driverBoosted).toBe(true);
    expect(f.effectiveWeightPct).toBeCloseTo(22.5 / 36.5 * 100, 9);
    expect(b.completeness).toBeCloseTo(29 / 45, 9);
  });

  it('rows are ordered by how far they push the composite from neutral', () => {
    const b = computeCompositeBreakdown([act('fng', 52), act('funding', 10), act('longshort', 90)], ALL, {});
    expect(b.rows.map(r => r.id)).toEqual(['funding', 'longshort', 'fng']);
  });
});

describe('hloi source wiring', () => {
  const { srcHyperliquidOi } = evalInScope(extractFunctions('srcHyperliquidOi'), {
    PULSE_WORKER_URL: 'https://w', window: {},
    fetch: async () => ({ ok: true, json: async () => globalThis.__hloiResponse }),
  });
  it('returns the server score only when status is OK', async () => {
    globalThis.__hloiResponse = { status: 'OK', score: 61.5 };
    expect(await srcHyperliquidOi()).toEqual({ score: 61.5 });
  });
  it('throws (=excluded, not neutral) for NO_DATA / STALE / INSUFFICIENT_HISTORY', async () => {
    for (const status of ['NO_DATA', 'STALE', 'INSUFFICIENT_HISTORY']) {
      globalThis.__hloiResponse = { status, reason: 'why' };
      await expect(srcHyperliquidOi()).rejects.toThrow(new RegExp(`hl-oi ${status}: why`));
    }
    globalThis.__hloiResponse = { status: 'OK', score: null };
    await expect(srcHyperliquidOi()).rejects.toThrow(/no numeric score/);
  });
});
