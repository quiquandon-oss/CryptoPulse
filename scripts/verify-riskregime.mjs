// Post-deploy verification of the "riskregime" (Risk Regime Shock) V1 source, run by
// .github/workflows/verify-riskregime.yml after a Pages deploy. Read-only: it calls the live
// Pulse Worker GET endpoints and loads the deployed app in headless Chrome with the composite's
// POST /history blocked, so verification never writes a history row. Prints facts; exits 1 if a
// deployed piece is missing.
import { chromium } from 'playwright-core';

const WORKER = 'https://sentiment-ff75.quiquandon.workers.dev';
const SITE = process.env.SITE_URL;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };

async function getJson(path) {
  const r = await fetch(WORKER + path, { cache: 'no-store' });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// 1. Worker: the source endpoint and its data contract.
const rr = await getJson('/risk-regime?history=24');
const b = rr.body || {};
console.log('GET /risk-regime ->', rr.status, JSON.stringify({ status: b.status, version: b.version, score: b.score, regime: b.regime,
  scoring_ts: b.scoring_ts && new Date(b.scoring_ts).toISOString(), explanation: b.explanation, reason: b.reason, counts: b.counts,
  inputs: (b.inputs || []).map(i => `${i.symbol}:${i.status}${i.abnormal ? ':' + i.abnormal : ''}`), history_hours: (b.history || []).length }));
check(rr.status === 200 && b.source === 'riskregime' && b.version === 'rrs-v1', 'worker serves /risk-regime with source riskregime, version rrs-v1');
check(['OK', 'MARKETS_CLOSED', 'INSUFFICIENT_DATA', 'STALE', 'NO_DATA'].includes(b.status), `status is a documented value (${b.status})`);
check(b.status !== 'OK' || (Number.isFinite(b.score) && b.score >= 0 && b.score <= 100 && Array.isArray(b.inputs) && b.inputs.length === 8),
  'an OK reading has a 0-100 score and all 8 inputs with their own status');
check(b.status === 'OK' || b.score === undefined, 'a non-OK reading carries no score (never a neutral 50)');
const wa = await getJson('/weight-adaptation');
console.log('GET /weight-adaptation -> defaults_version', wa.body && wa.body.defaults_version, 'riskregime', JSON.stringify(wa.body && wa.body.defaults && wa.body.defaults.riskregime));
check(wa.body && wa.body.defaults_version === '2026-10-12-riskregime' && JSON.stringify(wa.body.defaults.riskregime) === '[4,0.3]',
  'worker shadow-adaptation defaults include riskregime 4 x 0.3 (version 2026-10-12-riskregime)');

// 2. Deployed frontend: real composite cycle in a browser.
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
let blockedPosts = 0;
await page.route('**/history', (route) => {
  if (route.request().method() === 'POST') { blockedPosts++; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"verification":"not stored"}' }); }
  return route.continue();
});
await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof setView === 'function' && typeof COMPOSITE_SOURCES !== 'undefined', null, { timeout: 60000 });
const cfg = await page.evaluate(() => ({ version: COMPOSITE_WEIGHTS_VERSION, rr: COMPOSITE_SOURCES.find(s => s.id === 'riskregime'), n: COMPOSITE_SOURCES.length }));
console.log('deployed page config ->', JSON.stringify(cfg));
check(cfg.version === '2026-10-12-riskregime' && cfg.rr && cfg.rr.weight === 4 && cfg.rr.confidence === 0.3, 'deployed page defines riskregime 4 x 0.3 at weights version 2026-10-12-riskregime');
await page.evaluate(() => setView('sentiment'));
await page.waitForFunction(() => window.__lastCompositeBreakdown && window.__lastCompositeBreakdown.ts, null, { timeout: 180000 });
await page.waitForTimeout(3000);
const live = await page.evaluate(() => {
  const bd = window.__lastCompositeBreakdown;
  const row = bd.rows.find(r => r.id === 'riskregime');
  const miss = (bd.missing || []).find(m => m.id === 'riskregime');
  const unrounded = bd.rows.reduce((a, r) => a + r.contribution, 0);
  const rrRow = row ? row.contribution : 0, rrShare = row ? row.effectiveWeightPct / 100 : 0;
  const without = row ? (unrounded - rrRow) / (1 - rrShare) : unrounded;
  // Adjustability: the same weight x confidence arithmetic with riskregime at weight 40 x confidence 1.
  let heavy = null;
  if (row) {
    const rrCw = row.baseWeight * row.confidence, total = rrCw / (row.effectiveWeightPct / 100);
    const num = bd.rows.reduce((a, r) => a + r.score * r.effectiveWeightPct / 100 * total, 0) - row.score * rrCw + row.score * 40;
    heavy = Math.round(num / (total - rrCw + 40) * 1000) / 1000;
  }
  const tableHtml = (document.getElementById('pulseCorrelationBody') || {}).innerHTML || '';
  return { composite: bd.composite, unrounded: Math.round(unrounded * 1000) / 1000, without_riskregime: Math.round(without * 1000) / 1000,
    row: row ? { score: row.score, effectiveWeightPct: row.effectiveWeightPct, contribution: row.contribution, push: row.push } : null,
    missing: miss || null, sources_answered: bd.rows.length, heavy_composite_if_weight40_conf1: heavy, tableHasRow: tableHtml.includes('>riskregime<'),
    reading: window.__lastRiskRegime ? { status: window.__lastRiskRegime.status, score: window.__lastRiskRegime.score } : null };
});
console.log('live composite ->', JSON.stringify(live));
console.log('blocked history POSTs (not stored):', blockedPosts);
check(!!live.row || !!live.missing, 'riskregime is either in the live composite or listed as excluded with its reason');
check(!live.row || (live.reading && live.reading.status === 'OK' && live.row.score === live.reading.score), 'an included riskregime uses the worker\'s OK score');
check(!live.missing || (live.reading && live.reading.status !== 'OK'), 'an excluded riskregime corresponds to a non-OK worker status');
check(live.tableHasRow, 'the Source / Now / Corr table has a riskregime row');
await browser.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
