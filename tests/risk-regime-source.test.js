import { describe, it, expect } from 'vitest';
import { extractConst, extractFunctions, evalInScope } from './helpers/extract.js';

// V1 composite source "riskregime" (Risk Regime Shock, rule rrs-v1). Responses below are TEST data.
function fetcher(response, { ok = true, status = 200 } = {}) {
  const window = {};
  const s = evalInScope(extractFunctions('srcRiskRegime'), {
    PULSE_WORKER_URL: 'https://w', window,
    fetch: async (url) => { window.__url = url; return { ok, status, json: async () => response }; },
  });
  return { s, window };
}
const OK = { status: 'OK', score: 36.7, regime: 'RISK_OFF_SHOCK', version: 'rrs-v1', scoring_ts: 1, explanation: 'Risk-off cross-asset shock' };

describe('srcRiskRegime', () => {
  it('returns the server score only when status is OK, and keeps the full reading for display', async () => {
    const { s, window } = fetcher(OK);
    expect(await s.srcRiskRegime()).toEqual({ score: 36.7 });
    expect(window.__lastRiskRegime.regime).toBe('RISK_OFF_SHOCK');
    expect(window.__url).toBe('https://w/risk-regime?history=48');
  });
  it('a calm market is a genuine 50, not missing data', async () => {
    expect(await fetcher({ ...OK, score: 50, regime: 'CALM' }).s.srcRiskRegime()).toEqual({ score: 50 });
  });
  it('throws (= excluded, never neutral) for every non-OK status, HTTP errors and invalid scores', async () => {
    for (const status of ['MARKETS_CLOSED', 'INSUFFICIENT_DATA', 'STALE', 'NO_DATA']) {
      await expect(fetcher({ status, reason: 'why' }).s.srcRiskRegime()).rejects.toThrow(new RegExp(`risk-regime ${status}: why`));
    }
    await expect(fetcher({}, { ok: false, status: 500 }).s.srcRiskRegime()).rejects.toThrow(/HTTP 500/);
    for (const score of [null, NaN, -1, 101, '60']) {
      await expect(fetcher({ ...OK, score }).s.srcRiskRegime()).rejects.toThrow(/no valid score/);
    }
  });
});

// Settings persistence for weight AND confidence, through the same localStorage keys the page uses.
function settingsScope(store = {}) {
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const s = evalInScope([extractConst('COMPOSITE_SOURCES_DEFAULTS'),
    extractFunctions('validConfidence', 'loadSentimentWeights', 'saveSentimentWeight', 'saveSentimentConfidence', 'computeComposite', 'computeCompositeBreakdown', 'sourceWeightTable')].join('\n\n'),
  { localStorage });
  return { s, store };
}

describe('riskregime in the composite (weight x confidence, renormalised)', () => {
  it('contributes exactly weight x confidence over the total of the sources that answered', () => {
    const { s } = settingsScope();
    const sources = s.loadSentimentWeights();
    const rr = sources.find(x => x.id === 'riskregime');
    expect(rr).toMatchObject({ weight: 4, confidence: 0.3 });
    const active = sources.map(x => ({ ...x, baseWeight: x.weight, value: { score: x.id === 'riskregime' ? 20 : 60 } }));
    const b = s.computeCompositeBreakdown(active, sources, {});
    const total = sources.reduce((a, x) => a + x.weight * x.confidence, 0);
    const row = b.rows.find(r => r.id === 'riskregime');
    expect(row.effectiveWeightPct).toBeCloseTo(4 * 0.3 / total * 100, 9);
    expect(row.contribution).toBeCloseTo(20 * 4 * 0.3 / total, 9);
    expect(row.push).toBeCloseTo((20 - 50) * 4 * 0.3 / total, 9);
    // It is in the real arithmetic: all else at 60, riskregime at 20 pulls the unrounded composite below 60
    // by its share. At the default 4 x 0.3 (~0.8 %) that is ~0.3 pts, which the integer composite rounds away.
    const unrounded = b.rows.reduce((a, r) => a + r.contribution, 0);
    expect(unrounded).toBeCloseTo(60 - 40 * 4 * 0.3 / total, 9);
    expect(b.composite).toBe(s.computeComposite(active));
    expect(s.computeComposite(active.filter(x => x.id !== 'riskregime'))).toBe(60);
    // Raised in Settings, the same calculation moves the displayed composite.
    const heavy = active.map(x => (x.id === 'riskregime' ? { ...x, weight: 60, confidence: 1 } : x));
    expect(s.computeComposite(heavy)).toBeLessThan(60);
  });
  it('when unavailable it is excluded with its reason and the others are renormalised, never scored 50', () => {
    const { s } = settingsScope();
    const sources = s.loadSentimentWeights();
    const others = sources.filter(x => x.id !== 'riskregime').map(x => ({ ...x, baseWeight: x.weight, value: { score: 40 + (x.weight % 30) } }));
    const b = s.computeCompositeBreakdown(others, sources, { riskregime: { message: 'risk-regime MARKETS_CLOSED: shut' } });
    expect(b.rows.some(r => r.id === 'riskregime')).toBe(false);
    expect(b.missing).toEqual([{ id: 'riskregime', label: sources.find(x => x.id === 'riskregime').label, baseWeight: 4, reason: 'risk-regime MARKETS_CLOSED: shut' }]);
    expect(b.composite).toBe(s.computeComposite(others));
    expect(b.rows.reduce((a, r) => a + r.effectiveWeightPct, 0)).toBeCloseTo(100, 9);
  });
});

