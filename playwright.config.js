/* playwright.config.js — E2E del panel contra una instancia descartable.
 *
 * baseURL: http://127.0.0.1:3002 (NUNCA :3001)
 * webServer: scripts/e2e-server.sh (seed + server con .e2e/stock.db)
 * Un solo worker: el panel tiene estado global en la base.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const RAIZ = import.meta.dirname;
const PUERTO = Number(process.env.E2E_PORT || 3002);

function leerToken() {
  if (process.env.RESOLVER_TOKEN) return process.env.RESOLVER_TOKEN;
  const env = path.join(RAIZ, 'datos', 'server.env');
  try {
    const m = fs.readFileSync(env, 'utf8').match(/^RESOLVER_TOKEN=(.*)$/m);
    return (m ? m[1] : '').trim().replace(/^["']|["']$/g, '');
  } catch (_) {
    return '';
  }
}

const TOKEN = leerToken();
if (!TOKEN) throw new Error('Falta RESOLVER_TOKEN (datos/server.env o entorno)');
process.env.E2E_TOKEN = TOKEN;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './.e2e-artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:' + PUERTO,
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bash scripts/e2e-server.sh',
    url: 'http://127.0.0.1:' + PUERTO + '/health?token=' + encodeURIComponent(TOKEN),
    reuseExistingServer: false,
    timeout: 90000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
