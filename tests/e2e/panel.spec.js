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

/* Abre el menú desplegable de la barra contextual que contiene el botón. */
async function abrirMenu(page, idBoton) {
  const det = page.locator('#barraAcciones .bc-menu', { has: page.locator(idBoton) });
  const abierto = await det.evaluate((d) => d.open).catch(() => false);
  if (!abierto) await det.locator('summary').click();
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
  await expect(aviso).toContainText('SIN PRECIO');
  await expect(aviso).toContainText('1 vencida');
  await expect(aviso).toContainText('1 por vencer en 30 días');
  await expect(page.locator('#cuerpo tr')).toHaveCount(TOTALES.DISPONIBLE);
});

test('banco/nivel se completan desde el dataset local de BINs', async ({ page }) => {
  await abrirPanel(page);
  await buscar(page, '516478', 1);
  await expect(page.locator('#cuerpo tr')).toContainText('BANCO DE LA PAMPA');
  await expect(page.locator('#cuerpo tr')).toContainText('PLATINUM');
  await page.click('#btnLimpiar');
});

test('filtros de vencimiento y nivel', async ({ page }) => {
  await abrirPanel(page);

  await page.selectOption('#f_venc', 'vencidas');
  await page.click('#btnBuscar');
  await esperarTotal(page, 1);
  await expect(page.locator('#cuerpo tr')).toContainText('VENCIDA');

  await page.selectOption('#f_venc', '30');
  await page.click('#btnBuscar');
  await esperarTotal(page, 1);
  await expect(page.locator('#cuerpo tr')).toContainText('545652');

  await page.selectOption('#f_venc', '');
  await page.selectOption('#f_niveles', 'gold');
  await page.click('#btnBuscar');
  await esperarTotal(page, 3);
  await expect(page.locator('#cuerpo tr').first()).toContainText('gold');

  await page.click('#btnLimpiar');
  await esperarTotal(page, 8);
});

