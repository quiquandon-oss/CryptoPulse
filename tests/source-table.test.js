import { describe, it, expect } from 'vitest';
import { extractConst, extractFunctions, evalInScope } from './helpers/extract.js';

// Source / Now / Corr table: existing rows unchanged; configured sources with
// no history (hloi) shown as collecting, never with a score; tap details.
function render(analysis, latestSources, { errors = {}, breakdown = null } = {}) {
  const host = { innerHTML: '' }, status = { textContent: '' };
  const window = { __sourceErrors: errors, __lastCompositeBreakdown: breakdown, __lastPulseHistoryTs: Date.now() - 600000 };
  const scope = evalInScope(
    [extractConst('CORR_MIN_RELIABLE_SAMPLES'), extractConst('SOURCE_STALE_MS'),
     extractFunctions('sourceRowState', 'sourceDetailHtml', 'renderPulseAnalysis')].join('\n\n'),
    {
      window, localStorage: { getItem: () => null },
      $: (sel) => (sel === '#pulseCorrelationBody' ? host : sel === '#pulseAnalysisStatus' ? status : null),
      setHealthDot: () => {}, pulseLabelFor: () => ({ color: '#fff' }), pulseAnalysisExpanded: {},
      COMPOSITE_SOURCES: [{ id: 'onchain', weight: 8, confidence: 0.5 }, { id: 'funding', weight: 15, confidence: 1 }, { id: 'hloi', weight: 4, confidence: 0.3 }],
    }
  );
  scope.renderPulseAnalysis(analysis, undefined, undefined, latestSources);
  return host.innerHTML;
}
const ANALYSIS = { pointsTotal: 500, compositeSamples: 480, compositeCorrelation: 0.1, lagHours: 24, interpretation: 'interp',
  perSourceCorrelation: { onchain: { correlation: -0.11, samples: 480 }, funding: { correlation: -0.02, samples: 12 } } };

describe('Source / Now / Corr table', () => {
  it('keeps the existing gauge rows with their values and correlations', () => {
    const h = render(ANALYSIS, { onchain: 83, funding: 36 });
    expect(h).toContain('>onchain<');
    expect(h).toContain('-0.11');
    expect((h.match(/<linearGradient/g) || []).length).toBe(2); // one gauge per source with history
  });
  it('adds hloi as a Collecting row with no score and no gauge while history is insufficient', () => {
    const h = render(ANALYSIS, { onchain: 83, funding: 36 }, { errors: { hloi: { message: 'hl-oi INSUFFICIENT_HISTORY: need 24h' } } });
    const start = h.indexOf("toggleSourceDetail('srcDetail_pulseCorrelationBody_1000')");
    const hloiRow = h.slice(start, h.indexOf('id="srcDetail_pulseCorrelationBody_1000"'));
    expect(hloiRow).toContain('>hloi<');
    expect(hloiRow).not.toContain('<svg');
    expect(hloiRow).toContain('Collecting');
    expect(hloiRow).not.toMatch(/>\s*50\s*</);
    expect(h).toContain('Collecting — not enough history yet');
  });
  it('marks a source without a value and a non-history error as Unavailable', () => {
    const h = render(ANALYSIS, { onchain: 83, funding: 36 }, { errors: { hloi: { message: 'hl-oi HTTP 500' } } });
    expect(h).toContain('Unavailable');
  });
  it('flags low-sample correlations and states correlation is not proof of prediction', () => {
    const h = render(ANALYSIS, { onchain: 83, funding: 36 });
    expect(h).toContain('-0.02*');
    expect(h).toContain('12 point(s), 24h lag — too few to rely on');
    expect(h).toContain('not proof of predictive value');
  });
  it('details show configured weight and the actual breakdown contribution', () => {
    const breakdown = { ts: Date.now(), rows: [{ id: 'onchain', contribution: 3.2, push: 1.4, effectiveWeightPct: 3.9 }], missing: [{ id: 'hloi' }] };
    const h = render(ANALYSIS, { onchain: 83, funding: 36 }, { breakdown });
    expect(h).toContain('8 × confidence 0.5');
    expect(h).toContain('3.2 pts (+1.4 vs 50) · 3.9% weight');
    expect(h).toContain('excluded (weight redistributed, not counted as neutral)');
  });
});
