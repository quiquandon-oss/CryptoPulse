import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractConst, extractFunctions, evalInScope } from './helpers/extract.js';

// V1 source UI: Event Detection panel (display only). Payloads below are TEST data shaped like Pulse Worker V2's
// /api/events/health and /api/events responses.
const NOW = Date.UTC(2026, 9, 17, 13, 0);
const H = 3600_000;
function scope() {
  return evalInScope([
    extractConst('EVENT_STATUS_STYLE'), extractConst('EVENT_SEVERITY_COLOR'),
    extractFunctions('fmtAgeMs', 'eventDetectionView', 'detectorRow', 'renderEventDetection', 'emptyEventsMessage'),
  ].join('\n\n'), { escHtml: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) });
}
const HEALTH = {
  ok: true, available: true, enabled: true,
  detectors: [
    { id: 'okx_liquidations', label: 'OKX BTC-USDT perpetual liquidations', status: 'OK', last_success_ts: NOW - H, last_observation_ts: NOW - 20 * 60_000, coverage: 'single venue' },
    { id: 'deribit_options', label: 'Deribit DVOL and options open interest', status: 'INSUFFICIENT_BASELINE', last_success_ts: NOW - H, last_observation_ts: NOW - H, coverage: 'Deribit only' },
    { id: 'sec_edgar', label: 'SEC EDGAR filings', status: 'NOT_CONFIGURED', last_success_ts: null, last_observation_ts: null },
    { id: 'binance_liquidation_sample', label: 'Binance (sampled)', status: 'DISABLED' },
  ],
};
const EVENTS = {
  ok: true, available: true, events: [
    { event_id: 'ev_1', event_type: 'LIQUIDATION_BURST', asset: 'BTC', market: 'BTC-USDT-SWAP', source: 'okx_liquidations', severity: 'HIGH', direction: 'DOWN', confidence: 0.62, detected_ts: NOW - 2 * H, source_ts: NOW - 2.5 * H, freshness_ms: 0.5 * H, explanation: 'Liquidations <b>spiked</b>', source_url: 'https://www.okx.com/x', status: 'ACTIVE', rule_id: 'ed-liq-burst-v1', rule_version: 'ed-v1', evidence: [] },
    { event_id: 'ev_2', event_type: 'YIELD_SHOCK', asset: 'US_RATES', source: 'macro_fred', severity: 'LOW', direction: 'UNKNOWN', confidence: null, detected_ts: NOW - 50 * H, source_ts: NOW - 60 * H, freshness_ms: 10 * H, explanation: 'x', status: 'EXPIRED', rule_id: 'ed-yield-shock-v1', evidence: [] },
  ],
};

describe('eventDetectionView', () => {
  it('maps detectors and events; severity, confidence and direction stay separate fields', () => {
    const v = scope().eventDetectionView(HEALTH, EVENTS, NOW);
    expect(v.state).toBe('available');
    expect(v.detectors.map((d) => d.statusLabel)).toEqual(['OK', 'Collecting baseline', 'Not configured', 'Disabled']);
    expect(v.detectors[2].lastSuccess).toBe('never');
    expect(v.events[0]).toMatchObject({ type: 'LIQUIDATION_BURST', severity: 'HIGH', direction: 'DOWN', confidence: 0.62, age: '2 h', dataAge: '30 min', expired: false });
    expect(v.events[1]).toMatchObject({ direction: 'UNKNOWN', confidence: null, expired: true });
    expect(v.summary).toBe('1 active event · 1/4 detectors OK');
  });
  it('explicit states for not deployed (404), tables missing (503 available:false) and network errors', () => {
    const s = scope();
    expect(s.eventDetectionView({ __http: 404 }, null, NOW).state).toBe('not_deployed');
    const missing = s.eventDetectionView({ ok: false, available: false, error: 'Event detection tables are not present (migration 0023 not applied).', detectors: [{ id: 'a', label: 'A', status: 'NEVER_RUN' }] }, { ok: false, available: false }, NOW);
    expect(missing).toMatchObject({ state: 'tables_missing', events: [] });
    expect(missing.detectors[0].statusLabel).toBe('Never run');
    expect(s.eventDetectionView({ __error: 'Failed to fetch' }, null, NOW)).toMatchObject({ state: 'error', message: expect.stringContaining('Failed to fetch') });
  });
});

