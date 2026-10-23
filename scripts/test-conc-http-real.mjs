#!/usr/bin/env node
/* test-conc-http-real.mjs — 10 reservas simultáneas por HTTP contra el server
 * REAL, con dos vendedores y una tarjeta es_test=1. Limpia al final.
 * No usar en el humo: toca la base de producción a propósito.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';

const RAIZ = path.resolve(import.meta.dirname, '..');
const BASE = process.env.RESOLVER_URL || 'http://127.0.0.1:3001';
if (process.env.RESOLVER_STOCK_DB) {
  console.error('Este test debe correr contra la base real: quitá RESOLVER_STOCK_DB.');
  process.exit(2);
}
const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const stock = await import('../lib/stock.js');
const { base } = stock;

let OK = 0, FAIL = 0;
const ok = (n, d) => { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); };
const fail = (n, d) => { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); };
const check = (n, c, d) => c ? ok(n, d) : fail(n, d || 'sin detalle');

function alta(usuario, dni) {
  const inv = vendedores.crearInvitacion({ creadoPor: 1 });
  vendedores.registrar({ codigo: inv.codigo, usuario, clave: 'clave' + usuario + '1', nombre: usuario, dni, telefono: '11555', alias_cbu: usuario + '.alias', es_test: 1 });
  const v = vendedores.listar({ estado: 'pendiente' }).find((x) => x.usuario === usuario);
  vendedores.revisarAlta(v.usuario_id, 1, true);
  return v.usuario_id;
}
function cliente() {
  const galletas = new Map();
  return async function pedir(ruta, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (galletas.size) headers.cookie = [...galletas.entries()].map(([k, v]) => k + '=' + v).join('; ');
    const r = await fetch(BASE + ruta, { ...opts, headers, redirect: 'manual' });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
      const par = c.split(';')[0]; const i = par.indexOf('=');
      const k = par.slice(0, i); const v = par.slice(i + 1);
      if (!v) galletas.delete(k); else galletas.set(k, v);
    }
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) {}
    return { status: r.status, j, txt };
  };
}
async function login(cli, usuario, clave) {
  const pre = await cli('/api/auth/csrf');
  return cli('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': pre.j.csrf },
    body: JSON.stringify({ usuario, clave }),
  });
}

console.log('TEST CONC HTTP REAL — ' + new Date().toISOString() + ' ' + BASE);
const antesReales = Number(base().prepare('SELECT COUNT(*) n FROM cc WHERE COALESCE(es_test,0)=0').get().n);
const antesUsuarios = Number(base().prepare('SELECT COUNT(*) n FROM usuarios WHERE COALESCE(es_test,0)=0').get().n);
let creados = false;
try {
  const ccNumero = stock.demoNumero('411111', 16);
  const d = base();
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get('411111').m || 0) + 1;
  const ccId = Number(d.prepare(
    'INSERT INTO cc(numero,mes,anio,cvv,bin,marca,estado,precio_num,creado,ref,titular,dni,banco,verif_estado,lote,es_test) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)'
  ).run(ccNumero, '12', '2028', '321', '411111', 'Visa', 'DISPONIBLE', 100, new Date().toISOString(), ref, 'Titular Test', '30111222', 'Banco Test', 'sin_verificar', 'TEST-CONC-HTTP').lastInsertRowid);
  const idA = alta('test_conc_http_a', '41111222');
  const idB = alta('test_conc_http_b', '42222333');
  wallet.acreditar(idA, 10000, 'test');
  wallet.acreditar(idB, 10000, 'test');
  creados = true;

  const cA = cliente(), cB = cliente();
  const lA = await login(cA, 'test_conc_http_a', 'clavetest_conc_http_a1');
  const lB = await login(cB, 'test_conc_http_b', 'clavetest_conc_http_b1');
  check('login vendedor A', lA.status === 200 && lA.j?.csrf);
  check('login vendedor B', lB.status === 200 && lB.j?.csrf);

  const pedidos = [];
  for (let i = 0; i < 10; i++) {
    const c = i % 2 === 0 ? cA : cB;
    const csrf = i % 2 === 0 ? lA.j.csrf : lB.j.csrf;
    pedidos.push(c('/api/catalogo/reservar', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ refs: [ccId] }),
    }));
  }
  const res = await Promise.all(pedidos);
  const wins = res.filter((r) => r.status === 201 && r.j?.ok).length;
  const sinStock = res.filter((r) => r.status === 409 && r.j?.error === 'sin_stock').length;
  console.log('  HTTP: ganadoras=' + wins + ' sin_stock=' + sinStock + ' otros=' + (res.length - wins - sinStock));
  check('10 reservas HTTP: exactamente 1 ganadora', wins === 1, 'wins=' + wins);
  check('9 perdedoras sin_stock', sinStock === 9, 'sin_stock=' + sinStock);
  check('tarjeta RESERVADA una vez', base().prepare('SELECT estado FROM cc WHERE id=?').get(ccId).estado === 'RESERVADA' && base().prepare('SELECT COUNT(*) n FROM reservas WHERE cc_id=?').get(ccId).n === 1);
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try {
    const env = { ...process.env };
    delete env.RESOLVER_STOCK_DB;
    execFileSync(process.execPath, [path.join(RAIZ, 'scripts', 'limpiar-tests.mjs'), '--si'], { cwd: RAIZ, env, encoding: 'utf8' });
    const testLeft = Number(base().prepare('SELECT COUNT(*) n FROM cc WHERE COALESCE(es_test,0)=1').get().n) + Number(base().prepare('SELECT COUNT(*) n FROM usuarios WHERE COALESCE(es_test,0)=1').get().n);
    const reales = Number(base().prepare('SELECT COUNT(*) n FROM cc WHERE COALESCE(es_test,0)=0').get().n);
    const usuarios = Number(base().prepare('SELECT COUNT(*) n FROM usuarios WHERE COALESCE(es_test,0)=0').get().n);
    console.log('  limpieza: es_test_restantes=' + testLeft + ' reales=' + antesReales + '->' + reales + ' usuarios=' + antesUsuarios + '->' + usuarios);
    check('limpieza es_test=1', testLeft === 0);
    check('reales intactas', reales === antesReales && usuarios === antesUsuarios);
  } catch (e) { fail('limpieza', String(e?.message || e)); }
}
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
