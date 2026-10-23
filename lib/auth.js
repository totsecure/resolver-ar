/* auth.js — identidad, sesiones, roles y 2FA. Una sola base: datos/stock.db.
 *
 * Sin dependencias: scrypt + HMAC-SHA1 de node:crypto. La web y el bot usan
 * este mismo modulo. Ninguna regla de negocio de usuarios vive en las rutas.
 *
 * Modelo:
 *   usuarios   cuenta unica (web + bot), rol admin|operador|vendedor|checker
 *   sesiones   token opaco -> sha256(token) en la base; cookie httpOnly
 *   totp_respaldo  codigos de un solo uso (hash)
 *   auth_intentos  rate limit por IP
 *   auditoria  toda accion sensible
 */

import crypto from 'node:crypto';
import { base } from './stock.js';

export const ROLES = ['admin', 'operador', 'vendedor', 'checker'];
export const MAX_INTENTOS = Number(process.env.AUTH_MAX_INTENTOS || 5);
export const BLOQUEO_MIN = Number(process.env.AUTH_BLOQUEO_MIN || 15);
export const SESION_HORAS = Number(process.env.AUTH_SESION_HORAS || 12);
export const IP_MAX_FALLAS = Number(process.env.AUTH_IP_MAX_FALLAS || 20);
export const IP_VENTANA_MIN = Number(process.env.AUTH_IP_VENTANA_MIN || 15);

const ahora = () => new Date().toISOString();
const despues = (min) => new Date(Date.now() + min * 60000).toISOString();

