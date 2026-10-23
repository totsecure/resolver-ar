#!/usr/bin/env node
/* test-auth-http.mjs — Fase 1 de punta a punta sobre un server real.
 * Levanta server.js en un puerto aparte con base temporal. No toca producción.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const RAIZ = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-auth-http-'));
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
const TOKEN = 'token-de-prueba-fase1';

process.env.RESOLVER_STOCK_DB = stockDb;
const auth = await import('../lib/auth.js');
auth.migrar();
auth.crearUsuario({ usuario: 'admin', nombre: 'Admin Test', rol: 'admin', clave: 'claveAdmin123' });
auth.crearUsuario({ usuario: 'vendedor', nombre: 'Vendedor Test', rol: 'vendedor', clave: 'claveVend123' });

let OK = 0;
let FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, cond, d) { cond ? ok(n, d) : fail(n, d); }

function nuevoCliente() {
  const galletas = new Map();
  return async function pedir(ruta, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (galletas.size) headers.cookie = [...galletas.entries()].map(([k, v]) => k + '=' + v).join('; ');
    const r = await fetch(BASE + ruta, { ...opts, headers, redirect: 'manual' });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
      const par = c.split(';')[0];
      const i = par.indexOf('=');
      const k = par.slice(0, i);
      const v = par.slice(i + 1);
      if (!v) galletas.delete(k);
      else galletas.set(k, v);
    }
    let j = null;
    const txt = await r.text();
    try { j = JSON.parse(txt); } catch (_) {}
    return { status: r.status, j, txt, headers: r.headers, setCookie: r.headers.getSetCookie ? r.headers.getSetCookie() : [] };
  };
}

const hijo = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
  cwd: RAIZ,
  env: {
    ...process.env,
    PORT: String(PUERTO),
    RESOLVER_TOKEN: TOKEN,
    RESOLVER_STOCK_DB: stockDb,
    RESOLVER_DB: padronDb,
    TELEGRAM_ALLOW: '',
  },
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
    try {
      const r = await fetch(BASE + '/api/auth/csrf');
      if (r.ok) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

try {
  console.log('TEST auth HTTP — ' + new Date().toISOString() + ' puerto=' + PUERTO);
  if (!(await esperar())) throw new Error('el server no arrancó:\n' + salida.slice(-2000));

  /* login sin CSRF previo */
  const c0 = nuevoCliente();
  const sinCsrf = await c0('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usuario: 'admin', clave: 'claveAdmin123' }),
  });
  check('login sin CSRF da 403', sinCsrf.status === 403 && sinCsrf.j?.error === 'csrf', 'http=' + sinCsrf.status);

  /* admin: csrf previo + clave mala */
  const admin = nuevoCliente();
  const pre = await admin('/api/auth/csrf');
  check('pre-CSRF', pre.status === 200 && pre.j?.csrf, 'token=' + String(pre.j?.csrf).slice(0, 8) + '...');
  const csrf1 = pre.j.csrf;
  const mala = await admin('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf1 },
    body: JSON.stringify({ usuario: 'admin', clave: 'no-es' }),
  });
  check('clave mala da 401', mala.status === 401, 'http=' + mala.status);

  const pre2 = await admin('/api/auth/csrf');
  const login1 = await admin('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': pre2.j.csrf },
    body: JSON.stringify({ usuario: 'admin', clave: 'claveAdmin123' }),
  });
  check('login admin', login1.status === 200 && login1.j?.ok === true, 'rol=' + login1.j?.usuario?.rol);
  check('admin debe configurar 2FA', login1.j?.debeConfigurar2fa === true);
  const cookie = (login1.setCookie || []).join(' ');
  check('cookie httpOnly SameSite=Lax', /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie), cookie.replace(/resolver_sesion=[^;]+/, 'resolver_sesion=…'));
  let csrf = login1.j.csrf;

  const yo1 = await admin('/api/auth/yo');
  check('/api/auth/yo', yo1.status === 200 && yo1.j?.usuario?.usuario === 'admin');
  check('yo marca setup pendiente', yo1.j?.debeConfigurar2fa === true);

  const panelBloqueado = await admin('/panel/datos');
  check('panel bloqueado hasta 2FA', panelBloqueado.status === 403 && panelBloqueado.j?.error === '2fa_requerido', 'http=' + panelBloqueado.status);

  /* activar 2FA por HTTP */
  const ini = await admin('/api/auth/2fa/iniciar', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}',
  });
  check('2FA iniciar', ini.status === 200 && ini.j?.secreto, 'manual=' + ini.j?.manual);
  const codigoAlt = auth.totpEn(ini.j.secreto, auth.pasoActual());
  const act = await admin('/api/auth/2fa/activar', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ codigo: codigoAlt }),
  });
  check('2FA activar', act.status === 200 && (act.j?.respaldo || []).length === 10, 'respaldos=' + (act.j?.respaldo || []).length);

  /* panel habilitado para admin */
  const datos = await admin('/panel/datos');
  check('admin ve /panel/datos', datos.status === 200 && Array.isArray(datos.j?.filas), 'http=' + datos.status);

  /* CSRF en POST del panel */
  const sinCsrfPost = await admin('/panel/comprar', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  check('POST panel sin CSRF da 403', sinCsrfPost.status === 403 && sinCsrfPost.j?.error === 'csrf', 'http=' + sinCsrfPost.status);
  const conCsrfPost = await admin('/panel/comprar', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}',
  });
  check('POST panel con CSRF pasa', conCsrfPost.status === 200, 'http=' + conCsrfPost.status);

  /* logout + relogin pidiendo código */
  const out = await admin('/api/auth/logout', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}',
  });
  check('logout', out.status === 200);
  const yoOut = await admin('/api/auth/yo');
  check('sesión cerrada', yoOut.status === 401);

  const pre3 = await admin('/api/auth/csrf');
  const login2 = await admin('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': pre3.j.csrf },
    body: JSON.stringify({ usuario: 'admin', clave: 'claveAdmin123' }),
  });
  check('relogin pide 2FA', login2.status === 200 && login2.j?.necesita2fa === true);
  csrf = login2.j.csrf;
  const pendiente = await admin('/panel/datos');
  check('panel rechaza sesión 2FA pendiente', pendiente.status === 401 && pendiente.j?.error === '2fa_pendiente', 'http=' + pendiente.status);
  const secreto = auth.usuarioPorId(1).totp_secret;
  const paso2 = await admin('/api/auth/2fa', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ codigo: auth.totpEn(secreto, auth.pasoActual()) }),
  });
  check('código 2FA por HTTP', paso2.status === 200);
  const datos2 = await admin('/panel/datos');
  check('panel OK tras 2FA', datos2.status === 200, 'http=' + datos2.status);

  /* vendedor: sin 2FA, sin rutas de admin */
  const vend = nuevoCliente();
  const pv = await vend('/api/auth/csrf');
  const lv = await vend('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': pv.j.csrf },
    body: JSON.stringify({ usuario: 'vendedor', clave: 'claveVend123' }),
  });
  check('login vendedor sin 2FA', lv.status === 200 && lv.j?.necesita2fa === false && lv.j?.debeConfigurar2fa === false);
  const vPanel = await vend('/panel/datos');
  check('vendedor no ve datos de admin', vPanel.status === 403 && vPanel.j?.error === 'sin permiso', 'http=' + vPanel.status);
  const vHtml = await vend('/panel/', { headers: { accept: 'text/html' } });
  check('vendedor redirigido a /mi', vHtml.status >= 300 && vHtml.status < 400 && String(vHtml.headers.get('location')).startsWith('/mi'), 'http=' + vHtml.status + ' location=' + vHtml.headers.get('location'));
  const vMi = await vend('/mi', { headers: { accept: 'text/html' } });
  check('vendedor sí entra a /mi', vMi.status === 200 && /Mi cuenta/.test(vMi.txt));

  /* token de servicio sigue funcionando, sin cookie ni CSRF */
  const svc = await fetch(BASE + '/panel/movs?token=' + encodeURIComponent(TOKEN), { headers: { accept: 'application/json' } });
  const svcJ = await svc.json().catch(() => null);
  check('servicio ?token= en panel', svc.status === 200 && Array.isArray(svcJ?.movs), 'http=' + svc.status);
  const svcPost = await fetch(BASE + '/panel/comprar?token=' + encodeURIComponent(TOKEN), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  check('servicio POST sin CSRF', svcPost.status === 200, 'http=' + svcPost.status);

  /* página de login pública */
  const loginHtml = await fetch(BASE + '/login');
  check('/login público', loginHtml.status === 200 && /Activar 2FA|Entrar/.test(await loginHtml.text()));
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