test('ver sin precio (toggle) y precio máximo sin NULL', async ({ page }) => {
  await abrirPanel(page);

  await expect(page.locator('#sinPrecio')).toContainText('SIN PRECIO');

  // Activar: exactamente las 5 sin precio, con '-' en ambas columnas de precio.
  await page.click('#spVer');
  await esperarTotal(page, 5);
  await expect(page.locator('#cuerpo tr')).toHaveCount(5);
  await expect(page.locator('#cuerpo tr td.precio .badge-estado')).toHaveCount(5);
  const cuotas = await page.locator('#cuerpo tr td[data-edit="precio_cuotas"]').allTextContents();
  expect(cuotas).toHaveLength(5);
  expect(cuotas.every((t) => t.trim() === '-')).toBe(true);
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

test('dashboard carga ApexCharts en diferido', async ({ page }) => {
  await abrirPanel(page);

  expect(await page.evaluate(() => !!window.ApexCharts)).toBe(false);
  await page.click('#btnDash');

  await expect(page.locator('#dashBox')).toBeVisible();
  await expect(page.locator('#dashBox .apexcharts-canvas')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => !!window.ApexCharts)).toBe(true);
  await expect(page.locator('#chEstado .apexcharts-canvas')).toBeVisible();

  await page.click('#btnDash');
  await expect(page.locator('#dashBox')).toBeHidden();
});

test('toggle de tema cambia data-bs-theme', async ({ page }) => {
  await abrirPanel(page);
  await expect(page.locator('#btnTema')).toContainText('Oscuro');
  await page.click('#btnTema');
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
  const fondo = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(fondo).toContain('9, 12, 18');
  await page.click('#btnTema');
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');
});

test('editar 3 precios inline solo con teclado y el refresh no pisa', async ({ page }) => {
  test.setTimeout(70000);
  await abrirPanel(page);

  await page.locator('#cuerpo tr').nth(0).locator('[data-edit="precio_num"]').click();
  await page.keyboard.type('1111');
  await page.keyboard.press('Enter');
  await expect(page.locator('#cuerpo tr').nth(1).locator('[data-edit="precio_num"] input')).toBeFocused();

  await page.keyboard.type('2222');
  await page.keyboard.press('Tab');
  await expect(page.locator('#cuerpo tr').nth(1).locator('[data-edit="precio_cuotas"] input')).toBeFocused();

  await page.keyboard.type('3333');
  await page.keyboard.press('Enter');
  await expect(page.locator('#cuerpo tr').nth(2).locator('[data-edit="precio_cuotas"] input')).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(page.locator('#cuerpo tr').nth(0).locator('[data-edit="precio_num"]')).toContainText('1.111');
  await expect(page.locator('#cuerpo tr').nth(1).locator('[data-edit="precio_num"]')).toContainText('2.222');
  await expect(page.locator('#cuerpo tr').nth(1).locator('[data-edit="precio_cuotas"]')).toContainText('3.333');

  await page.waitForTimeout(22000);
  await expect(page.locator('#cuerpo tr').nth(0).locator('[data-edit="precio_num"]')).toContainText('1.111');
  await expect(page.locator('#cuerpo tr').nth(1).locator('[data-edit="precio_cuotas"]')).toContainText('3.333');
});

test('selección con rango, invertir y limpiar', async ({ page }) => {
  await abrirPanel(page);
  await page.locator('#cuerpo tr').nth(0).locator('input[data-id]').click();
  await page.locator('#cuerpo tr').nth(3).locator('input[data-id]').click({ modifiers: ['Shift'] });
  await expect(page.locator('#sel')).toHaveText('4 seleccionadas');
  await abrirMenu(page, '#btnInvertir');
  await page.click('#btnInvertir');
  await expect(page.locator('#sel')).toHaveText('4 seleccionadas');
  await page.click('#bcCerrar');
  await expect(page.locator('#sel')).toHaveText('0 seleccionadas');
});

test('columnas configurables persisten (ocultar BIN)', async ({ page }) => {
  await abrirPanel(page);
  await expect(page.locator('th[data-col="estado"]')).toBeHidden();
  await page.locator('#panelColumnas summary').click();
  await page.locator('#panelColumnas input[data-col="bin"]').click();
  await expect(page.locator('th[data-col="bin"]')).toBeHidden();
  await page.reload();
  await esperarTotal(page, 8);
  await expect(page.locator('th[data-col="bin"]')).toBeHidden();
});

test('estado de filtros y pestaña sobrevive al refresh', async ({ page }) => {
  await abrirPanel(page);
  await buscar(page, 'E2E-01', 1);
  expect(page.url()).toContain('q=E2E-01');
  await page.reload();
  await esperarTotal(page, 1);
  await expect(page.locator('#f_q')).toHaveValue('E2E-01');

  await page.click('#btnLimpiar');
  await esperarTotal(page, 8);
  await page.locator('.tab[data-estado="REVISION"]').click();
  await esperarTotal(page, 5);
  expect(page.url()).toContain('estado=REVISION');
  await page.reload();
  await esperarTotal(page, 5);
  await expect(page.locator('.tab[data-estado="REVISION"]')).toHaveClass(/on/);
});

test('precio masivo con preview y confirmación', async ({ page }) => {
  await abrirPanel(page);
  await marcarFila(page, 0);
  await abrirMenu(page, '#btnPrecioMasivo');
  await page.click('#btnPrecioMasivo');
  await page.fill('#pm_p1', '7777');
  await page.locator('.swal2-confirm').click();
  await expect(page.locator('.swal2-html-container')).toContainText('1');
  await expect(page.locator('.swal2-html-container')).toContainText('7777');
  await page.locator('.swal2-confirm').click();
  await expect(page.locator('.toastify')).toContainText('Precios aplicados');
  await expect(page.locator('#cuerpo tr').first().locator('[data-edit="precio_num"]')).toContainText('7.777');
});

test('saldeadas: web y server devuelven el mismo texto', async ({ page }) => {
  await abrirPanel(page);
  await page.click('#btnSaldeadas');
  await expect(page.locator('#m_pedido')).toContainText('Saldeadas');
  await expect(page.locator('#m_pedido')).toContainText('120000/150000');
  const enModal = await page.locator('#m_pedido').textContent();
  const token = process.env.E2E_TOKEN || '';
  const delServer = await page.evaluate(async (t) => (await (await fetch('/stock/saldeadas?token=' + encodeURIComponent(t))).json()).texto, token);
  expect(enModal.trim()).toBe(delServer.trim());
  await page.click('#m_cancelar');
});

test('copiar PAN por fila y bloque por selección', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await abrirPanel(page);

  await page.locator('#cuerpo tr').first().locator('summary').click();
  await page.locator('#cuerpo tr').first().locator('[data-copiar="linea"]').click();
  await expect(page.locator('.toastify')).toContainText('Copiado');
  const linea = await page.evaluate(() => navigator.clipboard.readText());
  expect(linea).toMatch(/^\d{15,16}\|\d{2}\|\d{2}\|\d{3}$/);

  await marcarFila(page, 0);
  await marcarFila(page, 1);
  await abrirMenu(page, '#btnCopiarSel');
  await page.click('#btnCopiarSel');
  const bloque = await page.evaluate(() => navigator.clipboard.readText());
  expect(bloque.split('\n').length).toBe(2);
});

test('formulario de saldo con SweetAlert2 (sin prompt nativo)', async ({ page }) => {
  await abrirPanel(page);

  await marcarFila(page, 0);
  await abrirMenu(page, '#btnSaldo');
  await page.click('#btnSaldo');
  await expect(page.locator('#sw_saldo_disp')).toBeVisible();
  await page.fill('#sw_saldo_disp', '777');
  await page.fill('#sw_saldo_ref', '888');
  await confirmarSwal(page);

  await expect(page.locator('.toastify')).toContainText('Saldo actualizado');
  await expect(page.locator('#cuerpo tr').first().locator('td.saldo')).toContainText('777/888');
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

  await page.locator('#barraAcciones .bc-menu').last().locator('summary').click(); // menú Más
  await page.click('#btnDeshacer');
  await esperarTotal(page, TOTALES.DISPONIBLE);

  await irATab(page, 'REVISION', TOTALES.REVISION);
});