describe('settings: independent weight and confidence, rollback', () => {
  it('changing riskregime weight or confidence never rewrites another source or the other key', () => {
    const { s, store } = settingsScope({ cp2_sentiment_weights: JSON.stringify({ fng: 20 }) });
    const before = s.loadSentimentWeights().filter(x => x.id !== 'riskregime');
    s.saveSentimentWeight('riskregime', 7);
    expect(s.saveSentimentConfidence('riskregime', 0.5)).toBe(true);
    expect(JSON.parse(store.cp2_sentiment_weights)).toEqual({ fng: 20, riskregime: 7 });
    expect(JSON.parse(store.cp2_sentiment_confidence)).toEqual({ riskregime: 0.5 });
    const after = s.loadSentimentWeights();
    expect(after.find(x => x.id === 'riskregime')).toMatchObject({ weight: 7, confidence: 0.5 });
    expect(after.filter(x => x.id !== 'riskregime')).toEqual(before);
  });
  it('rejects invalid confidence and drops an override equal to the default', () => {
    const { s, store } = settingsScope();
    for (const v of [0, -0.1, 1.5, NaN, '0.5']) expect(s.saveSentimentConfidence('riskregime', v)).toBe(false);
    expect(s.saveSentimentConfidence('notasource', 0.5)).toBe(false);
    expect(store.cp2_sentiment_confidence).toBeUndefined();
    s.saveSentimentConfidence('riskregime', 0.6); s.saveSentimentConfidence('riskregime', 0.3);
    expect(JSON.parse(store.cp2_sentiment_confidence)).toEqual({});
    // A corrupted stored value falls back to the default.
    const { s: s2 } = settingsScope({ cp2_sentiment_confidence: JSON.stringify({ riskregime: 7, fng: 'x' }) });
    expect(s2.loadSentimentWeights().find(x => x.id === 'riskregime').confidence).toBe(0.3);
    expect(s2.loadSentimentWeights().find(x => x.id === 'fng').confidence).toBe(1.0);
  });
  it('disable = weight 0 (share 0, others renormalised); Reset to defaults clears both keys', () => {
    const { s, store } = settingsScope();
    s.saveSentimentWeight('riskregime', 0);
    const t = s.sourceWeightTable(s.loadSentimentWeights());
    expect(t.find(r => r.id === 'riskregime').effectiveSharePct).toBe(0);
    expect(t.reduce((a, r) => a + r.effectiveSharePct, 0)).toBeCloseTo(100, 9);
    store.cp2_sentiment_confidence = JSON.stringify({ riskregime: 0.9 });
    // resetSentimentWeights is DOM-bound; its storage effect is exactly these two removals.
    const reset = evalInScope(extractFunctions('resetSentimentWeights'), {
      localStorage: { removeItem: (k) => { delete store[k]; } }, loadSentimentWeights: () => [], renderSentimentWeightControls: () => {}, COMPOSITE_SOURCES: [],
    });
    reset.resetSentimentWeights();
    expect(store.cp2_sentiment_weights).toBeUndefined();
    expect(store.cp2_sentiment_confidence).toBeUndefined();
    expect(s.loadSentimentWeights().find(x => x.id === 'riskregime')).toMatchObject({ weight: 4, confidence: 0.3 });
  });
});

