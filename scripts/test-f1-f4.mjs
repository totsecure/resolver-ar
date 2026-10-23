#!/usr/bin/env node
/* test-f1-f4.mjs — recuperación, sesiones, tokens API y 2FA/respaldos. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-f14-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');

const auth = await import('../lib/auth.js');
const vinculacion = await import('../lib/vinculacion.js');
const vb = await import('../lib/vendedor-bot.js');

let OK = 0, FAIL = 0;
const ok = (n, d) => { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); };
const fail = (n, d) => { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); };
const check = (n, c, d) => c ? ok(n, d) : fail(n, d || 'sin detalle');

console.log('TEST F — ' + new Date().toISOString());
auth.migrar();
try {
  const admin = auth.crearUsuario({ usuario: 'fadmin', nombre: 'Admin F', rol: 'admin', clave: 'claveAdminF1' });
  const u = auth.crearUsuario({ usuario: 'fvend', nombre: 'Vendedor F', rol: 'vendedor', clave: 'claveVendF1' });

  /* F1 recuperación por Telegram (y admin) */
  const chat = 99001;
  const gen = vinculacion.generar(u.id);
  const link = vb.vincular(chat, gen.codigo);
  const rec = vb.recuperar(chat);
  const nueva = String(rec.texto).match(/: ([A-Za-z0-9]+)\n/);
  check('F1 Telegram vinculado genera clave temporal', link.ok && rec.ok && nueva && auth.verificarClave(u.id, nueva[1]), rec.texto.split('\n')[0]);
  check('F1 clave anterior ya no sirve', auth.verificarClave(u.id, 'claveVendF1') === false);
  const adminReset = auth.resetearClaveTemporal(u.id);
  check('F1 admin reset', adminReset.ok && auth.verificarClave(u.id, adminReset.clave));

  /* F2 sesiones visibles y revocables, con ownership */
  const s1 = auth.login({ usuario: 'fvend', clave: adminReset.clave, ip: '10.1.1.1', ua: 'test' });
  const s2 = auth.login({ usuario: 'fadmin', clave: 'claveAdminF1', ip: '10.1.1.2', ua: 'test' });
  const activas = auth.sesionesDe(u.id);
  const ses = activas.find((x) => x.id === s1.sesion?.id) || activas[0];
  check('F2 sesiones visibles', s1.ok && activas.length >= 1 && ses.ip === '10.1.1.1', JSON.stringify(activas.map((x) => x.ip)));
  auth.revocarSesion(ses.id, admin.id);
  check('F2 no revoca sesión ajena', auth.sesionesDe(u.id).some((x) => x.id === ses.id));
  auth.revocarSesion(ses.id, u.id);
  check('F2 revoca sesión propia', !auth.sesionesDe(u.id).some((x) => x.id === ses.id));

  /* F3 tokens API por vendedor */
  const tok = auth.crearApiToken(u.id, 'integración');
  const u2 = auth.usuarioPorApiToken(tok.token);
  check('F3 token identifica vendedor', tok.ok && tok.token.startsWith('rsk_') && u2 && u2.id === u.id);
  check('F3 token listado', auth.listarApiTokens(u.id).some((x) => x.id === tok.id && !x.revocado));
  auth.revocarApiToken(u.id, tok.id);
  check('F3 token revocado', auth.usuarioPorApiToken(tok.token) === null && auth.listarApiTokens(u.id).find((x) => x.id === tok.id).revocado === 1);

  /* F4 2FA y códigos de respaldo visibles/regenerables */
  const ini = auth.iniciar2fa(u.id);
  const codigo = auth.totpEn(ini.secreto, auth.pasoActual());
  const act = auth.activar2fa(u.id, codigo);
  check('F4 activa 2FA y entrega respaldos', act.ok && act.respaldo.length === 10 && auth.respaldosDisponibles(u.id) === 10);
  const cod2 = auth.totpEn(ini.secreto, auth.pasoActual());
  const reg = auth.regenerarRespaldos(u.id, adminReset.clave, cod2);
  check('F4 regenera respaldos', reg.ok && reg.respaldo.length === 10 && auth.respaldosDisponibles(u.id) === 10);
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
