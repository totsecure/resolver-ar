#!/usr/bin/env node
/* test-auth.mjs — Fase 1: hash scrypt, sesiones, rate limit, TOTP y roles.
 * Usa una base temporal: no toca datos/stock.db.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-auth-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');

const auth = await import('../lib/auth.js');
const { base } = await import('../lib/stock.js');

let OK = 0;
let FAIL = 0;
function ok(nombre, detalle) { OK++; console.log('  OK    ' + nombre + (detalle ? ' :: ' + detalle : '')); }
function fail(nombre, detalle) { FAIL++; console.log('  FAIL  ' + nombre + ' :: ' + detalle); }
function check(nombre, cond, detalle) { cond ? ok(nombre, detalle) : fail(nombre, detalle || 'sin detalle'); }

console.log('TEST auth — ' + new Date().toISOString());
auth.migrar();

try {
  /* 1. alta de usuarios */
  const admin = auth.crearUsuario({ usuario: 'Admin', nombre: 'Dueño', rol: 'admin', clave: 'claveAdmin123' });
  check('alta admin', admin && admin.rol === 'admin' && admin.usuario === 'admin', 'usuario normalizado a minúsculas');
  let duplicado = null;
  try { auth.crearUsuario({ usuario: 'admin', rol: 'admin', clave: 'otraClave123' }); } catch (e) { duplicado = e.message; }
  check('usuario duplicado rechazado', duplicado === 'usuario ya existe', String(duplicado));
  const vend = auth.crearUsuario({ usuario: 'vendedor1', nombre: 'Vendedor', rol: 'vendedor', clave: 'claveVend123' });
  check('alta vendedor', vend.rol === 'vendedor');

  /* 2. hash scrypt con salt por usuario */
  const fila = base().prepare('SELECT hash, salt FROM usuarios WHERE usuario=?').get('admin');
  check('hash scrypt 64 bytes', /^[0-9a-f]{128}$/.test(fila.hash));
  check('salt distinto por usuario', base().prepare('SELECT salt FROM usuarios WHERE usuario=?').get('vendedor1').salt !== fila.salt);
  check('clave correcta', auth.verificarClave(admin.id, 'claveAdmin123') === true);
  check('clave incorrecta', auth.verificarClave(admin.id, 'claveAdmin124') === false);

  /* 3. login + sesión + CSRF */
  const l1 = auth.login({ usuario: 'admin', clave: 'claveAdmin123', ip: '10.0.0.1', ua: 'test' });
  check('login ok', l1.ok === true && l1.usuario.rol === 'admin');
  check('sin 2FA al inicio', l1.necesita2fa === false && l1.debeConfigurar2fa === true);
  check('csrf presente', typeof l1.csrf === 'string' && l1.csrf.length >= 20);
  const ctx = auth.sesionDeToken(l1.token);
  check('sesión válida', Boolean(ctx && ctx.usuario.id === admin.id));
  check('token no se guarda en claro', base().prepare('SELECT COUNT(*) n FROM sesiones WHERE token_hash=?').get(l1.token).n === 0);
  auth.revocarToken(l1.token);
  check('sesión revocada', auth.sesionDeToken(l1.token) === null);

  /* 4. rate limit y bloqueo temporal */
  const l2 = auth.login({ usuario: 'vendedor1', clave: 'mala', ip: '10.0.0.2' });
  check('clave mala rechazada', l2.ok === false && l2.error === 'credenciales');
  for (let i = 0; i < 4; i++) auth.login({ usuario: 'vendedor1', clave: 'mala', ip: '10.0.0.2' });
  const lock = auth.login({ usuario: 'vendedor1', clave: 'claveVend123', ip: '10.0.0.2' });
  check('bloqueo tras 5 fallas', lock.ok === false && lock.error === 'bloqueado', 'hasta=' + (lock.hasta || '-'));
  base().prepare('UPDATE usuarios SET bloqueado_hasta=NULL, intentos_fallidos=0 WHERE usuario=?').run('vendedor1');

  const lv = auth.login({ usuario: 'vendedor1', clave: 'claveVend123', ip: '10.0.0.3' });
  check('vendedor no exige 2FA', lv.ok && lv.necesita2fa === false && lv.debeConfigurar2fa === false);

  /* 5. TOTP: vector RFC 6238 (SHA1, 8 dígitos -> tomamos los 6 últimos) */
  const secretoRfc = auth.base32Codificar(Buffer.from('12345678901234567890'));
  check('base32 RFC', secretoRfc === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', secretoRfc);
  check('TOTP t=59', auth.totpEn(secretoRfc, Math.floor(59 / 30)) === '287082', auth.totpEn(secretoRfc, 1));
  check('TOTP t=1111111109', auth.totpEn(secretoRfc, Math.floor(1111111109 / 30)) === '081804');
  const ahoraMs = 1111111109000;
  const paso = Math.floor(ahoraMs / 30000);
  check('ventana +1', auth.verificarTotp(secretoRfc, auth.totpEn(secretoRfc, paso + 1), 1, ahoraMs));
  check('ventana -1', auth.verificarTotp(secretoRfc, auth.totpEn(secretoRfc, paso - 1), 1, ahoraMs));
  check('fuera de ventana', auth.verificarTotp(secretoRfc, auth.totpEn(secretoRfc, paso + 2), 1, ahoraMs) === false);

  /* 6. activar 2FA + códigos de respaldo de un solo uso */
  const l3 = auth.login({ usuario: 'admin', clave: 'claveAdmin123', ip: '10.0.0.4' });
  const setup = auth.iniciar2fa(admin.id);
  check('setup devuelve secreto y otpauth', Boolean(setup.secreto) && /^otpauth:\/\/totp\//.test(setup.otpauth));
  const codigoActivar = auth.totpEn(setup.secreto, auth.pasoActual());
  const act = auth.activar2fa(admin.id, codigoActivar);
  check('activar 2FA', act.ok === true && (act.respaldo || []).length === 10);
  check('2FA activo en la base', auth.usuarioPorId(admin.id).totp_activo === 1);
  const unRespaldo = act.respaldo[0];
  check('respaldo usado una vez', auth.consumirRespaldo(admin.id, unRespaldo) === true);
  check('respaldo no se reusa', auth.consumirRespaldo(admin.id, unRespaldo) === false);
  check('respaldos restantes', auth.respaldosDisponibles(admin.id) === 9);

  /* 7. login pide 2FA y la sesión queda pendiente hasta el código */
  const l4 = auth.login({ usuario: 'admin', clave: 'claveAdmin123', ip: '10.0.0.5' });
  check('login pide 2FA', l4.ok === true && l4.necesita2fa === true);
  check('sesión pendiente', auth.sesionDeToken(l4.token).sesion.paso2fa === 1);
  const malo = auth.verificarSegundoFactor(l4.token, '000000', '10.0.0.5');
  check('código 2FA malo rechazado', malo.ok === false);
  const codigo = auth.totpEn(auth.usuarioPorId(admin.id).totp_secret, auth.pasoActual());
  const bueno = auth.verificarSegundoFactor(l4.token, codigo, '10.0.0.5');
  check('código 2FA bueno', bueno.ok === true);
  check('sesión ya no pendiente', auth.sesionDeToken(l4.token).sesion.paso2fa === 0);

  /* 8. respaldo como segundo factor */
  const l5 = auth.login({ usuario: 'admin', clave: 'claveAdmin123', ip: '10.0.0.6' });
  const rb = auth.verificarSegundoFactor(l5.token, act.respaldo[1], '10.0.0.6');
  check('respaldo sirve como 2FA', rb.ok === true);

  /* 9. roles */
  check('admin exige 2FA', auth.requiere2fa('admin') && auth.requiere2fa('operador'));
  check('vendedor no exige 2FA', auth.requiere2fa('vendedor') === false);
  check('vendedor no ve panel', auth.puedePanel('vendedor') === false);
  check('operador ve panel', auth.puedePanel('operador') === true);
  check('permiso admin *', auth.puede('admin', 'cualquiera') === true);
  check('checker solo checker', auth.puede('checker', 'checker') && !auth.puede('checker', 'panel'));

  /* 10. cambio de clave revoca sesiones */
  const antes = auth.login({ usuario: 'vendedor1', clave: 'claveVend123', ip: '10.0.0.7' });
  auth.actualizarClave(vend.id, 'nuevaClave456');
  check('cambio de clave revoca sesiones', auth.sesionDeToken(antes.token) === null);
  check('entra con la clave nueva', auth.login({ usuario: 'vendedor1', clave: 'nuevaClave456', ip: '10.0.0.8' }).ok === true);

  /* 11. auditoría */
  const nAudit = base().prepare('SELECT COUNT(*) n FROM auditoria').get().n;
  check('auditoría escribió eventos', nAudit >= 10, 'eventos=' + nAudit);
} catch (e) {
  fail('excepción inesperada', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
