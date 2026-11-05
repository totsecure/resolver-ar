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

test('en celular cada fila de la tienda se apila y no se estira', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tienda');
  await expect(page.locator('#filas tr').first()).toBeVisible();
  const m = await page.evaluate(() => {
    const filas = [...document.querySelectorAll('#filas tr')];
    return {
      desborde: document.documentElement.scrollWidth - window.innerWidth,
      altoMax: Math.max(...filas.map((f) => f.getBoundingClientRect().height)),
      cabeceraVisible: getComputedStyle(document.querySelector('.tabla thead')).display !== 'none',
    };
  });
  expect(m.desborde).toBeLessThanOrEqual(1);
  expect(m.altoMax).toBeLessThan(90);
  expect(m.cabeceraVisible).toBe(false);
});

test('los chips de banco filtran la tienda y se apagan', async ({ page }) => {
  await page.goto('/tienda');
  const chip = page.locator('#chips button').first();
  await expect(chip).toBeVisible();
  const filas = page.locator('#filas tr');
  const antes = await filas.count();
  await chip.click();
  await expect(page.locator('#chips button.on')).toHaveCount(1);
  const bancos = [...new Set(await page.locator('#filas td.banco').allInnerTexts())];
  expect(bancos.length).toBe(1);
  expect(await filas.count()).toBeLessThan(antes);
  await chip.click();
  await expect(page.locator('#chips button.on')).toHaveCount(0);
  expect(await filas.count()).toBe(antes);
});

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
