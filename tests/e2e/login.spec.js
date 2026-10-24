/* login.spec.js — camino real de usuario: login + 2FA + CSRF, y assets vendor. */
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';

const SECRETO = 'JBSWY3DPEHPK3PXP';

function totp(secreto) {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secreto.toUpperCase().replace(/=+$/, '')) {
    const v = alfabeto.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes);
  const contador = Math.floor(Date.now() / 30000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(contador));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const num = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(num % 1000000).padStart(6, '0');
}

test('login.html ejecuta su JS (CSP sin unsafe-inline) y el submit llega al server', async ({ page, context }) => {
  /* Regresión: el JS de /login era inline y el CSP script-src 'self' lo
   * bloqueaba, así que el click no hacía nada. Ahora vive en /panel/login.js. */
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

  await page.goto('/login');
  const rCsrf = await context.request.get('/api/auth/csrf');
  expect(rCsrf.status()).toBe(200);

  await page.fill('#usuario', 'e2e-admin');
  await page.fill('#clave', 'clave-e2e-123');
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST'),
    page.click('#btnEntrar'),
  ]);
  await expect(page.locator('#vista2fa')).toBeVisible();
  expect(errores.filter((t) => !/401/.test(t))).toEqual([]);
});

test('login real con CSRF + 2FA llega al panel', async ({ page, context }) => {
  await page.goto('/login');
  const rCsrf = await context.request.get('/api/auth/csrf');
  expect(rCsrf.status()).toBe(200);
  const { csrf } = await rCsrf.json();

  const rLogin = await context.request.post('/api/auth/login', {
    data: { usuario: 'e2e-admin', clave: 'clave-e2e-123', _csrf: csrf },
    headers: { 'x-csrf-token': csrf },
  });
  expect(rLogin.status()).toBe(200);
  const j = await rLogin.json();
  expect(j.ok).toBe(true);
  expect(j.necesita2fa).toBe(true);

  const r2 = await context.request.post('/api/auth/2fa', {
    data: { codigo: totp(SECRETO), _csrf: j.csrf },
    headers: { 'x-csrf-token': j.csrf },
  });
  expect(r2.status()).toBe(200);

  await page.goto('/panel/');
  await expect(page.locator('#cuerpo')).toBeVisible();
  await expect(page.locator('#info')).toContainText('resultados');
});

test('assets vendor se sirven como CSS/JS y no como login', async ({ request }) => {
  for (const [ruta, tipo, minimo, marcador] of [
    ['/panel/vendor/tabler.min.css', /text\/css/, 100000, ':root'],
    ['/panel/vendor/sweetalert2.all.min.js', /javascript/, 50000, 'SweetAlert'],
    ['/panel/vendor/iconos.svg', /svg/, 5000, '<symbol id="tabler-'],
  ]) {
    const r = await request.get(ruta, { maxRedirects: 0 });
    expect(r.status(), ruta).toBe(200);
    expect(r.headers()['content-type'] || '', ruta).toMatch(tipo);
    const cuerpo = await r.text();
    expect(cuerpo.length, ruta).toBeGreaterThan(minimo);
    expect(cuerpo.includes(marcador), ruta).toBe(true);
    if (tipo.source.includes('javascript') || tipo.source.includes('css')) {
      expect(cuerpo.trimStart().startsWith('<'), ruta).toBe(false);
    }
  }
});

test('con token el CSS se aplica y no hay errores de consola', async ({ page }) => {
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = (m.location() && m.location().url) || '';
    if (/favicon/i.test(url) || /favicon/i.test(m.text())) return;
    errores.push(m.text());
  });

  const token = process.env.E2E_TOKEN || '';
  await page.goto('/panel/?token=' + encodeURIComponent(token), { waitUntil: 'networkidle' });
  const hojas = await page.evaluate(() => Array.from(document.styleSheets).map((s) => s.href || 'inline'));
  expect(hojas.some((h) => h.includes('/panel/vendor/tabler.min.css'))).toBe(true);
  expect(await page.evaluate(() => document.styleSheets.length)).toBeGreaterThan(1);
  expect(errores).toEqual([]);
});
