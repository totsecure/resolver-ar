/* lighthouse.spec.js — performance y accesibilidad del panel con Lighthouse.
 * Corre dentro de Playwright contra el server aislado de :3002.
 * Accesibilidad es un gate (>=90). Performance se reporta; si baja, se listan
 * las oportunidades para decidir con datos, sin optimizar a ciegas.
 */
import { test, expect } from '@playwright/test';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

test('lighthouse: accesibilidad >= 90 y reporte de performance', async ({}, testInfo) => {
  test.setTimeout(180000);

  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  });
  try {
    const url = 'http://127.0.0.1:3002/panel/?token=' + encodeURIComponent(process.env.E2E_TOKEN || '');
    const runner = await lighthouse(url, {
      port: chrome.port,
      output: 'json',
      onlyCategories: ['performance', 'accessibility'],
      formFactor: 'desktop',
      screenEmulation: { disabled: true },
      throttling: {
        rttMs: 0, throughputKbps: 0, requestLatencyMs: 0,
        downloadThroughputKbps: 0, uploadThroughputKbps: 0, cpuSlowdownMultiplier: 1,
      },
      logLevel: 'error',
    });

    const lhr = runner.lhr;
    const performance = Math.round(lhr.categories.performance.score * 100);
    const accesibilidad = Math.round(lhr.categories.accessibility.score * 100);

    testInfo.annotations.push({ type: 'lighthouse', description: 'performance=' + performance + ' accessibility=' + accesibilidad });
    console.log('Lighthouse panel: performance=' + performance + ' accessibility=' + accesibilidad);
    for (const id of ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index', 'mainthread-work-breakdown']) {
      const a = lhr.audits[id];
      if (a) console.log('  ' + id + ': ' + (a.displayValue || a.numericValue));
    }

    if (performance < 90) {
      const oportunidades = Object.values(lhr.audits)
        .filter((a) => a.score !== null && a.score < 1 && a.details && a.details.type === 'opportunity')
        .slice(0, 6)
        .map((a) => a.id + ': ' + a.title);
      console.log('Performance < 90. Oportunidades: ' + (oportunidades.join(' | ') || 'ninguna de tipo opportunity'));
    }
    if (accesibilidad < 90) {
      const fallas = Object.values(lhr.audits)
        .filter((a) => a.score !== null && a.score < 1 && a.id.startsWith('aria-') === false)
        .filter((a) => a.details && (a.details.type === 'table' || a.details.type === 'list'))
        .slice(0, 8)
        .map((a) => a.id + ': ' + a.title);
      console.log('Accesibilidad < 90. Hallazgos: ' + fallas.join(' | '));
    }

    expect(accesibilidad, 'accesibilidad Lighthouse').toBeGreaterThanOrEqual(90);
  } finally {
    await chrome.kill();
  }
});
