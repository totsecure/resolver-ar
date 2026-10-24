/* carga.spec.js — flujo de carga de tarjetas y saldos.
 *
 * Cubre las regresiones del reporte del usuario:
 *  - el saldo del formato de bloques TARJETA #… se guarda;
 *  - tras confirmar, el panel ofrece publicar y al ir a Revisión se CIERRA la
 *    caja de carga (antes quedaba encima y parecía que el tab no navegaba).
 */
import { test, expect } from '@playwright/test';

const TOKEN = process.env.E2E_TOKEN || '';
test.describe.configure({ mode: 'serial' });

async function abrirPanel(page, total = 8) {
  await page.goto('/panel/?token=' + encodeURIComponent(TOKEN));
  await expect(page.locator('#info')).toHaveText(new RegExp('^' + total + ' resultados'));
}
async function abrirPanelAny(page) {
  await page.goto('/panel/?token=' + encodeURIComponent(TOKEN));
  await expect(page.locator('#info')).toHaveText(/^\d+ resultados/);
}

const BLOQUE = (n, cc, saldo) => `TARJETA #${n}
DATOS TITULAR
TITULAR PRUEBA ${n}
DNI 3011${String(n).padStart(4, '0')}
MAIL p${n}@test.com
TELEFONO 11 5555${n}
DIRECCION CALLE ${n}
CIUDAD LA PLATA
PROVINCIA BUENOS AIRES
PAIS Argentina

DATOS TARJETA
CC ${cc}
VENCIMIENTO 07/28
CODIGO 49${n % 9}
SALDO ${saldo}
`;

const TEXTO = [
  BLOQUE(1, '5895621217000009', '21m/61m696k'),
  BLOQUE(2, '5591982368681865', '2m500k/4m538k'),
].join('\n' + '='.repeat(60) + '\n');

test('cargar con saldo: analiza, confirma, publica y el saldo queda guardado', async ({ page }) => {
  await abrirPanelAny(page);
  await page.click('#btnCargar');

  await page.fill('#cc_texto', TEXTO);
  await page.click('#cc_analizar');
  await expect(page.locator('#cc_info')).toContainText('validas');

  await page.click('#cc_confirmar');
  await expect(page.locator('#cc_info')).toContainText('Revisión');
  const btnRevision = page.locator('#cc_irRevision');
  await expect(btnRevision).toBeVisible();

  // Al ir a Revisión, la caja de carga se CIERRA (no tapa la tabla).
  await btnRevision.click();
  await expect(page.locator('#cargarBox')).toBeHidden();
  await expect(page.locator('#info')).toContainText('resultados');
  const url = new URL(page.url());
  expect(url.searchParams.get('estado')).toBe('REVISION');

  // Las 2 recién cargadas están en Revisión: publicarlas.
  await page.fill('#f_q', '589562');
  await page.click('#btnBuscar');
  await expect(page.locator('#info')).toHaveText(/^1 resultados/);
  await page.locator('#cuerpo tr').first().locator('input[type=checkbox]').click();
  await page.click('#btnComprar');
  await expect(page.locator('.toastify')).toContainText('Public');
});

test('el saldo cargado se ve en la columna Saldo y viaja al catálogo de /panel/datos', async ({ request }) => {
  const r = await request.get('/panel/datos?token=' + encodeURIComponent(TOKEN) + '&q=589562&por=5');
  expect(r.status()).toBe(200);
  const j = await r.json();
  const fila = (j.filas || [])[0];
  expect(fila, 'la tarjeta cargada está en el listado').toBeTruthy();
  expect(String(fila.saldo || ''), 'saldo disp/ref visible').toMatch(/21000000|21m|21000/);
  expect(fila.saldo_num).toBeGreaterThan(0);
});

test('el tab Revisión del sidebar también cierra la caja de carga', async ({ page }) => {
  await abrirPanelAny(page);
  await page.click('#btnCargar');
  await expect(page.locator('#cargarBox')).toBeVisible();
  await page.click('.tab[data-estado="REVISION"]');
  await expect(page.locator('#cargarBox')).toBeHidden();
  expect(new URL(page.url()).searchParams.get('estado')).toBe('REVISION');
});

test('editar el saldo inline guarda disp y referencia', async ({ page }) => {
  await abrirPanelAny(page);
  await page.click('#btnCargar');
  await page.fill('#cc_texto', BLOQUE(3, '5165859999100000', '5m/9m'));
  await page.click('#cc_analizar');
  await expect(page.locator('#cc_info')).toContainText('validas');
  await page.click('#cc_confirmar');
  await page.locator('#cc_irRevision').click();
  await expect(page.locator('#cargarBox')).toBeHidden();

  await page.fill('#f_q', '999100000'); // parte del número de la recién cargada
  await page.click('#btnBuscar');
  await expect(page.locator('#info')).toHaveText(/^1 resultados/);
  await expect(page.locator('#cuerpo tr')).toHaveCount(1);

  const celda = page.locator('#cuerpo tr').first().locator('[data-edit="saldo"]');
  const idFila = await celda.getAttribute('data-id');
  await celda.click();
  const inp = celda.locator('input');
  await inp.fill('7m/8m');
  await inp.press('Enter');
  await expect.poll(async () => {
    const r = await page.request.get('/panel/datos?token=' + encodeURIComponent(TOKEN) + '&por=200&estado=REVISION');
    const j = await r.json();
    const fila = (j.filas || []).find((f) => String(f.id) === String(idFila));
    return fila && fila.saldo_num;
  }).toBe(7000000);
  await expect(page.locator('#cuerpo tr').first().locator('[data-edit="saldo"]')).toContainText('7m/8m');

  const r = await page.request.get('/panel/datos?token=' + encodeURIComponent(TOKEN) + '&por=200&estado=REVISION');
  const j = await r.json();
  const f = (j.filas || []).find((x) => String(x.id) === String(idFila));
  expect(f.saldo_num).toBe(7000000);
  expect(f.saldo_ref_num).toBe(8000000);
});
