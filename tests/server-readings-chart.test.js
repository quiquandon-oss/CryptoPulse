import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions, evalInScope } from './helpers/extract.js';

// Hourly server-side composite on the combined history chart: its own labelled line (never merged into Sentiment),
// below-floor and invalid readings dropped, absent until the endpoint answers, and never a /history write.
const H = 3600000, D = 24 * H;
const NOW = Date.UTC(2026, 10, 16, 20);
function build(history, server) {
  const scope = evalInScope(extractFunctions('bucketHistoryByDate', 'usableServerReadings', 'buildCombinedChartConfig'), {
    pulseRange: '30D', pulseServerReadings: server, loadCombinedWeight: () => 0.5,
    computeTechnicalScoreSeries: () => ({}), computeCombinedScore: (s) => s, linearRegressionFit: () => null,
    Date: class extends Date { static now() { return NOW; } },
  });
  return scope.buildCombinedChartConfig(history, null, false);
}
const ds = (cfg, label) => cfg.data.datasets.find((d) => d.label === label);

describe('Sentiment (server, hourly) line', () => {
  const history = [{ ts: NOW - 3 * D, score: 40, btc: 70000 }, { ts: NOW - D, score: 44, btc: 71000 }];
  const server = [
    { ts: NOW - 3 * D + 2 * H, score: 38 }, { ts: NOW - 2 * D, score: 36 }, { ts: NOW - 2 * D + H, score: 37 },
    { ts: NOW - D + H, score: 20, below_floor: true }, { ts: NOW - H, score: 41 }, { ts: NOW, score: 'x' },
  ];
  it('is a separate dataset with one point per day (last valid reading), Sentiment unchanged', () => {
    const cfg = build(history, server);
    const labels = cfg.data.labels;
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    expect(labels).toEqual([day(NOW - 3 * D), day(NOW - 2 * D), day(NOW - D), day(NOW)]);
    expect(ds(cfg, 'Sentiment').data).toEqual([40, null, 44, null]);
    // day -1 has only a below-floor reading (dropped); today's 'x' is dropped, 19:00 kept
    expect(ds(cfg, 'Sentiment (server, hourly)').data).toEqual([38, 37, null, 41]);
    expect(ds(cfg, 'Sentiment (server, hourly)').hidden).toBe(false);
  });
  it('is hidden and empty while readings are not loaded or the endpoint is unavailable', () => {
    const cfg = build(history, null);
    expect(ds(cfg, 'Sentiment (server, hourly)').data.every((v) => v === null)).toBe(true);
    expect(ds(cfg, 'Sentiment (server, hourly)').hidden).toBe(true);
    expect(ds(cfg, 'Sentiment').data).toEqual([40, 44]);
  });
  it('only reads the Pulse endpoint; never posts server readings to /history', () => {
    const src = extractFunctions('fetchServerReadings', 'loadServerReadingsIntoChart');
    expect(src).toMatch(/\/server-composite\/readings\?hours=/);
    expect(src).not.toMatch(/method\s*:\s*['"]POST/);
    expect(src).not.toMatch(/\/history/);
    expect(readFileSync(new URL('../index.html', import.meta.url), 'utf8')).toMatch(/id="pulseServerMeta"/);
  });
});