export function migrar() {
  const d = base();
  d.exec(
    'CREATE TABLE IF NOT EXISTS usuarios(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT UNIQUE NOT NULL, nombre TEXT, ' +
    "rol TEXT NOT NULL DEFAULT 'vendedor', hash TEXT NOT NULL, salt TEXT NOT NULL, " +
    'totp_secret TEXT, totp_pendiente TEXT, totp_activo INTEGER NOT NULL DEFAULT 0, ' +
    'telegram_id TEXT, estado TEXT NOT NULL DEFAULT \'activo\', creado TEXT NOT NULL, ' +
    "ultimo_login TEXT, intentos_fallidos INTEGER NOT NULL DEFAULT 0, bloqueado_hasta TEXT)"
  );
  d.exec(
    'CREATE TABLE IF NOT EXISTS sesiones(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE NOT NULL, ' +
    'usuario_id INTEGER NOT NULL, creado TEXT NOT NULL, expira TEXT NOT NULL, ' +
    'ip TEXT, ua TEXT, revocado INTEGER NOT NULL DEFAULT 0, ' +
    'csrf TEXT, paso2fa INTEGER NOT NULL DEFAULT 0, intentos2fa INTEGER NOT NULL DEFAULT 0)'
  );
  d.exec(
    'CREATE TABLE IF NOT EXISTS totp_respaldo(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL, ' +
    'codigo_hash TEXT NOT NULL, usado TEXT, creado TEXT NOT NULL)'
  );
  d.exec(
    'CREATE TABLE IF NOT EXISTS auth_intentos(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT, usuario TEXT, creado TEXT NOT NULL, ok INTEGER NOT NULL)'
  );
  d.exec(
    'CREATE TABLE IF NOT EXISTS auditoria(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER, accion TEXT NOT NULL, ' +
    'entidad TEXT, entidad_id TEXT, detalle TEXT, ip TEXT, creado TEXT NOT NULL)'
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_sesiones_usuario ON sesiones(usuario_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_sesiones_token ON sesiones(token_hash)');
  d.exec(
    'CREATE TABLE IF NOT EXISTS api_tokens(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL, nombre TEXT, ' +
    'token_hash TEXT UNIQUE NOT NULL, prefijo TEXT, creado TEXT NOT NULL, ultimo_uso TEXT, revocado INTEGER NOT NULL DEFAULT 0)'
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_api_tokens_usuario ON api_tokens(usuario_id)');
  const acols = new Set(d.prepare('PRAGMA table_info(api_tokens)').all().map((c) => c.name));
  for (const [n, def] of [
    ['scopes', "TEXT NOT NULL DEFAULT '[]'"], ['expira', 'TEXT'], ['rate_limit_min', 'INTEGER NOT NULL DEFAULT 60'],
    ['ultimo_ip', 'TEXT'], ['revocado_en', 'TEXT'], ['creado_por', 'INTEGER'],
  ]) { if (!acols.has(n)) d.exec('ALTER TABLE api_tokens ADD COLUMN ' + n + ' ' + def); }
  const ucols = new Set(d.prepare('PRAGMA table_info(usuarios)').all().map((c) => c.name));
  if (!ucols.has('es_test')) d.exec('ALTER TABLE usuarios ADD COLUMN es_test INTEGER DEFAULT 0');
  d.exec('CREATE INDEX IF NOT EXISTS idx_intentos_ip ON auth_intentos(ip, creado)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_auditoria_fecha ON auditoria(creado)');
  return d;
}

/* ------------------------------ utilidades ------------------------------ */
export function igualSeguro(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const normalizarUsuario = (u) => String(u == null ? '' : u).trim().toLowerCase();

export function scryptHash(clave, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(clave), salt, 64, { N: 16384, r: 8, p: 1 });
  return { hash: hash.toString('hex'), salt: salt.toString('hex') };
}

export function verificarHash(clave, hash, salt) {
  try {
    const calc = crypto.scryptSync(String(clave), Buffer.from(String(salt), 'hex'), 64, { N: 16384, r: 8, p: 1 });
    const guardado = Buffer.from(String(hash), 'hex');
    if (calc.length !== guardado.length) return false;
    return crypto.timingSafeEqual(calc, guardado);
  } catch (_) {
    return false;
  }
}

function filaUsuario(usuario) {
  const u = normalizarUsuario(usuario);
  if (!u) return null;
  return base().prepare('SELECT * FROM usuarios WHERE usuario = ?').get(u) || null;
}

export function usuarioPorId(id) {
  return base().prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(id)) || null;
}

export function publico(u) {
  if (!u) return null;
  return {
    id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol,
    totp_activo: Boolean(u.totp_activo), estado: u.estado,
    telegram_id: u.telegram_id || null, creado: u.creado, ultimo_login: u.ultimo_login,
  };
}

/* ------------------------------- usuarios -------------------------------- */
export function crearUsuario({ usuario, nombre, rol = 'vendedor', clave, estado = 'activo', telegram_id = null, es_test = 0 }) {
  migrar();
  const u = normalizarUsuario(usuario);
  if (!/^[a-z0-9._-]{3,40}$/.test(u)) throw new Error('usuario invalido (3-40: a-z 0-9 . _ -)');
  if (!ROLES.includes(rol)) throw new Error('rol invalido');
  if (!clave || String(clave).length < 8) throw new Error('clave minima 8 caracteres');
  const { hash, salt } = scryptHash(clave);
  const d = base();
  try {
    const info = d.prepare(
      'INSERT INTO usuarios(usuario, nombre, rol, hash, salt, estado, creado, telegram_id, es_test) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(u, nombre || u, rol, hash, salt, estado, ahora(), telegram_id, es_test ? 1 : 0);
    return publico(usuarioPorId(Number(info.lastInsertRowid)));
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message || e))) throw new Error('usuario ya existe');
    throw e;
  }
}

export function verificarClave(usuarioId, clave) {
  const u = usuarioPorId(usuarioId);
  if (!u) return false;
  return verificarHash(clave, u.hash, u.salt);
}

export function actualizarClave(usuarioId, clave) {
  if (!clave || String(clave).length < 8) throw new Error('clave minima 8 caracteres');
  const { hash, salt } = scryptHash(clave);
  base().prepare('UPDATE usuarios SET hash=?, salt=?, intentos_fallidos=0, bloqueado_hasta=NULL WHERE id=?')
    .run(hash, salt, Number(usuarioId));
  revocarSesionesDe(Number(usuarioId));
  return true;
}

export function setEstado(usuarioId, estado) {
  if (!['activo', 'suspendido', 'revision'].includes(estado)) throw new Error('estado invalido');
  base().prepare('UPDATE usuarios SET estado=? WHERE id=?').run(estado, Number(usuarioId));
  if (estado !== 'activo') revocarSesionesDe(Number(usuarioId));
  return true;
}

