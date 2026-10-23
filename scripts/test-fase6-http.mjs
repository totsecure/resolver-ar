#!/usr/bin/env node
/* test-fase6-http.mjs — verificar lote, cola y marcado manual por HTTP. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const RAIZ = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-fase6-http-'));
const stockDb = path.join(dir, 'stock.db');
const padronDb = path.join(dir, 'padron.db');
const TOKEN = 'token-de-prueba-fase6';
const PUERTO = await puertoLibre();
function puertoLibre() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.on('error', () => resolve(0));
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const BASE = 'http://127.0.0.1:' + PUERTO;

process.env.RESOLVER_STOCK_DB = stockDb;
process.env.RESOLVER_DB = padronDb;
process.env.PUBLICAR_DIRECTO = '1';
const auth = await import('../lib/auth.js');
const checker = await import('../lib/checker.js');
const stock = await import('../lib/stock.js');

auth.migrar();
checker.migrar();
auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });
const numeros = [stock.demoNumero('411111', 16), stock.demoNumero('411111', 16), stock.demoNumero('411111', 16)];
const carga = stock.cargar(numeros.map((n) => n + '|12|28|123').join('\n'), { flexible: true, fase: 'confirmar', nombre: 'lote-http', usuario: 'test' });
const loteId = carga.lote_id;
const ids = carga.ids;

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }

const svc = (ruta, opts = {}) => fetch(BASE + ruta + (ruta.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN), opts);
const svcJson = async (ruta, opts) => { const r = await svc(ruta, opts); return { status: r.status, j: await r.json().catch(() => null) }; };
const svcPost = (ruta, cuerpo) => svcJson(ruta, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo || {}) });

const hijo = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
  cwd: RAIZ,
  env: { ...process.env, PORT: String(PUERTO), RESOLVER_TOKEN: TOKEN, RESOLVER_STOCK_DB: stockDb, RESOLVER_DB: padronDb, JOB_RESERVAS_MS: '300000', JOB_CHECKER_MS: '300000', TELEGRAM_ALLOW: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
function terminar() {
  return new Promise((resolve) => {
    if (hijo.exitCode !== null) return resolve();
    const t = setTimeout(() => { try { hijo.kill('SIGKILL'); } catch (_) {} }, 3000);
    hijo.once('close', () => { clearTimeout(t); resolve(); });
    hijo.kill('SIGTERM');
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
  console.log('TEST fase 6 HTTP — ' + new Date().toISOString() + ' puerto=' + PUERTO);
  if (!(await esperar())) throw new Error('el server no arrancó:\n' + salida.slice(-2000));

  const ini = await svcJson('/api/admin/checker');
  check('checker por HTTP', ini.status === 200 && ini.j.proveedor === 'manual' && ini.j.sin_verificar === 3, JSON.stringify(ini.j && ini.j.proveedor));

  const enc = await svcPost('/api/admin/checker/lote', { lote_id: loteId });
  check('verificar lote', enc.status === 200 && enc.j.ok && enc.j.encoladas === 3, JSON.stringify(enc.j));

  const cola = await svcJson('/api/admin/checker');
  check('cola registrada', cola.j.cola_pendiente === 3 && cola.j.cola.length === 3);
  check('cola enmascarada', cola.j.cola.every((q) => q.numero_mask.includes('xxxx')));

  const proc = await svcPost('/api/admin/checker/procesar', { n: 10 });
  check('procesar con manual no decide', proc.status === 200 && proc.j.manual === true && proc.j.procesados === 0, JSON.stringify(proc.j));

  const man = await svcPost('/api/admin/checker/cc/' + ids[0], { estado: 'ok', motivo: 'se ve bien' });
  check('marcar OK por HTTP', man.status === 200 && man.j.ok === true);
  const cola2 = await svcJson('/api/admin/checker');
  check('resultado registrado', cola2.j.resultados.length === 1 && cola2.j.resultados[0].proveedor === 'manual_admin');
  check('cola baja', cola2.j.cola_pendiente === 2);

  const falla = await svcPost('/api/admin/checker/cc/' + ids[1], { estado: 'falla', motivo: 'sin saldo' });
  check('marcar falla por HTTP', falla.status === 200 && falla.j.estado === 'falla');
  const cola3 = await svcJson('/api/admin/checker');
  check('dos resultados', cola3.j.resultados.length === 2);
  check('cc falla en lista', (cola3.j.tarjetas || []).every((c) => c.id !== ids[1]));

  await svcPost('/api/admin/checker/cc/' + ids[2], { estado: 'ok', motivo: 'ok' });
  const cola4 = await svcJson('/api/admin/checker');
  check('cola vacia', cola4.j.cola_pendiente === 0 && cola4.j.sin_verificar === 0);
  check('tres resultados', cola4.j.resultados.length === 3);

  const res = await svcJson('/api/admin/checker/resultados?lote_id=' + loteId);
  check('resultados por lote', res.status === 200 && res.j.resultados.length === 3);
  check('resultados sin PAN', res.j.resultados.every((r) => r.numero_mask.includes('xxxx')));

  const page = await svc('/panel/admin.html', { headers: { accept: 'text/html' } });
  const html = await page.text();
  check('panel tiene Checker', page.status === 200 && /Checker/.test(html));
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
