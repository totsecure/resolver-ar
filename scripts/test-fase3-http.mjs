#!/usr/bin/env node
/* test-fase3-http.mjs — pago, revelado, auto-OK y vencimiento por HTTP. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const RAIZ = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-fase3-http-'));
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
const TOKEN = 'token-de-prueba-fase3';

process.env.RESOLVER_STOCK_DB = stockDb;
process.env.RESOLVER_DB = padronDb;
const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const catalogo = await import('../lib/catalogo.js');
const stock = await import('../lib/stock.js');

auth.migrar(); wallet.migrar(); vendedores.migrar(); catalogo.migrar();
const admin = auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });
const inv = vendedores.crearInvitacion({ creadoPor: admin.id });
vendedores.registrar({ codigo: inv.codigo, usuario: 'vend1', clave: 'clavevend11', nombre: 'Vendedor', dni: '41111222', telefono: '11555', alias_cbu: 'vend1.alias' });
const v = vendedores.listar({ estado: 'pendiente' })[0];
vendedores.revisarAlta(v.usuario_id, admin.id, true);
const uid = v.usuario_id;
wallet.acreditar(uid, 1000, 'carga');

function sembrar(bin, precio, titular, dni) {
  const d = stock.base();
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  const info = d.prepare(
    'INSERT INTO cc(numero, mes, anio, cvv, bin, marca, estado, precio_num, creado, ref, titular, dni, banco, verif_estado) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(stock.demoNumero(bin, 16), '12', '2028', '321', bin, 'Visa', 'DISPONIBLE', precio, new Date().toISOString(), ref, titular, dni, 'Banco Test', 'sin_verificar');
  return Number(info.lastInsertRowid);
}
const cc1 = sembrar('411111', 100, 'Titular Uno', '30111222');
const cc2 = sembrar('411111', 150, 'Titular Dos', '30222333');

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }

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
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) {}
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
  console.log('TEST fase 3 HTTP — ' + new Date().toISOString() + ' puerto=' + PUERTO);
  if (!(await esperar())) throw new Error('el server no arrancó:\n' + salida.slice(-2000));
  const vend = cliente();
  const pre = await vend('/api/auth/csrf');
  const login = await vend('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': pre.j.csrf },
    body: JSON.stringify({ usuario: 'vend1', clave: 'clavevend11' }),
  });
  check('login vendedor', login.status === 200);
  const csrf = login.j.csrf;

  /* reserva por HTTP revela datos */
  const res = await vend('/api/catalogo/reservar', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ refs: [cc1] }),
  });
  check('reserva HTTP', res.status === 201 && res.j.ok === true, 'http=' + res.status);
  const item = res.j.items[0];
  const numDb = stock.base().prepare('SELECT numero FROM cc WHERE id=?').get(cc1).numero;
  check('revela numero en la reserva', item.numero === numDb);
  check('revela titular', item.titular === 'Titular Uno' && item.dni === '30111222');
  check('marca asignada', Boolean(item.asignada_en));

  const cat = await vend('/api/catalogo');
  check('catalogo sigue enmascarado', cat.j.items.every((x) => x.numero_mask.includes('xxxx')));
  check('catalogo sin PAN', !/\b\d{13,19}\b/.test(JSON.stringify(cat.j.items)));

  const resId = stock.base().prepare('SELECT id FROM reservas WHERE cc_id=?').get(cc1).id;
  const datos = await vend('/api/catalogo/reserva/' + resId + '/datos');
  check('releer datos asignados', datos.status === 200 && datos.j.item.numero === numDb);

  const sinCsrf = await vend('/api/catalogo/pagar', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: resId }),
  });
  check('pago sin CSRF da 403', sinCsrf.status === 403);

  const pago = await vend('/api/catalogo/pagar', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ id: resId }),
  });
  check('pago HTTP', pago.status === 200 && pago.j.estado === 'pagada', 'http=' + pago.status);
  check('pago no recobra', pago.j && pago.j.ok && (await vend('/api/wallet')).j.saldo === 900);
  const doble = await vend('/api/catalogo/pagar', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ id: resId }),
  });
  check('doble pago rechazado', doble.status === 409);

  const mis = await vend('/api/catalogo/mis-reservas');
  check('cuenta regresiva visible', mis.j.proxima && new Date(mis.j.proxima).getTime() > Date.now(), 'proxima=' + mis.j.proxima);
  check('estado pagada en lista', (mis.j.reservas || []).some((r) => r.id === resId && r.estado === 'pagada'));

  /* forzar vencimiento de la pagada y ejecutar el job via admin */
  stock.base().prepare('UPDATE reservas SET expira=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), resId);
  const job = await fetch(BASE + '/api/admin/expirar?token=' + encodeURIComponent(TOKEN), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const jobJ = await job.json();
  check('job cierra pagada', job.status === 200 && jobJ.cerradas >= 1, JSON.stringify(jobJ));
  const cc1row = stock.base().prepare('SELECT estado, verif_estado FROM cc WHERE id=?').get(cc1);
  check('cc VENDIDA auto-OK', cc1row.estado === 'VENDIDA' && cc1row.verif_estado === 'ok');
  const mis2 = await vend('/api/catalogo/mis-reservas');
  check('reserva ok en la web', (mis2.j.reservas || []).some((r) => r.id === resId && r.estado === 'ok'));

  /* impaga: vuelve al catalogo y al saldo */
  const res2 = await vend('/api/catalogo/reservar', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ refs: [cc2] }),
  });
  check('segunda reserva HTTP', res2.status === 201);
  const saldoCon = (await vend('/api/wallet')).j.saldo;
  const resId2 = stock.base().prepare('SELECT id FROM reservas WHERE cc_id=?').get(cc2).id;
  stock.base().prepare('UPDATE reservas SET expira=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), resId2);
  const job2 = await fetch(BASE + '/api/admin/expirar?token=' + encodeURIComponent(TOKEN), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const job2J = await job2.json();
  check('job libera impaga', job2J.liberadas >= 1, JSON.stringify(job2J));
  const cat3 = await vend('/api/catalogo');
  check('vuelve al catalogo', cat3.j.items.some((x) => x.id === cc2));
  check('saldo devuelto', (await vend('/api/wallet')).j.saldo === saldoCon + 150, 'saldo=' + (await vend('/api/wallet')).j.saldo);
  check('cc disponible', stock.base().prepare('SELECT estado FROM cc WHERE id=?').get(cc2).estado === 'DISPONIBLE');
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
