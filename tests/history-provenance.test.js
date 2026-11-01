import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions, evalInScope } from './helpers/extract.js';

// Provenance sent with each composite (PulseWorker HISTORY_PROVENANCE, formula v1-composite-1).
const S = evalInScope(
  "const COMPOSITE_WEIGHTS_VERSION = 'test-v'; const HISTORY_FORMULA_VERSION = 'v1-composite-1';\n" +
  extractFunctions('buildCompositeProvenance', 'sourceObservedAt', 'computeComposite', 'historyWriteHeaders'), {});

const ALL = [
  { id: 'fng', label: 'Fear & Greed', weight: 14, confidence: 1.0 },
  { id: 'funding', label: 'Funding', weight: 15, confidence: 1.0 },
  { id: 'regulatory', label: 'Regulatory', weight: 6, confidence: 0.5 },
  { id: 'foufi', label: 'Foufi', weight: 6, confidence: 0.4 },
];
const act = (id, score, { boost = 1, value = {} } = {}) => {
  const s = ALL.find((x) => x.id === id);
  return { ...s, baseWeight: s.weight, weight: s.weight * boost, value: { score, ...value }, driverBoosted: boost !== 1 };
};
const T = Date.UTC(2026, 10, 1, 12);

describe('buildCompositeProvenance', () => {
  const active = [act('fng', 22, { value: { ts: T - 5000 } }), act('funding', 50), act('regulatory', 80, { boost: 1.5 })];
  const p = S.buildCompositeProvenance(active, ALL, { foufi: { message: 'digest 41h old' } }, T, ['fng']);

  it('records base weight, boost factor, confidence and observation time (null when unknown)', () => {
    expect(p.formula_version).toBe('v1-composite-1');
    expect(p.sources).toEqual([
      { id: 'fng', score: 22, base_weight: 14, confidence: 1, boost: 1, observed_at: T - 5000 },
      { id: 'funding', score: 50, base_weight: 15, confidence: 1, boost: 1, observed_at: null },
      { id: 'regulatory', score: 80, base_weight: 6, confidence: 0.5, boost: 1.5, observed_at: null },
    ]);
    expect(p.weights_overridden).toEqual(['fng']);
    expect(p.weights_version).toBe('test-v');
  });
  it('lists every missing source with its reason, never as a neutral score', () => {
    expect(p.missing).toEqual([{ id: 'foufi', base_weight: 6, reason: 'digest 41h old' }]);
    expect(p.completeness).toBeCloseTo(35 / 41, 9);
  });
  it('ignores timestamps that are not epoch milliseconds', () => {
    expect(S.sourceObservedAt({ ts: 1793500000 })).toBeNull();         // seconds, not ms
    expect(S.sourceObservedAt({ asOf: '2026-11-01' })).toBeNull();
    expect(S.sourceObservedAt({ observedAt: T })).toBe(T);
  });

  it('is accepted by the Worker and reproduces the browser composite (when the PulseWorker checkout is present)', () => {
    let src; try { src = readFileSync(new URL('../../PulseWorker/worker.js', import.meta.url), 'utf8'); } catch { return; }
    if (!src.includes('function normalizeProvenance(')) return;      // Worker branch without provenance
    const grab = (name) => { const i = src.indexOf(`function ${name}(`); let d = 0, j = src.indexOf('{', i);
      for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
    const constLine = (name) => src.slice(src.indexOf(`const ${name} =`), src.indexOf(';', src.indexOf(`const ${name} =`)) + 1);
    const W = new Function(`${constLine('V1_COMPOSITE_FORMULA')}\n${constLine('PROVENANCE_ID_RE')}\n${constLine('finiteIn')}\n` +
      `${grab('normalizeProvenance')}\n${grab('recomputeComposite')}\nreturn { normalizeProvenance, recomputeComposite };`)();
    const n = W.normalizeProvenance(JSON.parse(JSON.stringify(p)));
    expect(n.ok).toBe(true);
    expect(Math.round(W.recomputeComposite(n.value.sources))).toBe(S.computeComposite(active));
  });
});

describe('historyWriteHeaders', () => {
  it('adds X-History-Token only when this device has one', () => {
    const store = {};
    globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
    expect(S.historyWriteHeaders()).toEqual({ 'Content-Type': 'application/json' });
    store.cp_history_write_token = 'abc';
    expect(S.historyWriteHeaders()['X-History-Token']).toBe('abc');
    delete globalThis.localStorage;
  });
});

describe('index.html wiring', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  it('the history POST sends provenance, an idempotency key and the token headers', () => {
    const i = html.indexOf('`${PULSE_WORKER_URL}/history`,{\n        method:\'POST\'');
    const block = html.slice(i, i + 3000);
    expect(block).toContain('headers:historyWriteHeaders()');
    expect(block).toContain('provenance,idempotencyKey:`cp:${computedAt}:${composite}`');
  });
  it('a skipped low-completeness reading is recorded as provenance only', () => {
    expect(html).toContain("provenanceOnly:true,skipReason:'low_completeness'");
  });
  it('the token is never hard-coded in the page', () => {
    expect(html).not.toMatch(/X-History-Token['"]?\s*:\s*['"][^'"]/);
  });
});
