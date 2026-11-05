#!/usr/bin/env node
/* capturas.mjs — screenshots desktop/mobile del panel.
 *   node scripts/capturas.mjs antes|despues
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const RAIZ = '/Volumes/Boveda/resolver';
const ETIQUETA = process.argv[2] || 'actual';
const token = (() => {
  const txt = fs.readFileSync(path.join(RAIZ, 'datos', 'server.env'), 'utf8');
  const m = txt.match(/^RESOLVER_TOKEN=(.*)$/m);
  return (m ? m[1] : '').trim().replace(/^["']|["']$/g, '');
})();
const dir = path.join(RAIZ, 'docs', 'capturas');
fs.mkdirSync(dir, { recursive: true });

const browser = await chromium.launch();
try {
  for (const [nombre, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 900]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto('http://127.0.0.1:3001/panel/?token=' + encodeURIComponent(token), { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const archivo = path.join(dir, ETIQUETA + '-' + nombre + '.png');
    await page.screenshot({ path: archivo, fullPage: false });
    console.log(archivo);
    await page.close();
  }
} finally { await browser.close(); }
