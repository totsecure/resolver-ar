/* flujo-saldeadas.spec.js — flujo del bot: /saldeadas -> /pedir N -> /revisar N.
 * Valida el formato exacto que pidió el usuario y que pedir saca de la lista.
 */
import { test, expect } from '@playwright/test';
const TOKEN = process.env.E2E_TOKEN || '';
const q = (p) => '/stock' + p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
const lineasDe = (txt) => txt.split('\n').filter((l) => /^\d+>/.test(l));

test('saldeadas lista numerada con saldo', async ({ request }) => {
  const r = await request.get(q('/saldeadas'));
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.texto).toContain('Saldeadas');
  // formato "N> mascara - disp/ref"
  expect(j.texto).toMatch(/\d+> \d{6}\d*xxxx\d{4}/);
  expect(j.texto).toMatch(/- \d+[mk]?(\/\d+[mk]?)?/);
});

test('pedir N: envía la tarjeta completa, la marca VENDIDA y sale de la lista', async ({ request }) => {
  const antes = await (await request.get(q('/saldeadas'))).json();
  const primera = lineasDe(antes.texto)[0];
  expect(primera, 'hay al menos una saldeada').toBeTruthy();
  const n = Number(primera.match(/^(\d+)>/)[1]);

  const ped = await (await request.post(q('/pedir') + '&n=' + n)).json();
  expect(ped.ok, JSON.stringify(ped)).toBe(true);
  expect(ped.bloque).toContain('TARJETA #' + n);
  expect(ped.bloque).toContain('DATOS TITULAR');
  expect(ped.bloque).toContain('DATOS TARJETA');
  expect(ped.bloque).toContain('CC ');
  expect(ped.bloque).toMatch(/SALDO \S+/);

  const despues = await (await request.get(q('/saldeadas'))).json();
  expect(lineasDe(despues.texto).length).toBe(lineasDe(antes.texto).length - 1);
});

test('revisar sin N: saca a REVISION la última venta del chat', async ({ request }) => {
  const chat = '999';
  const lista = await (await request.get(q('/saldeadas'))).json();
  const n = Number(lineasDe(lista.texto)[0].match(/^(\d+)>/)[1]);
  const ped = await (await request.post(q('/pedir') + '&n=' + n + '&chat_id=' + chat)).json();
  expect(ped.ok).toBe(true);
  const rev = await (await request.post(q('/revisar') + '&chat_id=' + chat)).json();
  expect(rev.ok, JSON.stringify(rev)).toBe(true);
  expect(rev.n).toBe(1);
});

test('revisar N: manda a REVISION y sale de la lista de vendibles', async ({ request }) => {
  // Pedimos una, luego la revisamos por su número en la lista vigente.
  const antes = await (await request.get(q('/saldeadas'))).json();
  const primera = lineasDe(antes.texto)[0];
  expect(primera, 'hay saldeada para revisar').toBeTruthy();
  const n = Number(primera.match(/^(\d+)>/)[1]);
  const ped = await (await request.post(q('/pedir') + '&n=' + n)).json();
  expect(ped.ok, JSON.stringify(ped)).toBe(true);
  // Tras vender, la posición n es otra tarjeta; pedimos su bloque para comparar.
  const lista2 = await (await request.get(q('/saldeadas'))).json();
  const n2 = Number(lineasDe(lista2.texto)[0].match(/^(\d+)>/)[1]);
  const rev = await (await request.post(q('/revisar') + '&n=' + n2)).json();
  expect(rev.ok, JSON.stringify(rev)).toBe(true);
  expect(rev.n).toBe(1);
  const post = await (await request.get(q('/saldeadas'))).json();
  expect(lineasDe(post.texto).length).toBe(lineasDe(lista2.texto).length - 1);
});