// Source / Now / Corr table: riskregime renders like any other source, with its explanation in the detail panel.
function render(latestSources, { errors = {}, reading = null, perSource = {} } = {}) {
  const host = { innerHTML: '' }, status = { textContent: '' };
  const window = { __sourceErrors: errors, __lastCompositeBreakdown: null, __lastPulseHistoryTs: Date.now() - 600000, __lastRiskRegime: reading };
  const scope = evalInScope(
    [extractConst('CORR_MIN_RELIABLE_SAMPLES'), extractConst('SOURCE_STALE_MS'), extractConst('escHtml'), extractConst('SOURCE_DETAIL_EXTRA'),
     extractFunctions('sourceRowState', 'sourceDetailHtml', 'renderPulseAnalysis')].join('\n\n'),
    { window, localStorage: { getItem: () => null },
      $: (sel) => (sel === '#pulseCorrelationBody' ? host : sel === '#pulseAnalysisStatus' ? status : null),
      setHealthDot: () => {}, pulseLabelFor: (v) => ({ color: '#fff', text: v < 40 ? 'Bear' : 'Neutral' }), pulseAnalysisExpanded: {},
      COMPOSITE_SOURCES: [{ id: 'onchain', weight: 8, confidence: 0.5 }, { id: 'riskregime', weight: 4, confidence: 0.3 }] });
  scope.renderPulseAnalysis({ pointsTotal: 500, compositeSamples: 480, compositeCorrelation: 0.1, lagHours: 24, interpretation: 'i',
    perSourceCorrelation: { onchain: { correlation: -0.11, samples: 480 }, ...perSource } }, undefined, undefined, latestSources);
  return host.innerHTML;
}
const READING = { ...OK, counts: { breadth_abnormal: 3, breadth_measurable: 7, risk_off_votes: 3, risk_on_votes: 0 },
  inputs: [{ label: 'S&P 500', status: 'OK', ret_6h: -1.2, pct_6h: 2.4, vote: 'risk_off', abnormal: 'down', last_close_ts: 1 },
    { label: 'Gold', status: 'OK', ret_6h: 0.1, pct_6h: 50, vote: null, abnormal: null, last_close_ts: 1 },
    { label: 'US 10Y yield', status: 'STALE', last_close_ts: 1 }],
  history: [{ ts: 1, status: 'OK', score: 50 }, { ts: 2, status: 'MARKETS_CLOSED', score: null }, { ts: 3, status: 'OK', score: 36.7 }] };

describe('riskregime source row and detail', () => {
  it('a scored reading shows a normal gauge row with the explanation and principal indicators in its detail', () => {
    const h = render({ onchain: 83, riskregime: 37 }, { reading: READING, perSource: { riskregime: { correlation: 0.05, samples: 12 } } });
    const start = h.indexOf('>riskregime<');
    expect(start).toBeGreaterThan(0);
    const row = h.slice(start);
    expect(row).toContain('<svg'); // same gauge as other sources
    expect(row).toContain('Risk-off cross-asset shock');
    expect(row).toContain('S&amp;P 500');
    expect(row).toContain('risk-off');
    expect(row).toContain('US 10Y yield');
    expect(row).toContain('STALE');
    expect(row).not.toContain('>Gold<'); // only principal (abnormal / rejected) indicators are listed
    expect(row).toContain('rrs-v1');
    expect(row).toContain('Last 3h: 2 scored, 1 unavailable');
  });
  it('while unavailable (no history yet) it is a row marked Unavailable with its reason, never a score', () => {
    const reading = { status: 'MARKETS_CLOSED', reason: 'Underlying markets are shut', version: 'rrs-v1' };
    const h = render({ onchain: 83 }, { errors: { riskregime: { message: 'risk-regime MARKETS_CLOSED: Underlying markets are shut' } }, reading });
    const row = h.slice(h.indexOf('>riskregime<'));
    expect(row).toContain('Unavailable');
    expect(row).not.toContain('<svg');
    expect(row).toContain('MARKETS_CLOSED');
    expect(row).not.toMatch(/>\s*50\s*</);
  });
  it('escapes provider text', () => {
    const h = render({ riskregime: 50 }, { reading: { ...READING, explanation: '<img src=x onerror=alert(1)>' }, perSource: { riskregime: { correlation: 0, samples: 3 } } });
    expect(h).not.toContain('<img src=x');
  });
});