export function listarUsuarios() {
  migrar();
  return base().prepare('SELECT * FROM usuarios ORDER BY id').all().map(publico);
}

/* ------------------------------ rate limit ------------------------------- */
function fallasIp(ip) {
  if (!ip) return 0;
  const desde = new Date(Date.now() - IP_VENTANA_MIN * 60000).toISOString();
  return base().prepare('SELECT COUNT(*) n FROM auth_intentos WHERE ip=? AND ok=0 AND creado>=?').get(ip, desde).n;
}

function registrarIntento(ip, usuario, ok) {
  try {
    base().prepare('INSERT INTO auth_intentos(ip, usuario, creado, ok) VALUES(?,?,?,?)')
      .run(ip || null, usuario || null, ahora(), ok ? 1 : 0);
  } catch (_) {}
}

export function audit(usuarioId, accion, entidad, entidadId, detalle, ip) {
  try {
    base().prepare('INSERT INTO auditoria(usuario_id, accion, entidad, entidad_id, detalle, ip, creado) VALUES(?,?,?,?,?,?,?)')
      .run(usuarioId == null ? null : Number(usuarioId), String(accion), entidad || null,
        entidadId == null ? null : String(entidadId), detalle == null ? null : String(detalle), ip || null, ahora());
  } catch (_) {}
}

export function accesos(limite = 200) {
  migrar();
  return base().prepare(
    'SELECT id, ip, usuario, creado, ok FROM auth_intentos ORDER BY id DESC LIMIT ?'
  ).all(Math.max(1, Math.min(2000, Number(limite) || 200)));
}

export function auditoria(limite = 200) {
  migrar();
  return base().prepare(
    'SELECT a.*, u.usuario FROM auditoria a LEFT JOIN usuarios u ON u.id=a.usuario_id ORDER BY a.id DESC LIMIT ?'
  ).all(Math.max(1, Math.min(2000, Number(limite) || 200)));
}

/** Clave temporal para recuperación por Telegram (el usuario debe cambiarla). */
export function resetearClaveTemporal(usuarioId) {
  const u = usuarioPorId(usuarioId);
  if (!u) return { ok: false, error: 'usuario_inexistente' };
  if (u.estado !== 'activo') return { ok: false, error: 'usuario_inactivo' };
  const clave = crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  actualizarClave(u.id, clave);
  audit(u.id, 'CLAVE_RECUPERAR', 'usuario', u.id, 'temporal por Telegram', null);
  return { ok: true, usuario: u.usuario, clave };
}

function hashApiToken(token) {
  return crypto.createHash('sha256').update('api:' + String(token)).digest('hex');
}

export const SCOPES = [
  'catalogo:read', 'catalogo:reserve', 'catalogo:pay',
  'wallet:read', 'pedidos:read', 'pedidos:write',
  'admin:read', 'admin:write',
];

export function crearApiToken(usuarioId, nombre = null, scopes = null) {
  migrar();
  const u = usuarioPorId(Number(usuarioId));
  if (!u) throw new Error('usuario_inexistente');
  let lista = Array.isArray(scopes) && scopes.length ? scopes.map(String) : ['catalogo:read', 'wallet:read', 'pedidos:read'];
  for (const sc of lista) if (!SCOPES.includes(sc)) throw new Error('scope_invalido:' + sc);
  if (lista.some((sc) => sc.startsWith('admin:')) && u.rol !== 'admin') throw new Error('scope_admin_requiere_admin');
  const token = 'rsk_' + crypto.randomBytes(24).toString('base64url');
  const prefijo = token.slice(0, 12) + '…';
  const info = base().prepare(
    'INSERT INTO api_tokens(usuario_id, nombre, token_hash, prefijo, creado, scopes) VALUES(?,?,?,?,?,?)'
  ).run(Number(usuarioId), nombre ? String(nombre).slice(0, 80) : null, hashApiToken(token), prefijo, ahora(), JSON.stringify(lista));
  audit(usuarioId, 'TOKEN_CREAR', 'api_token', info.lastInsertRowid, prefijo + ' scopes=' + lista.join(','), null);
  return { ok: true, id: Number(info.lastInsertRowid), token, prefijo, nombre: nombre || null, scopes: lista };
}

