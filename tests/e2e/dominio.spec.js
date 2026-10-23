/* dominio.spec.js — unitarios de la Fase 6 (sin DB): transiciones de pedidos
* y catálogo de scopes de API keys.
*/
import { test, expect } from '@playwright/test';
import { transicionValida, TRANSICIONES } from '../../lib/pedidos.js';
import { SCOPES } from '../../lib/auth.js';

test('transiciones válidas de pedidos por rol', () => {
  expect(transicionValida('reservado', 'pagado', 'vendedor')).toBe(true);
  expect(transicionValida('reservado', 'cancelado', 'vendedor')).toBe(true);
  expect(transicionValida('entregado', 'reclamo', 'vendedor')).toBe(true);
  expect(transicionValida('pagado', 'entregado', 'sistema')).toBe(true);
  expect(transicionValida('reclamo', 'cancelado', 'admin')).toBe(true);
});

test('transiciones inválidas se rechazan', () => {
  expect(transicionValida('reservado', 'entregado', 'sistema')).toBe(false);
  expect(transicionValida('pagado', 'reservado', 'admin')).toBe(false);
  expect(transicionValida('entregado', 'pagado', 'sistema')).toBe(false);
  expect(transicionValida('vencido', 'pagado', 'admin')).toBe(false);
  expect(transicionValida('cancelado', 'reservado', 'admin')).toBe(false);
  expect(transicionValida('verificado', 'pagado', 'vendedor')).toBe(false);
  expect(transicionValida('pagado', 'cancelado', 'vendedor')).toBe(false);
});

test('estados terminales no tienen salida', () => {
  expect(TRANSICIONES.vencido).toEqual([]);
  expect(TRANSICIONES.cancelado).toEqual([]);
});

test('catálogo de scopes cerrado', () => {
  expect(SCOPES).toEqual(expect.arrayContaining([
    'catalogo:read', 'catalogo:reserve', 'catalogo:pay',
    'wallet:read', 'pedidos:read', 'pedidos:write',
    'admin:read', 'admin:write',
  ]));
  expect(new Set(SCOPES).size).toBe(SCOPES.length);
});
