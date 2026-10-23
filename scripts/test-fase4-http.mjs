#!/usr/bin/env node
/* test-fase4-http.mjs — reserva web -> aviso encolado para Telegram y
 * accion del bot (/ok) reflejada en la web. Server real, base temporal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const RAIZ = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-fase4-http-'));
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
const TOKEN = 'token-de-prueba-fase4';

process.env.RESOLVER_STOCK_DB = stockDb;
process.env.RESOLVER_DB = padronDb;
const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const catalogo = await import('../lib/catalogo.js');
const vinculacion = await import('../lib/vinculacion.js');
const notificaciones = await import('../lib/notificaciones.js');
const vb = await import('../lib/vendedor-bot.js');
const stock = await import('../lib/stock.js');

for (const m of [auth, wallet, vendedores, catalogo, vinculacion, notificaciones]) m.migrar();
const admin = auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });
const inv = vendedores.crearInvitacion({ creadoPor: admin.id });
vendedores.registrar({ codigo: inv.codigo, usuario: 'vend1', clave: 'clavevend11', nombre: 'Vendedor', dni: '41111222', telefono: '11555', alias_cbu: 'vend1.alias' });
const v = vendedores.listar({ estado: 'pendiente' })[0];
vendedores.revisarAlta(v.usuario_id, admin.id, true);
const uid = v.usuario_id;
wallet.acreditar(uid, 1000, 'carga');

function sembrar(bin, precio, titular, dni, codigo) {
  const d = stock.base();
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  const info = d.prepare(
    'INSERT INTO cc(numero, mes, anio, cvv, bin, marca, estado, precio_num, creado, ref, titular, dni, banco, verif_estado, codigo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(stock.demoNumero(bin, 16), '12', '2028', '321', bin, 'Visa', 'DISPONIBLE', precio, new Date().toISOString(), ref, titular, dni, 'Banco Test', 'sin_verificar', codigo);
  return Number(info.lastInsertRowid);
}
const cc1 = sembrar('411111', 100, 'Titular Uno', '30111222', 'WEB1111');
const cc2 = sembrar('411111', 100, 'Titular Dos', '30222333', 'WEB2222');
const cc3 = sembrar('516585', 200, 'Titular Tres', '30333444', 'BOT3333');

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
  console.log('TEST fase 4 HTTP — ' + new Date().toISOString() + ' puerto=' + PUERTO);
  if (!(await esperar())) throw new Error('el server no arrancó:\n' + salida.slice(-2000));
  const web = cliente();
  const pre = await web('/api/auth/csrf');
  const login = await web('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': pre.j.csrf },
    body: JSON.stringify({ usuario: 'vend1', clave: 'clavevend11' }),
  });
  check('login web', login.status === 200);
  const csrf = login.j.csrf;

  /* web genera codigo; el bot lo consume */
  const gen = await web('/api/telegram/vincular', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}',
  });
  check('web genera codigo', gen.status === 201 && Boolean(gen.j.codigo), gen.j.codigo);
  const link = vinculacion.consumir(gen.j.codigo, '777');
  check('bot vincula el codigo', link.ok === true && link.usuario.id === uid);
  const est = await web('/api/telegram/estado');
  check('web ve el chat vinculado', est.status === 200 && est.j.vinculado === true, 'chat=' + est.j.telegram_id);

  /* reserva desde la WEB -> aviso encolado para ese telegram_id */
  const rw = await web('/api/catalogo/reservar', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ refs: [cc1] }),
  });
  check('reserva desde la web', rw.status === 201 && rw.j.ok === true);
  const aviso = notificaciones.pendientes(50).find((n) => n.tipo === 'reserva_asignada');
  check('aviso encolado para Telegram', aviso && String(aviso.telegram_id) === '777', 'chat=' + (aviso && aviso.telegram_id));
  check('texto del aviso menciona la reserva', aviso && /Reserva/.test(vb.notifTexto(aviso)));

  /* reserva desde el BOT (lib) -> la web ya no la ve */
  const antes = (await web('/api/catalogo')).j.total;
  const ped = vb.pedir('777', '516585', 1);
  check('pedido desde el bot', ped.ok === true && ped.grupo);
  const despues = (await web('/api/catalogo')).j.total;
  check('la web refleja la reserva del bot', despues === antes - 1, antes + ' -> ' + despues);

  /* /ok del bot se ve en la web */
  const codigo = stock.base().prepare('SELECT c.codigo FROM cc c JOIN reservas r ON r.cc_id=c.id WHERE r.grupo=?').get(ped.grupo).codigo;
  vb.pagar('777', ped.grupo);
  const okBot = vb.marcarOk('777', codigo);
  check('/ok desde el bot', okBot.ok === true, okBot.texto);
  const mis = await web('/api/catalogo/mis-reservas');
  const fila = (mis.j.reservas || []).find((r) => r.cc_id === cc3);
  check('la web ve el estado ok', fila && fila.estado === 'ok', 'estado=' + (fila && fila.estado));
  const cc3db = stock.base().prepare('SELECT estado, verif_estado FROM cc WHERE id=?').get(cc3);
  check('cc VENDIDA/verif ok en la base', cc3db.estado === 'VENDIDA' && cc3db.verif_estado === 'ok');

  /* desvincular desde la web */
  const off = await web('/api/telegram/desvincular', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}',
  });
  check('desvincular', off.status === 200);
  check('chat desvinculado', (await web('/api/telegram/estado')).j.vinculado === false);
  check('el bot ya no reconoce el chat', vb.esVendedor('777') === false);
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