export function listarApiTokens(usuarioId) {
  migrar();
  return base().prepare(
    'SELECT id, nombre, prefijo, creado, ultimo_uso, revocado, scopes, expira, rate_limit_min FROM api_tokens WHERE usuario_id=? ORDER BY id DESC'
  ).all(Number(usuarioId));
}

export function revocarApiToken(usuarioId, id) {
  migrar();
  const r = base().prepare('UPDATE api_tokens SET revocado=1, revocado_en=? WHERE id=? AND usuario_id=?').run(ahora(), Number(id), Number(usuarioId));
  if (!r.changes) return { ok: false, error: 'token_inexistente' };
  audit(usuarioId, 'TOKEN_REVOCAR', 'api_token', id, null, null);
  return { ok: true };
}

export function usuarioPorApiToken(token, ip = null) {
  if (!token) return null;
  migrar();
  const f = base().prepare('SELECT * FROM api_tokens WHERE token_hash=? AND COALESCE(revocado,0)=0').get(hashApiToken(token));
  if (!f) return null;
  if (f.expira && String(f.expira) < ahora()) return null;
  const u = usuarioPorId(f.usuario_id);
  if (!u || u.estado !== 'activo') return null;
  let scopes = [];
  try { scopes = JSON.parse(f.scopes || '[]'); } catch (_) { scopes = []; }
  base().prepare('UPDATE api_tokens SET ultimo_uso=?, ultimo_ip=? WHERE id=?').run(ahora(), ip == null ? null : String(ip), f.id);
  return { ...u, api_scopes: Array.isArray(scopes) ? scopes : [], api_token_id: Number(f.id), api_rate_limit: Number(f.rate_limit_min || 60) };
}

/* -------------------------------- sesiones -------------------------------- */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function nuevaSesion(usuario, { ip, ua, paso2fa = 0 }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expira = new Date(Date.now() + SESION_HORAS * 3600000).toISOString();
  const d = base();
  try { d.prepare('DELETE FROM sesiones WHERE expira < ?').run(ahora()); } catch (_) {}
  d.prepare(
    'INSERT INTO sesiones(token_hash, usuario_id, creado, expira, ip, ua, revocado, csrf, paso2fa, intentos2fa) ' +
    'VALUES(?,?,?,?,?,?,0,?,?,0)'
  ).run(hashToken(token), Number(usuario.id), ahora(), expira, ip || null, ua || null, csrf, paso2fa ? 1 : 0);
  return { token, csrf, expira };
}

/** Devuelve {usuario, sesion} o null. No revela por que fallo. */
export function sesionDeToken(token) {
  if (!token) return null;
  const s = base().prepare('SELECT * FROM sesiones WHERE token_hash = ?').get(hashToken(token));
  if (!s || s.revocado) return null;
  if (String(s.expira) < ahora()) return null;
  const u = usuarioPorId(s.usuario_id);
  if (!u || u.estado !== 'activo') return null;
  return { usuario: u, sesion: s };
}

export function revocarToken(token) {
  if (!token) return false;
  const r = base().prepare('UPDATE sesiones SET revocado=1 WHERE token_hash=?').run(hashToken(token));
  return r.changes > 0;
}

export function revocarSesionesDe(usuarioId) {
  base().prepare('UPDATE sesiones SET revocado=1 WHERE usuario_id=?').run(Number(usuarioId));
}

export function sesionesDe(usuarioId, soloActivas = true) {
  migrar();
  const filas = base().prepare('SELECT * FROM sesiones WHERE usuario_id=? ORDER BY id DESC').all(Number(usuarioId));
  return filas
    .filter((s) => !soloActivas || (!s.revocado && String(s.expira) >= ahora()))
    .map((s) => ({ id: s.id, creado: s.creado, expira: s.expira, ip: s.ip, ua: s.ua, revocado: Boolean(s.revocado) }));
}

export function revocarSesion(id, usuarioId = null) {
  const sql = usuarioId == null
    ? 'UPDATE sesiones SET revocado=1 WHERE id=?'
    : 'UPDATE sesiones SET revocado=1 WHERE id=? AND usuario_id=?';
  const args = usuarioId == null ? [Number(id)] : [Number(id), Number(usuarioId)];
  base().prepare(sql).run(...args);
  return true;
}

