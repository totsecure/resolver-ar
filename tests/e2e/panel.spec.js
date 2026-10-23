/* panel.spec.js — E2E del panel contra .e2e/stock.db (24 tarjetas es_test=1).
 *
 * Orden serial a proposito: los tests de mutacion van al final y los conteos
 * asumen el estado que deja el anterior. Un solo worker (workers: 1).
 */
import fs from 'node:fs';
import { test, expect } from '@playwright/test';

const TOKEN = process.env.E2E_TOKEN || '';
test.describe.configure({ mode: 'serial' });

const TOTALES = { DISPONIBLE: 8, RESERVADA: 3, VENDIDA: 4, REVISION: 5, PAPELERA: 2 };

test.beforeEach(async ({ page }) => {
  page._errores = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = (m.location() && m.location().url) || '';
    if (/favicon/i.test(url) || /favicon/i.test(m.text())) return;
    page._errores.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => page._errores.push('pageerror: ' + e.message));
  page.on('dialog', (d) => {
    page._errores.push('diálogo nativo: ' + d.message());
    d.dismiss();
  });
});

test.afterEach(async ({ page }) => {
  expect(page._errores, 'errores de consola').toEqual([]);
});

async function abrirPanel(page, total = TOTALES.DISPONIBLE) {
  await page.goto('/panel/?token=' + encodeURIComponent(TOKEN));
  await esperarTotal(page, total);
}

async function esperarTotal(page, total) {
  await expect(page.locator('#info')).toHaveText(new RegExp('^' + total + ' resultados'));
}

async function irATab(page, estado, total) {
  await page.locator('.tab[data-estado="' + estado + '"]').click();
  await esperarTotal(page, total);
}

async function buscar(page, texto, total) {
  await page.fill('#f_q', texto);
  await page.click('#btnBuscar');
  await esperarTotal(page, total);
}

async function marcarFila(page, indice) {
  await page.locator('#cuerpo tr').nth(indice).locator('input[type=checkbox]').click();
}

async function confirmarSwal(page) {
  await page.locator('.swal2-confirm').click();
}

test('carga de las cinco pestañas con el total del fixture', async ({ page }) => {
  await abrirPanel(page);

  await irATab(page, 'RESERVADA', TOTALES.RESERVADA);
  await irATab(page, 'VENDIDA', TOTALES.VENDIDA);
  await irATab(page, 'REVISION', TOTALES.REVISION);
  await irATab(page, 'PAPELERA', TOTALES.PAPELERA);
  await irATab(page, 'DISPONIBLE', TOTALES.DISPONIBLE);

  await expect(page.locator('#cuerpo tr')).toHaveCount(TOTALES.DISPONIBLE);
});

test('filtro por BIN y búsqueda por texto', async ({ page }) => {
  await abrirPanel(page);

  await page.fill('#f_bins', '411111');
  await page.click('#btnBuscar');
  await esperarTotal(page, 2);
  await expect(page.locator('#cuerpo tr')).toHaveCount(2);

  await page.fill('#f_bins', '999999');
  await page.click('#btnBuscar');
  await esperarTotal(page, 0);
  await expect(page.locator('#cuerpo tr')).toContainText('Sin resultados');

  await page.click('#btnLimpiar');
  await esperarTotal(page, TOTALES.DISPONIBLE);

  await buscar(page, 'E2E-03', 1);
  await expect(page.locator('#cuerpo tr')).toHaveCount(1);
  await expect(page.locator('#cuerpo tr')).toContainText('516585');

  await page.click('#btnLimpiar');
  await esperarTotal(page, TOTALES.DISPONIBLE);
});

test('seleccionar una fila con el checkbox y clickeando la fila', async ({ page }) => {
  await abrirPanel(page);

  await marcarFila(page, 0);
  await expect(page.locator('#sel')).toHaveText('1 seleccionadas');

  await page.keyboard.press('Escape');
  await expect(page.locator('#sel')).toHaveText('0 seleccionadas');

  await page.locator('#cuerpo tr').first().locator('td').nth(4).click();
  await expect(page.locator('#sel')).toHaveText('1 seleccionadas');

  await page.keyboard.press('Escape');
  await expect(page.locator('#sel')).toHaveText('0 seleccionadas');
});

test('seleccionar todas la página y todo el filtro', async ({ page }) => {
  await abrirPanel(page);

  await page.locator('#chkTodos').click();
  await expect(page.locator('#sel')).toHaveText(TOTALES.DISPONIBLE + ' seleccionadas');

  await page.locator('#chkTodos').click();
  await expect(page.locator('#sel')).toHaveText('0 seleccionadas');

  await page.click('#btnSelTodos');
  await expect(page.locator('#sel')).toHaveText(TOTALES.DISPONIBLE + ' seleccionadas (todo el filtro)');

  await page.keyboard.press('Escape');
  await expect(page.locator('#sel')).toHaveText('0 seleccionadas');
});

