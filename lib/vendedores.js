/* vendedores.js — alta por invitacion de un solo uso + aprobacion del admin.
 *
 * La cuenta vive en `usuarios` (lib/auth.js); los datos comerciales y los
 * limites viven en `vendedores`. Un vendedor recien registrado queda
 * `pendiente` y no puede entrar hasta que un admin lo aprueba.
 */
import crypto from 'node:crypto';
import { base } from './stock.js';
import { crearUsuario, audit, base32Codificar } from './auth.js';
import { saldoDe } from './wallet.js';

let listo = false;
export function migrar() {
  if (listo) return base();
  const d = base();
  d.exec(
    'CREATE TABLE IF NOT EXISTS vendedores(' +
    'usuario_id INTEGER PRIMARY KEY, dni TEXT, telefono TEXT, alias_cbu TEXT, ' +
    'comision REAL NOT NULL DEFAULT 0, limite_reservas_dia INTEGER NOT NULL DEFAULT 10, ' +
    'limite_simultaneas INTEGER NOT NULL DEFAULT 3, aprobado_por INTEGER, aprobado_en TEXT, ' +
    "estado TEXT NOT NULL DEFAULT 'pendiente', creado TEXT)"
  );
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_vendedores_dni ON vendedores(dni) WHERE dni IS NOT NULL');
  d.exec(
    'CREATE TABLE IF NOT EXISTS invitaciones(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, codigo_hash TEXT UNIQUE NOT NULL, creado TEXT NOT NULL, ' +
    'expira TEXT NOT NULL, usado TEXT, usado_por INTEGER, creado_por INTEGER, nota TEXT)'
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_invitaciones_estado ON invitaciones(usado, expira)');
  listo = true;
  return d;
}

const ahora = () => new Date().toISOString();
const soloDigitos = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const hashCodigo = (c) => crypto.createHash('sha256').update(String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

function normalizarCodigo(c) {
  return String(c == null ? '' : c).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Genera una invitacion de un solo uso. Devuelve el codigo en claro UNA vez. */
export function crearInvitacion({ creadoPor = null, dias = 7, nota = null } = {}) {
  migrar();
  const codigo = base32Codificar(crypto.randomBytes(8)).slice(0, 10);
  const expira = new Date(Date.now() + Math.max(1, Number(dias) || 7) * 86400000).toISOString();
  base().prepare('INSERT INTO invitaciones(codigo_hash, creado, expira, creado_por, nota) VALUES(?,?,?,?,?)')
    .run(hashCodigo(codigo), ahora(), expira, creadoPor == null ? null : Number(creadoPor), nota || null);
  audit(creadoPor, 'INVITACION_CREAR', 'invitacion', null, 'expira=' + expira, null);
  return { codigo: codigo.slice(0, 5) + '-' + codigo.slice(5), expira, dias: Number(dias) || 7 };
}

export function listarInvitaciones(limite = 100) {
  migrar();
  return base().prepare(
    'SELECT i.id, i.creado, i.expira, i.usado, i.usado_por, i.creado_por, i.nota, u.usuario AS usado_por_usuario ' +
    'FROM invitaciones i LEFT JOIN usuarios u ON u.id = i.usado_por ORDER BY i.id DESC LIMIT ?'
  ).all(Math.max(1, Number(limite) || 100));
}

export function invitacionValida(codigo) {
  migrar();
  const norm = normalizarCodigo(codigo);
  if (norm.length < 6) return null;
  const f = base().prepare('SELECT * FROM invitaciones WHERE codigo_hash = ?').get(hashCodigo(norm));
  if (!f || f.usado) return null;
  if (String(f.expira) < ahora()) return null;
  return f;
}

/**
 * Registro publico de vendedor. Consume la invitacion y deja la cuenta
 * pendiente de aprobacion. Todo o nada.
 */
export function registrar({ codigo, usuario, clave, nombre, dni, telefono, alias_cbu, es_test = 0 }) {
  migrar();
  const d = base();
  const dniLimpio = soloDigitos(dni);
  const tel = String(telefono == null ? '' : telefono).trim();
  const alias = String(alias_cbu == null ? '' : alias_cbu).trim();
  const nom = String(nombre == null ? '' : nombre).trim();
  if (!nom) throw new Error('falta nombre');
  if (dniLimpio.length < 7 || dniLimpio.length > 8) throw new Error('dni invalido');
  if (!tel) throw new Error('falta telefono');
  if (!alias) throw new Error('falta alias/CBU');

  const inv = invitacionValida(codigo);
  if (!inv) throw new Error('invitacion invalida o vencida');

  d.exec('BEGIN IMMEDIATE');
  try {
    /* Re-chequear dentro de la transaccion: dos registros con el mismo codigo. */
    const usado = d.prepare('SELECT usado FROM invitaciones WHERE id = ?').get(inv.id);
    if (!usado || usado.usado) throw new Error('invitacion ya usada');
    if (d.prepare('SELECT 1 FROM vendedores WHERE dni = ?').get(dniLimpio)) throw new Error('dni ya registrado');

    const u = crearUsuario({ usuario, nombre: nom, rol: 'vendedor', clave, estado: 'pendiente', es_test });
    d.prepare(
      'INSERT INTO vendedores(usuario_id, dni, telefono, alias_cbu, estado, creado) VALUES(?,?,?,?,?,?)'
    ).run(u.id, dniLimpio, tel, alias, 'pendiente', ahora());
    const r = d.prepare('UPDATE invitaciones SET usado=?, usado_por=? WHERE id=? AND usado IS NULL')
      .run(ahora(), u.id, inv.id);
    if (!r.changes) throw new Error('invitacion ya usada');
    d.exec('COMMIT');
    audit(u.id, 'VENDEDOR_REGISTRO', 'usuario', u.id, 'dni=' + dniLimpio, null);
    return { ok: true, usuario: u.usuario, estado: 'pendiente', mensaje: 'Cuenta creada. Falta la aprobación del administrador.' };
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

export function porUsuario(usuarioId) {
  migrar();
  return base().prepare(
    'SELECT v.*, u.usuario, u.nombre, u.estado AS usuario_estado, u.creado AS cuenta_creada, u.ultimo_login ' +
    'FROM vendedores v JOIN usuarios u ON u.id = v.usuario_id WHERE v.usuario_id = ?'
  ).get(Number(usuarioId)) || null;
}

export function perfil(usuarioId) {
  const v = porUsuario(usuarioId);
  if (!v) return null;
  return {
    usuario_id: v.usuario_id, usuario: v.usuario, nombre: v.nombre, dni: v.dni,
    telefono: v.telefono, alias_cbu: v.alias_cbu, comision: v.comision,
    limite_reservas_dia: v.limite_reservas_dia, limite_simultaneas: v.limite_simultaneas,
    estado: v.estado, aprobado_en: v.aprobado_en, saldo: saldoDe(v.usuario_id),
  };
}

export function actualizarDatos(usuarioId, { telefono, alias_cbu, nombre }) {
  migrar();
  const d = base();
  const v = porUsuario(usuarioId);
  if (!v) throw new Error('vendedor inexistente');
  if (telefono != null && String(telefono).trim()) d.prepare('UPDATE vendedores SET telefono=? WHERE usuario_id=?').run(String(telefono).trim(), Number(usuarioId));
  if (alias_cbu != null && String(alias_cbu).trim()) d.prepare('UPDATE vendedores SET alias_cbu=? WHERE usuario_id=?').run(String(alias_cbu).trim(), Number(usuarioId));
  if (nombre != null && String(nombre).trim()) d.prepare('UPDATE usuarios SET nombre=? WHERE id=?').run(String(nombre).trim(), Number(usuarioId));
  audit(usuarioId, 'VENDEDOR_DATOS', 'usuario', usuarioId, null, null);
  return perfil(usuarioId);
}

export function listar({ estado = null } = {}) {
  migrar();
  const sql =
    'SELECT v.*, u.usuario, u.nombre, u.estado AS usuario_estado, u.ultimo_login, ' +
    'COALESCE(s.saldo, 0) AS saldo ' +
    'FROM vendedores v JOIN usuarios u ON u.id = v.usuario_id ' +
    'LEFT JOIN saldos s ON s.usuario_id = v.usuario_id ' +
    (estado ? 'WHERE v.estado = ? ' : '') +
    'ORDER BY v.estado, v.usuario_id';
  return (estado ? base().prepare(sql).all(String(estado)) : base().prepare(sql).all());
}

/** Aprueba o rechaza. Solo desde admin (la ruta lo exige). */
export function revisarAlta(usuarioId, adminId, aprobar, nota = null) {
  migrar();
  const d = base();
  const v = porUsuario(usuarioId);
  if (!v) return { ok: false, error: 'vendedor_inexistente' };
  if (v.estado !== 'pendiente') return { ok: false, error: 'ya_revisado', estado: v.estado };
  d.exec('BEGIN IMMEDIATE');
  try {
    if (aprobar) {
      d.prepare("UPDATE vendedores SET estado='activo', aprobado_por=?, aprobado_en=? WHERE usuario_id=?")
        .run(Number(adminId), ahora(), Number(usuarioId));
      d.prepare("UPDATE usuarios SET estado='activo' WHERE id=?").run(Number(usuarioId));
    } else {
      d.prepare("UPDATE vendedores SET estado='rechazado', aprobado_por=?, aprobado_en=? WHERE usuario_id=?")
        .run(Number(adminId), ahora(), Number(usuarioId));
      d.prepare("UPDATE usuarios SET estado='suspendido' WHERE id=?").run(Number(usuarioId));
    }
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
  audit(adminId, aprobar ? 'VENDEDOR_APROBAR' : 'VENDEDOR_RECHAZAR', 'usuario', usuarioId, nota || null, null);
  return { ok: true, estado: aprobar ? 'activo' : 'rechazado' };
}

export function setLimites(usuarioId, { limite_reservas_dia, limite_simultaneas, comision }) {
  migrar();
  const d = base();
  const v = porUsuario(usuarioId);
  if (!v) return { ok: false, error: 'vendedor_inexistente' };
  if (limite_reservas_dia != null) d.prepare('UPDATE vendedores SET limite_reservas_dia=? WHERE usuario_id=?').run(Math.max(0, Number(limite_reservas_dia)), Number(usuarioId));
  if (limite_simultaneas != null) d.prepare('UPDATE vendedores SET limite_simultaneas=? WHERE usuario_id=?').run(Math.max(0, Number(limite_simultaneas)), Number(usuarioId));
  if (comision != null) d.prepare('UPDATE vendedores SET comision=? WHERE usuario_id=?').run(Number(comision), Number(usuarioId));
  audit(null, 'VENDEDOR_LIMITES', 'usuario', usuarioId, JSON.stringify({ limite_reservas_dia, limite_simultaneas, comision }), null);
  return { ok: true, perfil: perfil(usuarioId) };
}