/* --------------------------------- login --------------------------------- */
export function requiere2fa(rol) {
  return rol === 'admin' || rol === 'operador';
}

/**
 * login({usuario, clave, ip, ua}) ->
 *   {ok:true, token, csrf, expira, usuario, necesita2fa, debeConfigurar2fa}
 *   | {ok:false, error, hasta?}
 */
export function login({ usuario, clave, ip, ua } = {}) {
  migrar();
  const d = base();
  const nombre = normalizarUsuario(usuario);

  if (fallasIp(ip) >= IP_MAX_FALLAS) {
    return { ok: false, error: 'demasiados_intentos', detalle: 'Demasiados intentos desde esta IP. Esperá unos minutos.' };
  }

  const u = filaUsuario(nombre);
  if (!u) {
    registrarIntento(ip, nombre, false);
    audit(null, 'LOGIN_FALLA', 'usuario', nombre, 'usuario inexistente', ip);
    return { ok: false, error: 'credenciales', detalle: 'Usuario o contraseña incorrectos.' };
  }
  if (u.estado !== 'activo') {
    registrarIntento(ip, nombre, false);
    audit(u.id, 'LOGIN_FALLA', 'usuario', u.id, 'estado ' + u.estado, ip);
    return { ok: false, error: 'suspendido', detalle: 'La cuenta no está activa.' };
  }
  if (u.bloqueado_hasta && String(u.bloqueado_hasta) > ahora()) {
    registrarIntento(ip, nombre, false);
    return { ok: false, error: 'bloqueado', hasta: u.bloqueado_hasta, detalle: 'Cuenta bloqueada temporalmente.' };
  }

  if (!verificarHash(clave, u.hash, u.salt)) {
    const fallas = Number(u.intentos_fallidos || 0) + 1;
    if (fallas >= MAX_INTENTOS) {
      const hasta = despues(BLOQUEO_MIN);
      d.prepare('UPDATE usuarios SET intentos_fallidos=?, bloqueado_hasta=? WHERE id=?').run(fallas, hasta, u.id);
      registrarIntento(ip, nombre, false);
      audit(u.id, 'LOGIN_BLOQUEO', 'usuario', u.id, 'fallas=' + fallas, ip);
      return { ok: false, error: 'bloqueado', hasta, detalle: 'Demasiados intentos. Cuenta bloqueada ' + BLOQUEO_MIN + ' minutos.' };
    }
    d.prepare('UPDATE usuarios SET intentos_fallidos=? WHERE id=?').run(fallas, u.id);
    registrarIntento(ip, nombre, false);
    audit(u.id, 'LOGIN_FALLA', 'usuario', u.id, 'clave incorrecta (' + fallas + ')', ip);
    return { ok: false, error: 'credenciales', detalle: 'Usuario o contraseña incorrectos.' };
  }

  d.prepare('UPDATE usuarios SET intentos_fallidos=0, bloqueado_hasta=NULL, ultimo_login=? WHERE id=?').run(ahora(), u.id);
  registrarIntento(ip, nombre, true);
  const necesita2fa = Boolean(u.totp_activo);
  const s = nuevaSesion(u, { ip, ua, paso2fa: necesita2fa ? 1 : 0 });
  audit(u.id, necesita2fa ? 'LOGIN_1F' : 'LOGIN', 'usuario', u.id, 'rol=' + u.rol, ip);
  const fresco = usuarioPorId(u.id);
  return {
    ok: true,
    token: s.token,
    csrf: s.csrf,
    expira: s.expira,
    usuario: publico(fresco),
    necesita2fa,
    debeConfigurar2fa: requiere2fa(u.rol) && !necesita2fa,
  };
}

