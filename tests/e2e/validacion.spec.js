/* validacion.spec.js — zod en los POST sensibles (modo tolerante).
 * Usa el server aislado de :3002 y el token de servicio.
 */
import { test, expect } from '@playwright/test';
import * as esquemas from '../../lib/validacion.js';

const TOKEN = process.env.E2E_TOKEN || '';
const auth = { Authorization: 'Bearer ' + TOKEN };

async function post(request, ruta, data) {
  return request.post(ruta, { headers: auth, data });
}

test('login rechaza tipos claramente inválidos y acepta strings', async ({ request }) => {
  let r = await post(request, '/api/auth/login', { usuario: { a: 1 }, clave: 'x' });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toBe('datos_invalidos');

  r = await post(request, '/api/auth/login', { usuario: 'no-existe-e2e', clave: 'x' });
  expect(r.status()).not.toBe(400);
});

test('registro rechaza tipos inválidos', async ({ request }) => {
  const r = await post(request, '/api/registro', { codigo: [], usuario: 'x', clave: 'x' });
  expect(r.status()).toBe(400);
});

test('panel/cc/analizar y confirmar rechazan texto no escalar', async ({ request }) => {
  for (const ruta of ['/panel/cc/analizar', '/panel/cc/confirmar']) {
    const r = await post(request, ruta, { texto: { no: 'es texto' } });
    expect(r.status(), ruta).toBe(400);
  }
});

test('panel/cc/analizar coerciona reactivar y texto vacío', async ({ request }) => {
  const r = await post(request, '/panel/cc/analizar', { texto: '', reactivar: 'true' });
  expect(r.status()).toBe(200);
});

test('panel/comprar rechaza ids no escalares', async ({ request }) => {
  const r = await post(request, '/panel/comprar', { ids: { a: 1 } });
  expect(r.status()).toBe(400);
});

test('catálogo rechaza ids/cantidades inválidas', async ({ request }) => {
  const casos = [
    ['/api/catalogo/reservar', { refs: { a: 1 } }],
    ['/api/catalogo/pagar', { id: { a: 1 } }],
    ['/api/catalogo/chk', { reserva_id: { a: 1 } }],
    ['/api/catalogo/cancelar', { id: { a: 1 } }],
  ];
  for (const [ruta, data] of casos) {
    const r = await post(request, ruta, data);
    // El token de servicio no es vendedor: puede cortar antes el gate (403).
    // Lo que importa es que no sea 500 ni que llegue al handler.
    expect([400, 403], ruta).toContain(r.status());
  }
});

test('admin rechaza montos/ids no numéricos', async ({ request }) => {
  const casos = [
    ['/api/admin/saldo', { monto: { a: 1 } }],
    ['/api/admin/precios/tramos', { precio: { a: 1 } }],
    ['/api/admin/usuarios/1/estado', { estado: { a: 1 } }],
  ];
  for (const [ruta, data] of casos) {
    const r = await post(request, ruta, data);
    expect(r.status(), ruta).toBe(400);
  }
});

test('los esquemas rechazan objetos donde va un escalar', () => {
  expect(esquemas.login.safeParse({ usuario: {}, clave: 'x' }).success).toBe(false);
  expect(esquemas.registro.safeParse({ codigo: {}, usuario: 'x', clave: 'x' }).success).toBe(false);
  expect(esquemas.ccAnalizar.safeParse({ texto: [] }).success).toBe(false);
  expect(esquemas.ccConfirmar.safeParse({ texto: {} }).success).toBe(false);
  expect(esquemas.panelComprar.safeParse({ ids: {} }).success).toBe(false);
  expect(esquemas.catalogoReservar.safeParse({ refs: {} }).success).toBe(false);
  expect(esquemas.catalogoChk.safeParse({ reserva_id: {} }).success).toBe(false);
  expect(esquemas.admin.safeParse({ monto: {} }).success).toBe(false);
  // Coerciones tolerantes
  expect(esquemas.catalogoReservar.safeParse({ cantidad: '2' }).success).toBe(true);
  expect(esquemas.ccAnalizar.safeParse({ texto: '', reactivar: 'true' }).success).toBe(true);
});