describe('renderEventDetection', () => {
  it('escapes provider text, links evidence, and flags expired events and switched-off scheduling', () => {
    const s = scope();
    const html = s.renderEventDetection(s.eventDetectionView({ ...HEALTH, enabled: false }, EVENTS, NOW));
    expect(html).toContain('Liquidations &lt;b&gt;spiked&lt;/b&gt;');
    expect(html).not.toContain('<b>spiked</b>');
    expect(html).toContain('href="https://www.okx.com/x"');
    expect(html).toContain('direction DOWN');
    expect(html).toContain('confidence 62%');
    expect(html).toContain('expired');
    expect(html).toContain('EVENT_DETECTION_ENABLED not set');
    expect(html).toContain('Collecting baseline');
    expect(html).not.toContain('text-[9px]');
  });
  it('never renders an unavailable panel as a neutral or empty-OK state', () => {
    const s = scope();
    const html = s.renderEventDetection(s.eventDetectionView({ __http: 404 }, null, NOW));
    expect(html).toMatch(/not deployed/);
    expect(html).not.toMatch(/No events detected/);
  });
});

describe('empty states: no events vs nothing could detect', () => {
  const s = scope();
  const render = (detectors) => s.renderEventDetection(s.eventDetectionView({ ...HEALTH, detectors }, { ok: true, available: true, events: [] }, NOW));
  it('never-run detectors are not presented as "no events"', () => {
    const html = render([{ id: 'a', label: 'A', status: 'NEVER_RUN' }, { id: 'b', label: 'B', status: 'DISABLED' }]);
    expect(html).toContain('No detector has completed a successful run yet');
    expect(html).not.toContain('No events detected');
  });
  it('names detectors that are collecting a baseline or failing alongside "no events"', () => {
    const html = render([
      { id: 'a', label: 'A', status: 'OK', last_success_ts: NOW - H, last_observation_ts: NOW - H },
      { id: 'b', label: 'B', status: 'INSUFFICIENT_BASELINE', last_success_ts: NOW - H },
      { id: 'c', label: 'C', status: 'BLOCKED_BY_PROVIDER', last_success_ts: null },
    ]);
    expect(html).toContain('No events detected in the last 7 days by the detectors that ran.');
    expect(html).toContain('1 detector is still collecting the history needed to detect anything');
    expect(html).toContain('1 detector is stale or failing');
    expect(html).toContain('Blocked by provider');
  });
  it('a clean "no events" when every detector ran and is OK', () => {
    const html = render([{ id: 'a', label: 'A', status: 'OK', last_success_ts: NOW - H, last_observation_ts: NOW - H }]);
    expect(html).toContain('No events detected in the last 7 days by the detectors that ran.</p>');
  });
});

describe('separation from the V1 composite', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
  it('the composite source list, weights version and computeComposite never reference event detection', () => {
    const sources = extractConst('COMPOSITE_SOURCES_DEFAULTS');
    expect(sources).not.toMatch(/event/i);
    expect(extractConst('COMPOSITE_WEIGHTS_VERSION')).toContain("'2026-10-12-riskregime'");
    expect(extractFunctions('computeComposite', 'computeCompositeBreakdown')).not.toMatch(/event/i);
  });
  it('the panel is on the Sentiment tab, after the composite breakdown, and loads with the tab', () => {
    const i = html.indexOf('id="compositeBreakdownBody"'), j = html.indexOf('id="eventDetectionBody"');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(html).toContain("if(v==='sentiment'){initSentimentTab();loadHypeFunding();loadEventDetection();}");
    expect(extractConst('EVENT_DETECTION_URL')).toContain('https://pulseworker-v2.quiquandon.workers.dev');
  });
});
