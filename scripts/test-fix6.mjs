#!/usr/bin/env node
/* test-fix6.mjs — es_test quirúrgico: reales sobreviven, test se borra. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const RAIZ = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-fix6-'));
const DB = path.join(dir, 'stock.db');
process.env.RESOLVER_STOCK_DB = DB;
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.PUBLICAR_DIRECTO = '1';

const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const catalogo = await import('../lib/catalogo.js');
const pedidos = await import('../lib/pedidos.js');
const notificaciones = await import('../lib/notificaciones.js');
const recargas = await import('../lib/recargas.js');
const reclamos = await import('../lib/reclamos.js');
const vendedores = await import('../lib/vendedores.js');
const checker = await import('../lib/checker.js');
const vinculacion = await import('../lib/vinculacion.js');
const stock = await import('../lib/stock.js');
const { base } = stock;

let OK = 0, FAIL = 0;
const ok = (n, d) => { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); };
const fail = (n, d) => { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); };
const check = (n, c, d) => c ? ok(n, d) : fail(n, d || 'sin detalle');

auth.migrar(); wallet.migrar(); vendedores.migrar(); catalogo.migrar(); recargas.migrar(); reclamos.migrar(); checker.migrar(); vinculacion.migrar(); pedidos.migrar(); notificaciones.migrar(); stock.base();
try {
  const admin = auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdminF6' });
  const reales = [];
  for (let i = 0; i < 3; i++) {
    const numero = stock.demoNumero('411111', 16);
    const r = stock.cargar(numero + '|12|28|321', { flexible: true, fase: 'confirmar', lote: 'REAL', es_test: false });
    reales.push(numero);
    check('real ' + (i + 1) + ' cargada es_test=0', r.nuevas === 1 && base().prepare('SELECT es_test FROM cc WHERE numero=?').get(numero).es_test === 0);
  }
  const testNum = stock.demoNumero('411111', 16);
  stock.cargar(testNum + '|12|28|321', { flexible: true, fase: 'confirmar', lote: 'TEST', es_test: true });
  check('tarjeta test es_test=1', base().prepare('SELECT es_test FROM cc WHERE numero=?').get(testNum).es_test === 1);
  auth.crearUsuario({ usuario: 'test_vend', nombre: 'Test Vendedor', rol: 'vendedor', clave: 'claveTestF6', es_test: 1 });
  check('usuario test es_test=1', base().prepare("SELECT es_test FROM usuarios WHERE usuario='test_vend'").get().es_test === 1);

  const env = { ...process.env, RESOLVER_STOCK_DB: DB, RESOLVER_DB: path.join(dir, 'padron.db') };
  const dry = execFileSync(process.execPath, [path.join(RAIZ, 'scripts', 'limpiar-tests.mjs')], { cwd: RAIZ, env, encoding: 'utf8' });
  check('dry-run lista tarjeta exacta', dry.includes(testNum) && dry.includes('lote=TEST'));
  check('dry-run lista usuario exacto', dry.includes('test_vend') && dry.includes('Test Vendedor'));
  const si = execFileSync(process.execPath, [path.join(RAIZ, 'scripts', 'limpiar-tests.mjs'), '--si'], { cwd: RAIZ, env, encoding: 'utf8' });
  check('--si informa borrado', /BORRADO OK/.test(si));
  check('quedan 3 reales', base().prepare('SELECT COUNT(*) n FROM cc').get().n === 3 && reales.every((n) => base().prepare('SELECT 1 FROM cc WHERE numero=?').get(n)));
  check('no queda test', base().prepare('SELECT COUNT(*) n FROM cc WHERE es_test=1').get().n === 0 && base().prepare("SELECT COUNT(*) n FROM usuarios WHERE es_test=1").get().n === 0);
  check('admin sigue', base().prepare("SELECT COUNT(*) n FROM usuarios WHERE usuario='admin'").get().n === 1);
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
