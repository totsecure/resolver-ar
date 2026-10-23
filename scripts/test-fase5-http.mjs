#!/usr/bin/env node
/* test-fase5-http.mjs — panel admin por HTTP: reclamos, reemplazo/devolucion,
 * metricas, precios y auditoria. Server real, base temporal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const RAIZ = path.resolve(import.meta.dirname, '..');
process.env.RECLAMO_AUTO_REEMPLAZO = '0';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-fase5-http-'));
const stockDb = path.join(dir, 'stock.db');
const padronDb = path.join(dir, 'padron.db');
const PUERTO = await puertoLibre();
function puertoLibre() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.on("error", () => resolve(0));
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const BASE = 'http://127.0.0.1:' + PUERTO;
const TOKEN = 'token-de-prueba-fase5';

process.env.RESOLVER_STOCK_DB = stockDb;
process.env.RESOLVER_DB = padronDb;
const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const catalogo = await import('../lib/catalogo.js');
const vinculacion = await import('../lib/vinculacion.js');
const notificaciones = await import('../lib/notificaciones.js');
const reclamos = await import('../lib/reclamos.js');
const precios = await import('../lib/precios.js');
const recargas = await import('../lib/recargas.js');
const vb = await import('../lib/vendedor-bot.js');
const stock = await import('../lib/stock.js');

for (const m of [auth, wallet, vendedores, catalogo, vinculacion, notificaciones, reclamos, precios, recargas]) m.migrar();
const admin = auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });
const inv = vendedores.crearInvitacion({ creadoPor: admin.id });
vendedores.registrar({ codigo: inv.codigo, usuario: 'vend1', clave: 'clavevend11', nombre: 'Vendedor', dni: '61111222', telefono: '11555', alias_cbu: 'vend1.alias' });
const v = vendedores.listar({ estado: 'pendiente' })[0];
vendedores.revisarAlta(v.usuario_id, admin.id, true);
const uid = v.usuario_id;
wallet.acreditar(uid, 1000, 'carga');
const lg = vinculacion.generar(uid);
vinculacion.consumir(lg.codigo, '777');

function sembrar(bin, precio, titular, dni, codigo) {
  const d = stock.base();
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  const info = d.prepare(
    'INSERT INTO cc(numero, mes, anio, cvv, bin, marca, estado, precio_num, creado, ref, titular, dni, banco, verif_estado, codigo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(stock.demoNumero(bin, 16), '12', '2028', '321', bin, 'Visa', 'DISPONIBLE', precio, new Date().toISOString(), ref, titular, dni, 'Banco Test', 'sin_verificar', codigo);
  return Number(info.lastInsertRowid);
}
const c1 = sembrar('411111', 100, 'Uno', '30111222', 'F5C1AAA');
const c2 = sembrar('411111', 100, 'Dos', '30222333', 'F5C2AAA');
const c3 = sembrar('411111', 150, 'Tres', '30333444', 'F5C3AAA');
const c4 = sembrar('411111', 150, 'Cuatro', '30444555', 'F5C4AAA');

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }
const svc = (ruta, opts = {}) => fetch(BASE + ruta + (ruta.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN), opts);
const svcJson = async (ruta, opts) => { const r = await svc(ruta, opts); return { status: r.status, j: await r.json().catch(() => null) }; };
const svcPost = (ruta, cuerpo) => svcJson(ruta, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo || {}) });

function cliente() {
  const galletas = new Map();
  return async function pedir(ruta, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (galletas.size) headers.cookie = [...galletas.entries()].map(([k, v]) => k + '=' + v).join('; ');
    const r = await fetch(BASE + ruta, { ...opts, headers, redirect: 'manual' });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
      const par = c.split(';')[0]; const i = par.indexOf('=');
      const k = par.slice(0, i); const vv = par.slice(i + 1);
      if (!vv) galletas.delete(k); else galletas.set(k, vv);
    }
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) {}
    return { status: r.status, j, txt, headers: r.headers };
  };
}

const hijo = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
  cwd: RAIZ,
  env: { ...process.env, PORT: String(PUERTO), RESOLVER_TOKEN: TOKEN, RESOLVER_STOCK_DB: stockDb, RESOLVER_DB: padronDb, JOB_RESERVAS_MS: '300000', TELEGRAM_ALLOW: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
function terminar() {
  return new Promise((resolve) => {
    if (hijo.exitCode !== null) return resolve();
    const t = setTimeout(() => { try { hijo.kill("SIGKILL"); } catch (_) {} }, 3000);
    hijo.once("close", () => { clearTimeout(t); resolve(); });
    hijo.kill("SIGTERM");
  });
}
let salida = '';
hijo.stdout.on('data', (b) => { salida += b.toString(); });
hijo.stderr.on('data', (b) => { salida += b.toString(); });
async function esperar() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/auth/csrf'); if (r.ok) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

try {
  console.log('TEST fase 5 HTTP — ' + new Date().toISOString() + ' puerto=' + PUERTO);
  if (!(await esperar())) throw new Error('el server no arrancó:\n' + salida.slice(-2000));

  /* dos reclamos: uno para reemplazo, otro para devolucion */
  const reclamadas = [];
  for (let i = 0; i < 2; i++) {
    const p = vb.pedir('777', '411111', 1);
    vb.pagar('777', p.grupo);
    const ccId = stock.base().prepare('SELECT cc_id FROM reservas WHERE grupo=? LIMIT 1').get(p.grupo).cc_id;
    reclamadas.push(ccId);
    const cod = stock.base().prepare('SELECT codigo FROM cc WHERE id=?').get(ccId).codigo;
    vb.marcarFalla('777', cod, 'motivo prueba');
  }
  check('reclamos pendientes en la base', reclamos.listar({ estado: 'pendiente' }).length === 2, 'cc=' + reclamadas.join(','));

  const lista = await svcJson('/api/admin/reclamos?n=50');
  check('admin ve reclamos por HTTP', lista.status === 200 && lista.j.reclamos.length === 2, 'http=' + lista.status);
  const r1 = lista.j.reclamos.find((x) => x.cc_id === c1 || x.cc_id === c3);
  check('reclamo trae tarjeta enmascarada', r1 && r1.numero_mask.includes('xxxx') && Boolean(r1.motivo));
  check('reclamo trae vendedor', r1 && r1.usuario === 'vend1');

  const idReemplazo = lista.j.reclamos.find((x) => x.cc_id === reclamadas[0]).id;
  const rep = await svcPost('/api/admin/reclamos/' + idReemplazo + '/resolver', { accion: 'reemplazo', nota: 'ok' });
  check('reemplazo por HTTP', rep.status === 200 && rep.j.ok === true, JSON.stringify(rep.j));
  check('reemplazo usa otra del BIN', rep.j.reemplazo && rep.j.reemplazo.id === c3, JSON.stringify(rep.j.reemplazo));
  check('reclamada ANULADA', stock.base().prepare('SELECT estado FROM cc WHERE id=?').get(reclamadas[0]).estado === 'ANULADA');
  check('reemplazo VENDIDA', stock.base().prepare('SELECT estado FROM cc WHERE id=?').get(c3).estado === 'VENDIDA');

  const saldoAntes = wallet.saldoDe(uid);
  const idDevolucion = lista.j.reclamos.find((x) => x.cc_id === reclamadas[1]).id;
  const dev = await svcPost('/api/admin/reclamos/' + idDevolucion + '/resolver', { accion: 'devolucion', nota: 'devuelto' });
  check('devolucion por HTTP', dev.status === 200 && dev.j.ok === true && dev.j.devuelto === 100, JSON.stringify(dev.j));
  check('saldo devuelto en la base', wallet.saldoDe(uid) === saldoAntes + 100);
  check('cc devuelta ANULADA', stock.base().prepare('SELECT estado FROM cc WHERE id=?').get(reclamadas[1]).estado === 'ANULADA');

  const metricas = await svcJson('/api/admin/metricas?umbral=2');
  check('metricas por HTTP', metricas.status === 200 && metricas.j.kpis && metricas.j.kpis.reclamos_pendientes === 0);
  check('metricas falla por BIN', (metricas.j.fallaPorBin || []).some((f) => f.bin === '411111' && f.fallas === 2));
  check('metricas stock bajo', (metricas.j.stockBajo || []).some((s) => s.bin === '411111'));

  /* precios por HTTP y efecto en el catalogo del vendedor */
  const tramo = await svcPost('/api/admin/precios/tramos', { bin: '411111', desde: 1, hasta: 5, precio: 90 });
  check('tramo por HTTP', tramo.status === 200 && tramo.j.ok === true);
  const vend = cliente();
  const pre = await vend('/api/auth/csrf');
  const login = await vend('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': pre.j.csrf },
    body: JSON.stringify({ usuario: 'vend1', clave: 'clavevend11' }),
  });
  check('login vendedor', login.status === 200);
  const cat = await vend('/api/catalogo?bins=411111');
  check('catalogo aplica tramo', cat.status === 200 && cat.j.items.every((x) => x.precio === 90), JSON.stringify(cat.j.items && cat.j.items[0]));

  const us = await svcJson('/api/admin/usuarios');
  check('lista usuarios por HTTP', us.status === 200 && us.j.usuarios.some((u) => u.usuario === 'vend1' && u.vendedor));
  const aud = await svcJson('/api/admin/auditoria?n=200');
  check('auditoria por HTTP', aud.status === 200 && aud.j.auditoria.some((a) => a.accion === 'RECLAMO_RESOLVER'));
  const lotes = await svcJson('/api/admin/lotes');
  check('lotes por HTTP', lotes.status === 200 && Array.isArray(lotes.j.lotes));

  const pagina = await svc('/panel/admin.html', { headers: { accept: 'text/html' } });
  check('pagina admin con token', pagina.status === 200 && /Administración/.test(await pagina.text()));
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  await terminar();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
if (FAIL) console.log('\n--- salida del server ---\n' + salida.slice(-2500));
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