test('aviso de publicadas sin precio', async ({ page }) => {
  await abrirPanel(page);

  const aviso = page.locator('#sinPrecio');
  await expect(aviso).toBeVisible();
  await expect(aviso).toContainText('5 publicada(s) SIN PRECIO');
  await expect(page.locator('#cuerpo tr')).toHaveCount(TOTALES.DISPONIBLE);
});

test('ver sin precio (toggle) y precio máximo sin NULL', async ({ page }) => {
  await abrirPanel(page);

  await expect(page.locator('#sinPrecio')).toContainText('5 publicada(s) SIN PRECIO');

  // Activar: exactamente las 5 sin precio, con '-' en ambas columnas de precio.
  await page.click('#spVer');
  await esperarTotal(page, 5);
  await expect(page.locator('#cuerpo tr')).toHaveCount(5);
  const precios = await page.locator('#cuerpo tr td.precio').allTextContents();
  expect(precios).toHaveLength(10);
  expect(precios.every((t) => t.trim() === '-')).toBe(true);
  await expect(page.locator('#spVer')).toHaveText('Ver todas');

  // Apagar el toggle: vuelven las 8 y el pmax quedó limpio.
  await page.click('#spVer');
  await esperarTotal(page, TOTALES.DISPONIBLE);
  await expect(page.locator('#f_pmax')).toHaveValue('');
  await expect(page.locator('#spVer')).toHaveText('Ver sin precio');

  // pmax sigue trayendo solo las que tienen precio (no las NULL).
  await page.fill('#f_pmax', '30000');
  await page.click('#btnBuscar');
  await esperarTotal(page, 2);
  await expect(page.locator('#cuerpo tr td.precio').first()).not.toHaveText('-');

  await page.fill('#f_pmax', '20000');
  await page.click('#btnBuscar');
  await esperarTotal(page, 1);
  await expect(page.locator('#cuerpo tr td.precio').first()).not.toHaveText('-');

  await page.click('#btnLimpiar');
  await esperarTotal(page, TOTALES.DISPONIBLE);
});

test('chip de sin precio con contador y apagado', async ({ page }) => {
  await abrirPanel(page);

  const chip = page.locator('#chipSinPrecio');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('5');

  await chip.click();
  await esperarTotal(page, 5);
  await expect(chip).toHaveClass(/activo/);

  await chip.click();
  await esperarTotal(page, TOTALES.DISPONIBLE);
  await expect(chip).not.toHaveClass(/activo/);
});

test('dashboard carga Chart.js en diferido', async ({ page }) => {
  await abrirPanel(page);

  expect(await page.evaluate(() => !!window.Chart)).toBe(false);
  await page.click('#btnDash');

  await expect(page.locator('#dashBox')).toBeVisible();
  await expect(page.locator('#dashBox canvas')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => !!window.Chart)).toBe(true);
  await expect(page.locator('#chEstado')).toBeVisible();

  await page.click('#btnDash');
  await expect(page.locator('#dashBox')).toBeHidden();
});

test('formulario de saldo con SweetAlert2 (sin prompt nativo)', async ({ page }) => {
  await abrirPanel(page);

  await marcarFila(page, 0);
  await page.click('#btnSaldo');
  await expect(page.locator('#sw_saldo_disp')).toBeVisible();
  await page.fill('#sw_saldo_disp', '777');
  await page.fill('#sw_saldo_ref', '888');
  await confirmarSwal(page);

  await expect(page.locator('.toastify')).toContainText('Saldo actualizado');
  await expect(page.locator('#cuerpo tr').first().locator('td').nth(10)).toContainText('777/888');
});

test('atajos /, a, A y Esc', async ({ page }) => {
  await abrirPanel(page);

  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('/');
  await expect(page.locator('#f_q')).toBeFocused();

  await page.locator('#f_q').fill('E2E-01');
  await page.keyboard.press('Enter');
  await esperarTotal(page, 1);
  await page.click('#btnLimpiar');
  await esperarTotal(page, TOTALES.DISPONIBLE);

  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('a');
  await expect(page.locator('#sel')).toHaveText(TOTALES.DISPONIBLE + ' seleccionadas');

  await page.keyboard.press('Escape');
  await expect(page.locator('#sel')).toHaveText('0 seleccionadas');

  await page.keyboard.press('Shift+A');
  await expect(page.locator('#sel')).toHaveText(TOTALES.DISPONIBLE + ' seleccionadas (todo el filtro)');

  await page.keyboard.press('Escape');
  await expect(page.locator('#sel')).toHaveText('0 seleccionadas');
});

