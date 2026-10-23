#!/usr/bin/env node
/* test-fase2-http.mjs — Fase 2 de punta a punta: registro, catalogo, reserva,
 * recarga y aprobacion via HTTP. Server en puerto aparte, base temporal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const RAIZ = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-fase2-http-'));
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
const TOKEN = 'token-de-prueba-fase2';

process.env.RESOLVER_STOCK_DB = stockDb;
const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const recargas = await import('../lib/recargas.js');
const catalogo = await import('../lib/catalogo.js');
const stock = await import('../lib/stock.js');

auth.migrar(); wallet.migrar(); vendedores.migrar(); recargas.migrar(); catalogo.migrar();
const admin = auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });

function alta(usuario, dni) {
  const inv = vendedores.crearInvitacion({ creadoPor: admin.id });
  const r = vendedores.registrar({ codigo: inv.codigo, usuario, clave: 'clave' + usuario + '1', nombre: usuario, dni, telefono: '11555', alias_cbu: usuario + '.alias' });
  const id = vendedores.listar({ estado: 'pendiente' }).find((v) => v.usuario === usuario).usuario_id;
  vendedores.revisarAlta(id, admin.id, true);
  return id;
}
const id1 = alta('vend1', '31111222');
const id2 = alta('vend2', '32222333');
wallet.acreditar(id1, 1000, 'carga');
wallet.acreditar(id2, 1000, 'carga');

function sembrar(numero, bin, precio) {
  const d = stock.base();
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  d.prepare('INSERT INTO cc(numero, mes, anio, cvv, bin, marca, estado, precio_num, creado, ref) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(numero, '12', '2028', '123', bin, bin.startsWith('4') ? 'Visa' : 'Master', 'DISPONIBLE', precio, new Date().toISOString(), ref);
}
sembrar(stock.demoNumero('516585', 16), '516585', 100);
sembrar(stock.demoNumero('516585', 16), '516585', 100);
sembrar(stock.demoNumero('516585', 16), '516585', 100);
sembrar(stock.demoNumero('411111', 16), '411111', 250);
sembrar(stock.demoNumero('411111', 16), '411111', 250);

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
      const k = par.slice(0, i); const v = par.slice(i + 1);
      if (!v) galletas.delete(k); else galletas.set(k, v);
    }
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) {}
    return { status: r.status, j, txt, headers: r.headers };
  };
}
async function login(cli, usuario, clave) {
  const pre = await cli('/api/auth/csrf');
  const l = await cli('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': pre.j.csrf },
    body: JSON.stringify({ usuario, clave }),
  });
  return l;
}

const hijo = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
  cwd: RAIZ,
  env: { ...process.env, PORT: String(PUERTO), RESOLVER_TOKEN: TOKEN, RESOLVER_STOCK_DB: stockDb, RESOLVER_DB: padronDb, TELEGRAM_ALLOW: '' },
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
  console.log('TEST fase 2 HTTP — ' + new Date().toISOString() + ' puerto=' + PUERTO);
  if (!(await esperar())) throw new Error('el server no arrancó:\n' + salida.slice(-2000));

  const v1 = cliente();
  const l1 = await login(v1, 'vend1', 'clavevend11');
  check('login vendedor 1', l1.status === 200 && l1.j?.usuario?.rol === 'vendedor', 'http=' + l1.status);
  const csrf1 = l1.j.csrf;

  const cat = await v1('/api/catalogo');
  check('catalogo por HTTP', cat.status === 200 && cat.j?.total === 5, 'total=' + cat.j?.total);
  check('catalogo enmascarado', cat.j.items.every((x) => x.numero_mask.includes('xxxx') && !('numero' in x)));
  check('catalogo sin numero completo en el JSON', !/\b\d{13,19}\b/.test(JSON.stringify(cat.j.items)));
  check('precio visible', cat.j.items.every((x) => x.precio > 0));
  check('saldo en catalogo', cat.j.saldo === 1000, 'saldo=' + cat.j.saldo);

  const sinCsrf = await v1('/api/catalogo/reservar', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bin: '516585', cantidad: 3 }),
  });
  check('reserva sin CSRF da 403', sinCsrf.status === 403 && sinCsrf.j?.error === 'csrf', 'http=' + sinCsrf.status);

  const res = await v1('/api/catalogo/reservar', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf1 },
    body: JSON.stringify({ bin: '516585', cantidad: 3 }),
  });
  check('reserva lote 3 por HTTP', res.status === 201 && res.j?.ok && res.j.cantidad === 3, 'grupo=' + res.j?.grupo);
  check('saldo debitado', res.j?.saldo === 700, 'saldo=' + res.j?.saldo);

  const cat2 = await v1('/api/catalogo');
  check('reservadas fuera del catalogo', cat2.j?.total === 2, 'total=' + cat2.j?.total);

  const v2 = cliente();
  const l2 = await login(v2, 'vend2', 'clavevend21');
  check('login vendedor 2', l2.status === 200);
  const catV2 = await v2('/api/catalogo');
  check('otro vendedor no ve las reservadas', catV2.j?.total === 2 && !(catV2.j?.items || []).some((x) => x.bin === '516585'));

  const mis = await v1('/api/catalogo/mis-reservas');
  check('mis reservas por HTTP', mis.status === 200 && (mis.j?.reservas || []).filter((r) => r.estado === 'activa').length === 3);
  check('mis reservas enmascaradas', (mis.j?.reservas || []).every((r) => r.numero_mask.includes('xxxx')));
  check('countdown expira', mis.j?.proxima && new Date(mis.j.proxima).getTime() > Date.now());

  const rec = await v1('/api/recargas', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf1 },
    body: JSON.stringify({ monto: 300, comprobante: 'transferencia 999' }),
  });
  check('recarga por HTTP', rec.status === 201 && rec.j?.estado === 'pendiente');

  const adminSvc = await fetch(BASE + '/api/admin/recargas?estado=pendiente&token=' + encodeURIComponent(TOKEN));
  const adminJ = await adminSvc.json();
  check('admin ve recarga pendiente (token)', adminSvc.status === 200 && adminJ.recargas.length === 1);
  const recId = adminJ.recargas[0].id;
  const aprob = await fetch(BASE + '/api/admin/recargas/' + recId + '/revisar?token=' + encodeURIComponent(TOKEN), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aprobar: true, nota: 'ok' }),
  });
  const aprobJ = await aprob.json();
  check('admin aprueba recarga (token)', aprob.status === 200 && aprobJ.ok === true);

  const w = await v1('/api/wallet');
  check('recarga acreditada al vendedor', w.status === 200 && w.j?.saldo === 1000, 'saldo=' + w.j?.saldo);
  check('ledger visible', (w.j?.movimientos || []).length >= 3);

  const prohibido = await v1('/api/admin/vendedores', {
    method: 'GET', headers: { 'content-type': 'application/json' },
  });
  check('vendedor no entra a admin', prohibido.status === 403, 'http=' + prohibido.status);

  const panelVend = await v1('/panel/vendedores.html', { headers: { accept: 'text/html' } });
  check('vendedor no entra al panel', panelVend.status >= 300 && panelVend.status < 400, 'http=' + panelVend.status + ' -> ' + panelVend.headers.get('location'));
  const catPage = await v1('/catalogo', { headers: { accept: 'text/html' } });
  check('vendedor sí entra a /catalogo', catPage.status === 200 && /Catálogo/.test(catPage.txt));

  /* invitacion + registro publico + aprobacion */
  const invR = await fetch(BASE + '/api/admin/invitaciones?token=' + encodeURIComponent(TOKEN), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dias: 7 }),
  });
  const invJ = await invR.json();
  check('admin genera invitacion (token)', invR.status === 201 && invJ.codigo, 'codigo=' + invJ.codigo);

  const anon = cliente();
  const preC = await anon('/api/auth/csrf');
  const regR = await anon('/api/registro', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': preC.j.csrf },
    body: JSON.stringify({ codigo: invJ.codigo, usuario: 'vend3', clave: 'clavevend31', nombre: 'Vendedor Tres', dni: '33333444', telefono: '1155533333', alias_cbu: 'vend3.alias' }),
  });
  check('registro publico', regR.status === 201 && regR.j?.estado === 'pendiente', 'http=' + regR.status + ' ' + (regR.j?.error || ''));
  const pendLogin = await login(cliente(), 'vend3', 'clavevend31');
  check('pendiente no puede entrar', pendLogin.status === 401, 'http=' + pendLogin.status);

  const lista = await fetch(BASE + '/api/admin/vendedores?estado=pendiente&token=' + encodeURIComponent(TOKEN));
  const listaJ = await lista.json();
  const v3 = (listaJ.vendedores || []).find((v) => v.usuario === 'vend3');
  check('alta pendiente visible', Boolean(v3));
  const aprob3 = await fetch(BASE + '/api/admin/vendedores/' + v3.usuario_id + '/revisar?token=' + encodeURIComponent(TOKEN), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aprobar: true }),
  });
  check('admin aprueba vendedor', aprob3.status === 200);
  const login3 = await login(cliente(), 'vend3', 'clavevend31');
  check('aprobado ya puede entrar', login3.status === 200);

  const regPage = await fetch(BASE + '/registro');
  check('/registro publico', regPage.status === 200 && /Alta de vendedor/.test(await regPage.text()));
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
