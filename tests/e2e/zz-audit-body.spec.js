/* _audit-pedido-body.spec.js — AUDITORIA.
 * Demuestra que /stock/pedir y /stock/revisar ignoran el JSON body:
 * el bot (bot/stock.js) manda {n,usuario,chat_id} por body y recibe no_encontrada.
 * El e2e existente (zz-flujo-saldeadas.spec.js) sólo prueba el path ?n= (query).
 */
import { test, expect } from '@playwright/test';
const TOKEN = process.env.E2E_TOKEN || '';
const q = (p) => '/stock' + p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
const lineasDe = (txt) => txt.split('\n').filter((l) => /^\d+>/.test(l));

test('AUDIT pedir por BODY (lo que manda el bot) resuelve la N', async ({ request }) => {
  const lista = await (await request.get(q('/saldeadas'))).json();
  const n = Number(lineasDe(lista.texto)[0].match(/^(\d+)>/)[1]);

  // Tal como lo hace bot/stock.js: POST con body JSON, sin n en el query.
  const r = await request.post(q('/pedir'), {
    data: { n: String(n), usuario: 'audit', chat_id: '1', comprador: '' },
  });
  const j = await r.json();
  // El bot espera ok:true. Hoy llega no_encontrada -> BUG.
  expect(j.ok, 'pedir por body: ' + JSON.stringify(j)).toBe(true);
});

test('AUDIT revisar por BODY (lo que manda el bot) resuelve la N', async ({ request }) => {
  const lista = await (await request.get(q('/saldeadas'))).json();
  const n = Number(lineasDe(lista.texto)[0].match(/^(\d+)>/)[1]);
  await request.post(q('/pedir'), { data: { n: String(n) } }); // vende la primera
  const rev = await request.post(q('/revisar'), { data: { n: String(n), usuario: 'audit' } });
  const j = await rev.json();
  expect(j.ok, 'revisar por body: ' + JSON.stringify(j)).toBe(true);
});