test('exportar CSV con el encabezado esperado', async ({ page }) => {
  await abrirPanel(page);
  await marcarFila(page, 0);

  await abrirMenu(page, '#btnCSV');
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

    if (ancho <= 767) {
      const layout = await page.locator('#cuerpo tr').first().evaluate((tr) => getComputedStyle(tr).display);
      expect(layout, 'cards mobile').toBe('grid');
      const etiqueta = await page.locator('#cuerpo td[data-label="Saldo"]').first().evaluate((td) => getComputedStyle(td, '::before').content);
      expect(etiqueta, 'data-label visible').toContain('Saldo');
    }
    if (ancho === 390) {
      const sidebar = page.locator('#sidebar');
      const antes = await sidebar.boundingBox();
      expect(antes.x).toBeLessThan(0);
      await page.locator('.menu-btn').click();
      await page.waitForTimeout(300);
      const abierto = await sidebar.boundingBox();
      expect(abierto.x).toBeGreaterThanOrEqual(0);
      await page.locator('.sidebar-backdrop').click({ position: { x: 380, y: 300 } });
      await page.waitForTimeout(300);
      const cerrado = await sidebar.boundingBox();
      expect(cerrado.x).toBeLessThan(0);
    }

    await marcarFila(page, 0);
    for (const sel of ['#btnComprar', '#btnSelTodos', '#btnPedirSel']) {
      const el = page.locator(sel);
      await expect(el, sel + ' a ' + ancho + 'px').toBeVisible();
      await el.scrollIntoViewIfNeeded();
      const caja = await el.boundingBox();
      expect(caja, sel + ' sin caja a ' + ancho + 'px').not.toBeNull();
      expect(caja.x).toBeGreaterThanOrEqual(0);
      expect(caja.x + caja.width).toBeLessThanOrEqual(ancho + 1);
    }
    // CSV vive dentro del menú "Más": lo abrimos y verificamos.
    await page.locator('#barraAcciones .bc-menu').last().locator('summary').click();
    await expect(page.locator('#btnCSV')).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test('accesibilidad: sin violaciones críticas (axe-core)', async ({ page }) => {
  await abrirPanel(page);
  const AxeBuilder = (await import('@axe-core/playwright')).default;
  const resultado = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const criticas = resultado.violations.filter((v) => v.impact === 'critical');
  expect(criticas.map((v) => ({ id: v.id, nodos: v.nodes.length }))).toEqual([]);

  /* Paridad dark: sin críticas y sin fallas de contraste. */
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-bs-theme', 'dark');
    document.body.classList.remove('claro');
  });
  await page.waitForTimeout(400);
  const oscuro = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const graves = oscuro.violations.filter((v) => v.impact === 'critical' || v.id === 'color-contrast');
  expect(graves.map((v) => ({ id: v.id, nodos: v.nodes.length }))).toEqual([]);
});

test('a papelera, restaurar y borrado definitivo', async ({ page, request }) => {
  await abrirPanel(page);

  /* 0) el banner avisa de las borradas ocultas y ofrece restaurarlas. */
  await expect(page.locator('#borradasBanner')).toBeVisible();
  await expect(page.locator('#borradasBanner')).toContainText('borrada');
  await page.locator('#borradasBanner a#borrVer').click();
  await esperarTotal(page, TOTALES.PAPELERA);
  await expect(page.locator('#borradasBanner a#borrOcultar')).toBeVisible();
  await page.locator('#borradasBanner a#borrOcultar').click();
  await esperarTotal(page, TOTALES.DISPONIBLE);

  /* el catálogo sólo muestra DISPONIBLE con precio y sin borrar (3 en el fixture). */
  const catalogoTotal = async () => {
    const r = await request.get('/api/catalogo?token=' + encodeURIComponent(TOKEN) + '&por=60');
    const j = await r.json();
    return j.total;
  };
  expect(await catalogoTotal()).toBe(3);

  // 1) Market -> papelera: sale del listado y del catálogo.
  await buscar(page, 'E2E-01', 1);
  await marcarFila(page, 0);
  await page.click('#btnBorrar');
  await confirmarSwal(page);
  await esperarTotal(page, 0);
  await expect.poll(catalogoTotal).toBe(2);
  await expect(page.locator('#borradasBanner')).toContainText('3');

  await page.click('#btnLimpiar');
  await esperarTotal(page, TOTALES.DISPONIBLE - 1);
  await irATab(page, 'PAPELERA', TOTALES.PAPELERA + 1);

  // 2) restaurar: vuelve al listado y al catálogo.
  await buscar(page, 'E2E-01', 1);
  await marcarFila(page, 0);
  await page.click('#btnRestaurar');
  await confirmarSwal(page);
  await esperarTotal(page, 0);
  expect(await catalogoTotal()).toBe(3);

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
