/* tienda.spec.js — vidriera publica /tienda, sin sesion ni token. */
import { test, expect } from '@playwright/test';

test('la tienda publica lista el stock sin pedir login', async ({ page }) => {
  const errores = [];
  page.on('pageerror', (e) => errores.push(e.message));
  await page.goto('/tienda');
  await expect(page).toHaveTitle(/Stock · RESOLVER/);
  await expect(page.locator('#tot')).not.toHaveText('–');
  const total = Number(await page.locator('#tot').innerText());
  expect(total).toBeGreaterThan(0);
  const filas = page.locator('#filas tr');
  expect(await filas.count()).toBeGreaterThan(0);
  await expect(filas.first().locator('td.bin')).toHaveText(/^\d{6}$/);
  expect(errores).toEqual([]);
});

test('el filtro de la tienda acota por BIN', async ({ page }) => {
  await page.goto('/tienda');
  const primera = await page.locator('#filas td.bin').first().innerText();
  await page.fill('#busca', primera);
  await expect(page.locator('#filas tr')).toHaveCount(1);
  await page.fill('#busca', '000000');
  await expect(page.locator('#filas .vacio')).toHaveText('Sin resultados.');});

test('el registro avisa como conseguir el codigo si entras sin invitacion', async ({ page }) => {
  await page.goto('/registro');
  await expect(page.locator('#sinCodigo')).toBeVisible();
  await page.goto('/registro?codigo=ABCDE-12345');
  await expect(page.locator('#codigo')).toHaveValue('ABCDE-12345');
  await expect(page.locator('#sinCodigo')).toBeHidden();
});

test('la API publica de la tienda trae los saldos y no exige token', async ({ request }) => {
  const r = await request.get('/api/tienda');
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
  expect(j.total).toBe(j.items.reduce((s, x) => s + x.n, 0));
  expect(j.total).toBeGreaterThan(0);
  const conSaldo = j.items.find((x) => Number(x.saldo_max) > 0);
  expect(conSaldo).toBeTruthy();
  expect(conSaldo.saldo_min).toBeLessThanOrEqual(conSaldo.saldo_max);
});