test('publicar desde Revisión y deshacer', async ({ page }) => {
  await abrirPanel(page);
  await irATab(page, 'REVISION', TOTALES.REVISION);

  await marcarFila(page, 0);
  await marcarFila(page, 1);
  await expect(page.locator('#sel')).toHaveText('2 seleccionadas');
  await expect(page.locator('#btnComprar')).toHaveText('Publicar seleccionadas');

  await page.click('#btnComprar');
  await expect(page.locator('.toastify')).toContainText('Publicadas');
  await esperarTotal(page, TOTALES.REVISION - 2);

  await irATab(page, 'DISPONIBLE', TOTALES.DISPONIBLE + 2);

  await page.click('#btnDeshacer');
  await esperarTotal(page, TOTALES.DISPONIBLE);

  await irATab(page, 'REVISION', TOTALES.REVISION);
});

test('exportar CSV con el encabezado esperado', async ({ page }) => {
  await abrirPanel(page);

  const [descarga] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnCSV'),
  ]);

  expect(descarga.suggestedFilename()).toMatch(/^stock-\d{4}-\d{2}-\d{2}\.csv$/);
  const ruta = await descarga.path();
  const contenido = fs.readFileSync(ruta, 'utf8').replace(/^\uFEFF/, '');
  const lineas = contenido.split('\n');

  expect(lineas[0]).toBe('id;ref;bin;marca;banco;pais;tipo;nivel;numero;mes;anio;cvv;etiqueta;estado;precio_num;precio_cuotas;saldo;saldo_ref;dni;titular;mail;telefono;direccion;ciudad;provincia;zip;refund;creado');
  expect(lineas.length).toBe(TOTALES.DISPONIBLE + 1);
});

test('responsive 390/820/1440 sin scroll horizontal y acciones alcanzables', async ({ page }) => {
  for (const ancho of [390, 820, 1440]) {
    await page.setViewportSize({ width: ancho, height: 900 });
    await abrirPanel(page);

    const desborde = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(desborde, 'scroll horizontal a ' + ancho + 'px').toBeLessThanOrEqual(1);

    await marcarFila(page, 0);
    for (const sel of ['#btnComprar', '#btnSelTodos', '#btnPedirSel', '#btnCSV']) {
      const el = page.locator(sel);
      await expect(el, sel + ' a ' + ancho + 'px').toBeVisible();
      await el.scrollIntoViewIfNeeded();
      const caja = await el.boundingBox();
      expect(caja, sel + ' sin caja a ' + ancho + 'px').not.toBeNull();
      expect(caja.x).toBeGreaterThanOrEqual(0);
      expect(caja.x + caja.width).toBeLessThanOrEqual(ancho + 1);
    }
  }
});

test('accesibilidad: sin violaciones críticas (axe-core)', async ({ page }) => {
  await abrirPanel(page);
  const AxeBuilder = (await import('@axe-core/playwright')).default;
  const resultado = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const criticas = resultado.violations.filter((v) => v.impact === 'critical');
  expect(criticas.map((v) => ({ id: v.id, nodos: v.nodes.length }))).toEqual([]);
});

test('a papelera, restaurar y borrado definitivo', async ({ page }) => {
  await abrirPanel(page);

  // 1) Market -> papelera
  await buscar(page, 'E2E-01', 1);
  await marcarFila(page, 0);
  await page.click('#btnBorrar');
  await confirmarSwal(page);
  await esperarTotal(page, 0);

  await page.click('#btnLimpiar');
  await esperarTotal(page, TOTALES.DISPONIBLE - 1);
  await irATab(page, 'PAPELERA', TOTALES.PAPELERA + 1);

  // 2) restaurar
  await buscar(page, 'E2E-01', 1);
  await marcarFila(page, 0);
  await page.click('#btnRestaurar');
  await confirmarSwal(page);
  await esperarTotal(page, 0);

  await page.click('#btnLimpiar');
  await esperarTotal(page, TOTALES.DISPONIBLE);
  await irATab(page, 'PAPELERA', TOTALES.PAPELERA);

  // 3) borrado definitivo
  await irATab(page, 'DISPONIBLE', TOTALES.DISPONIBLE);
  await buscar(page, 'E2E-02', 1);
  await marcarFila(page, 0);
  await page.click('#btnBorrar');
  await confirmarSwal(page);
  await esperarTotal(page, 0);

  await irATab(page, 'PAPELERA', 1);
  await marcarFila(page, 0);
  await expect(page.locator('#btnBorrar')).toHaveText('Borrar definitivo');
  await page.click('#btnBorrar');
  await confirmarSwal(page);
  await esperarTotal(page, 0);

  await page.click('#btnLimpiar');
  await esperarTotal(page, TOTALES.DISPONIBLE - 1);
  await irATab(page, 'PAPELERA', TOTALES.PAPELERA);
});