/* ---------------------------------- TOTP --------------------------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Codificar(buf) {
  let bits = 0;
  let valor = 0;
  let salida = '';
  for (const byte of buf) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += B32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += B32[(valor << (5 - bits)) & 31];
  return salida;
}

export function base32Decodificar(texto) {
  const limpio = String(texto || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let valor = 0;
  const salida = [];
  for (const ch of limpio) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      salida.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(salida);
}

export function generarSecretoTotp(bytes = 20) {
  return base32Codificar(crypto.randomBytes(bytes));
}

export function totpEn(secreto, paso) {
  const key = base32Decodificar(secreto);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(paso));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}

export function pasoActual() {
  return Math.floor(Date.now() / 30000);
}

/** Verifica codigo de 6 digitos con ventana ±1 (30 s por paso). */
export function verificarTotp(secreto, codigo, ventana = 1, ahoraMs = Date.now()) {
  const c = String(codigo == null ? '' : codigo).replace(/\D/g, '');
  if (!secreto || c.length !== 6) return false;
  const paso = Math.floor(ahoraMs / 30000);
  for (let i = -ventana; i <= ventana; i++) {
    if (igualSeguro(totpEn(secreto, paso + i), c)) return true;
  }
  return false;
}

export function urlOtpauth(usuario, secreto, emisor = 'resolver-ar') {
  return 'otpauth://totp/' + encodeURIComponent(emisor + ':' + usuario) +
    '?secret=' + encodeURIComponent(secreto) + '&issuer=' + encodeURIComponent(emisor) +
    '&algorithm=SHA1&digits=6&period=30';
}

/* --------------------------- codigos de respaldo -------------------------- */
const normCodigo = (c) => String(c == null ? '' : c).toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashRespaldo = (usuarioId, codigo) =>
  crypto.createHash('sha256').update('respaldo:' + usuarioId + ':' + normCodigo(codigo)).digest('hex');

function generarCodigosRespaldo(usuarioId, cantidad = 10) {
  const d = base();
  d.prepare('DELETE FROM totp_respaldo WHERE usuario_id=?').run(Number(usuarioId));
  const planos = [];
  const ins = d.prepare('INSERT INTO totp_respaldo(usuario_id, codigo_hash, usado, creado) VALUES(?,?,NULL,?)');
  for (let i = 0; i < cantidad; i++) {
    const crudo = base32Codificar(crypto.randomBytes(5)).slice(0, 8);
    const bonito = crudo.slice(0, 4) + '-' + crudo.slice(4);
    ins.run(Number(usuarioId), hashRespaldo(usuarioId, crudo), ahora());
    planos.push(bonito);
  }
  return planos;
}

export function consumirRespaldo(usuarioId, codigo) {
  const h = hashRespaldo(usuarioId, codigo);
  const fila = base().prepare('SELECT * FROM totp_respaldo WHERE usuario_id=? AND codigo_hash=? AND usado IS NULL')
    .get(Number(usuarioId), h);
  if (!fila) return false;
  const r = base().prepare('UPDATE totp_respaldo SET usado=? WHERE id=? AND usado IS NULL').run(ahora(), fila.id);
  return r.changes > 0;
}

export function respaldosDisponibles(usuarioId) {
  return base().prepare('SELECT COUNT(*) n FROM totp_respaldo WHERE usuario_id=? AND usado IS NULL')
    .get(Number(usuarioId)).n;
}

/* -------------------------------- 2FA flujo ------------------------------- */
/** Paso 1: secreto pendiente + URL para el authenticator. */
export function iniciar2fa(usuarioId) {
  const u = usuarioPorId(usuarioId);
  if (!u) throw new Error('usuario inexistente');
  const secreto = generarSecretoTotp();
  base().prepare('UPDATE usuarios SET totp_pendiente=? WHERE id=?').run(secreto, u.id);
  audit(u.id, '2FA_INICIAR', 'usuario', u.id, null, null);
  return { secreto, otpauth: urlOtpauth(u.usuario, secreto), manual: secreto.match(/.{1,4}/g).join(' ') };
}

/** Paso 2: confirma el codigo, activa y devuelve codigos de respaldo (una vez). */
export function activar2fa(usuarioId, codigo) {
  const u = usuarioPorId(usuarioId);
  if (!u || !u.totp_pendiente) return { ok: false, error: 'sin_setup' };
  if (!verificarTotp(u.totp_pendiente, codigo)) return { ok: false, error: 'codigo' };
  base().prepare('UPDATE usuarios SET totp_secret=?, totp_activo=1, totp_pendiente=NULL WHERE id=?')
    .run(u.totp_pendiente, u.id);
  const respaldo = generarCodigosRespaldo(u.id);
  audit(u.id, '2FA_ACTIVAR', 'usuario', u.id, null, null);
  return { ok: true, respaldo };
}

