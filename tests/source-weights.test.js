import { describe, it, expect } from 'vitest';
import { extractConst, extractFunctions, evalInScope, getFullScriptSource } from './helpers/extract.js';

// Source-weight consistency: the weight shown in Settings is the weight the
// composite uses; unavailable sources (hloi without 24h history) are excluded.
function scope(overrides = {}) {
  return evalInScope(
    [extractConst('COMPOSITE_SOURCES_DEFAULTS'),
     extractFunctions('loadSentimentWeights', 'computeComposite', 'computeCompositeBreakdown', 'sourceWeightTable')].join('\n\n'),
    { localStorage: { getItem: (k) => (k === 'cp2_sentiment_weights' ? JSON.stringify(overrides) : null), setItem() {} } }
  );
}

describe('source registry', () => {
  const { COMPOSITE_SOURCES_DEFAULTS } = scope();
  it('has unique ids, valid weights/confidence, and hloi at its documented 4 / 0.3', () => {
    const ids = COMPOSITE_SOURCES_DEFAULTS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(22);
    for (const s of COMPOSITE_SOURCES_DEFAULTS) {
      expect(s.weight).toBeGreaterThan(0);
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
    expect(COMPOSITE_SOURCES_DEFAULTS.find(s => s.id === 'hloi')).toMatchObject({ weight: 4, confidence: 0.3 });
  });
  it('every configured source has a fetch job in the composite, and no job lacks a configured source', () => {
    const src = getFullScriptSource();
    const fn = src.slice(src.indexOf('async function computeAndSyncCompositeScore'), src.indexOf('const composite=computeComposite(active);'));
    const body = fn.slice(0, fn.indexOf('await Promise.all(jobs.map'));
    const jobIds = [...body.matchAll(/\[\s*'([a-z0-9]+)'\s*,/g)].map(m => m[1]);
    // gold depends on the equities score, so it is computed after the job batch.
    for (const m of fn.matchAll(/sourceValues\.([a-z0-9]+)=await/g)) jobIds.push(m[1]);
    expect(new Set(jobIds)).toEqual(new Set(COMPOSITE_SOURCES_DEFAULTS.map(s => s.id)));
  });
});

describe('displayed weight = calculation weight', () => {
  it('slider share equals the breakdown share when every source answers', () => {
    const s = scope();
    const sources = s.loadSentimentWeights();
    const table = s.sourceWeightTable(sources);
    const active = sources.map(x => ({ ...x, baseWeight: x.weight, value: { score: 60 } }));
    const b = s.computeCompositeBreakdown(active, sources, {});
    for (const r of table) expect(b.rows.find(x => x.id === r.id).effectiveWeightPct).toBeCloseTo(r.effectiveSharePct, 9);
    expect(table.reduce((a, r) => a + r.effectiveSharePct, 0)).toBeCloseTo(100, 9);
    expect(b.composite).toBe(s.computeComposite(active));
  });
  it('a Settings override changes both the displayed share and the calculation; unknown ids are ignored', () => {
    const s = scope({ fng: 0, notasource: 50 });
    const sources = s.loadSentimentWeights();
    expect(sources.find(x => x.id === 'fng').weight).toBe(0);
    expect(sources.some(x => x.id === 'notasource')).toBe(false);
    expect(s.sourceWeightTable(sources).find(r => r.id === 'fng').effectiveSharePct).toBe(0);
  });
});

describe('hloi exclusion', () => {
  it('without hloi the composite and shares are exactly those of the other sources, and hloi is listed as excluded', () => {
    const s = scope();
    const sources = s.loadSentimentWeights();
    const others = sources.filter(x => x.id !== 'hloi').map(x => ({ ...x, baseWeight: x.weight, value: { score: 40 + (x.weight % 30) } }));
    const b = s.computeCompositeBreakdown(others, sources, { hloi: { message: 'hl-oi INSUFFICIENT_HISTORY: need 24h' } });
    expect(b.rows.some(r => r.id === 'hloi')).toBe(false);
    expect(b.missing).toEqual([{ id: 'hloi', label: sources.find(x => x.id === 'hloi').label, baseWeight: 4, reason: 'hl-oi INSUFFICIENT_HISTORY: need 24h' }]);
    expect(b.composite).toBe(s.computeComposite(others));
    const tableWithout = s.sourceWeightTable(sources.filter(x => x.id !== 'hloi'));
    for (const r of tableWithout) expect(b.rows.find(x => x.id === r.id).effectiveWeightPct).toBeCloseTo(r.effectiveSharePct, 9);
    const total = sources.reduce((a, x) => a + x.weight, 0);
    expect(b.completeness).toBeCloseTo((total - 4) / total, 9);
  });
});