/** Regenera y devuelve códigos nuevos; invalida los anteriores. */
export function regenerarRespaldos(usuarioId, clave, codigo) {
  const u = usuarioPorId(usuarioId);
  if (!u) return { ok: false, error: 'usuario' };
  if (!u.totp_activo || !u.totp_secret) return { ok: false, error: '2fa_inactivo' };
  if (!verificarClave(usuarioId, clave)) return { ok: false, error: 'clave' };
  const valido = verificarTotp(u.totp_secret, codigo) || consumirRespaldo(u.id, codigo);
  if (!valido) return { ok: false, error: 'codigo' };
  const respaldo = generarCodigosRespaldo(u.id);
  audit(u.id, '2FA_RESPALDOS', 'usuario', u.id, 'regenerados', null);
  return { ok: true, respaldo, cantidad: respaldo.length };
}

export function desactivar2fa(usuarioId, clave, codigo) {
  const u = usuarioPorId(usuarioId);
  if (!u) return { ok: false, error: 'usuario' };
  if (!verificarHash(clave, u.hash, u.salt)) return { ok: false, error: 'clave' };
  const valido = verificarTotp(u.totp_secret, codigo) || consumirRespaldo(u.id, codigo);
  if (!valido) return { ok: false, error: 'codigo' };
  base().prepare('UPDATE usuarios SET totp_secret=NULL, totp_activo=0, totp_pendiente=NULL WHERE id=?').run(u.id);
  base().prepare('DELETE FROM totp_respaldo WHERE usuario_id=?').run(u.id);
  audit(u.id, '2FA_DESACTIVAR', 'usuario', u.id, null, null);
  return { ok: true };
}

/**
 * Segundo factor de una sesion pendiente. Acepta TOTP o codigo de respaldo.
 * Tras 5 fallas la sesion se revoca.
 */
export function verificarSegundoFactor(token, codigo, ip) {
  const ctx = sesionDeToken(token);
  if (!ctx) return { ok: false, error: 'sesion' };
  if (!ctx.sesion.paso2fa) return { ok: true, ya: true };
  const u = ctx.usuario;
  if (u.estado !== 'activo') return { ok: false, error: 'suspendido' };
  const esTotp = verificarTotp(u.totp_secret, codigo);
  const esRespaldo = !esTotp && consumirRespaldo(u.id, codigo);
  if (!esTotp && !esRespaldo) {
    const fallas = Number(ctx.sesion.intentos2fa || 0) + 1;
    if (fallas >= MAX_INTENTOS) {
      revocarToken(token);
      audit(u.id, '2FA_BLOQUEO', 'sesion', ctx.sesion.id, 'fallas=' + fallas, ip);
      return { ok: false, error: 'sesion_revocada' };
    }
    base().prepare('UPDATE sesiones SET intentos2fa=? WHERE id=?').run(fallas, ctx.sesion.id);
    audit(u.id, '2FA_FALLA', 'sesion', ctx.sesion.id, 'fallas=' + fallas, ip);
    return { ok: false, error: 'codigo' };
  }
  base().prepare('UPDATE sesiones SET paso2fa=0, intentos2fa=0 WHERE id=?').run(ctx.sesion.id);
  audit(u.id, esRespaldo ? '2FA_RESPALDO' : '2FA_OK', 'sesion', ctx.sesion.id, null, ip);
  return { ok: true };
}

/** Sesion ya autenticada que activa 2FA: recalcula el estado. */
export function estado2fa(usuarioId) {
  const u = usuarioPorId(usuarioId);
  return { activo: Boolean(u && u.totp_activo), respaldos: u ? respaldosDisponibles(u.id) : 0 };
}

/* ------------------------------- permisos --------------------------------- */
export const PERMISOS = {
  admin: ['*'],
  operador: ['panel', 'stock', 'ventas', 'recargas', 'reclamos'],
  vendedor: ['catalogo', 'wallet', 'compras', 'perfil'],
  checker: ['checker', 'perfil'],
};

export function puede(rol, permiso) {
  const p = PERMISOS[rol] || [];
  return p.includes('*') || p.includes(permiso);
}

export function puedePanel(rol) {
  return rol === 'admin' || rol === 'operador';
}
