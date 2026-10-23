/* recargas.js — el vendedor sube comprobante; admin/operador aprueba o rechaza.
 *
 * Aprobar acredita una sola vez (estado pendiente -> aprobada, transaccional).
 * Rechazar no toca el saldo. El comprobante puede ser texto/URL o un archivo
 * chico guardado fuera de la base (datos/comprobantes).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { base } from './stock.js';
import { audit } from './auth.js';
import { aplicarTx } from './wallet.js';
import * as notificaciones from './notificaciones.js';

const RUTA_DATOS = process.env.RESOLVER_STOCK_DB
  ? path.dirname(process.env.RESOLVER_STOCK_DB)
  : path.join(import.meta.dirname, '..', 'datos');

let listo = false;
export function migrar() {
  if (listo) return base();
  const d = base();
  d.exec(
    'CREATE TABLE IF NOT EXISTS recargas(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL, monto INTEGER NOT NULL, ' +
    "comprobante TEXT, estado TEXT NOT NULL DEFAULT 'pendiente', revisado_por INTEGER, " +
    'creado TEXT NOT NULL, revisado_en TEXT, nota TEXT, archivo TEXT, archivo_nombre TEXT)'
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_recargas_estado ON recargas(estado, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_recargas_usuario ON recargas(usuario_id, id)');
  listo = true;
  return d;
}

const ahora = () => new Date().toISOString();
const TIPOS = { jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp', pdf: 'pdf' };

function guardarArchivo(data, nombre) {
  if (!data) return { archivo: null, archivo_nombre: null };
  const m = String(data).match(/^data:[^;]+;base64,(.+)$/);
  const b64 = m ? m[1] : String(data);
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return { archivo: null, archivo_nombre: null };
  if (buf.length > 2.5 * 1024 * 1024) throw new Error('archivo demasiado grande (máx 2.5 MB)');
  const ext = TIPOS[String(nombre || '').toLowerCase().split('.').pop()] || 'bin';
  const dir = path.join(RUTA_DATOS, 'comprobantes');
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, 'recarga-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext);
  fs.writeFileSync(destino, buf, { mode: 0o600 });
  return { archivo: destino, archivo_nombre: String(nombre || 'comprobante.' + ext).slice(0, 120) };
}

export function crear(usuarioId, { monto, comprobante, archivo, archivo_nombre } = {}) {
  migrar();
  const n = Number(monto);
  if (!Number.isInteger(n) || n <= 0) throw new Error('monto invalido (entero mayor a 0)');
  const texto = String(comprobante == null ? '' : comprobante).trim();
  if (!texto && !archivo) throw new Error('falta comprobante');
  const guardado = guardarArchivo(archivo, archivo_nombre);
  const info = base().prepare(
    'INSERT INTO recargas(usuario_id, monto, comprobante, estado, creado, archivo, archivo_nombre) ' +
    "VALUES(?,?,?,'pendiente',?,?,?)"
  ).run(Number(usuarioId), n, texto || null, ahora(), guardado.archivo, guardado.archivo_nombre);
  audit(usuarioId, 'RECARGA_CREAR', 'recarga', info.lastInsertRowid, 'monto=' + n, null);
  return { ok: true, id: Number(info.lastInsertRowid), monto: n, estado: 'pendiente' };
}

export function listar({ estado = null, usuarioId = null, limite = 200 } = {}) {
  migrar();
  const w = [];
  const p = [];
  if (estado) { w.push('r.estado = ?'); p.push(String(estado)); }
  if (usuarioId) { w.push('r.usuario_id = ?'); p.push(Number(usuarioId)); }
  const sql =
    'SELECT r.*, u.usuario, u.nombre FROM recargas r JOIN usuarios u ON u.id = r.usuario_id ' +
    (w.length ? 'WHERE ' + w.join(' AND ') + ' ' : '') +
    'ORDER BY r.id DESC LIMIT ?';
  p.push(Math.max(1, Math.min(1000, Number(limite) || 200)));
  return base().prepare(sql).all(...p);
}

export function revisar(id, revisorId, aprobar, nota = null) {
  migrar();
  const d = base();
  const r = d.prepare('SELECT * FROM recargas WHERE id = ?').get(Number(id));
  if (!r) return { ok: false, error: 'recarga_inexistente' };
  if (r.estado !== 'pendiente') return { ok: false, error: 'ya_revisada', estado: r.estado };
  d.exec('BEGIN IMMEDIATE');
  try {
    if (aprobar) {
      aplicarTx(d, r.usuario_id, Number(r.monto), 'recarga', 'recarga:' + r.id, nota || 'recarga aprobada');
    }
    const up = d.prepare(
      "UPDATE recargas SET estado=?, revisado_por=?, revisado_en=?, nota=COALESCE(?, nota) WHERE id=? AND estado='pendiente'"
    ).run(aprobar ? 'aprobada' : 'rechazada', Number(revisorId), ahora(), nota || null, Number(id));
    if (!up.changes) throw new Error('ya_revisada');
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    if (String(e?.message) === 'ya_revisada') return { ok: false, error: 'ya_revisada' };
    throw e;
  }
  audit(revisorId, aprobar ? 'RECARGA_APROBAR' : 'RECARGA_RECHAZAR', 'recarga', id,
    'usuario=' + r.usuario_id + ' monto=' + r.monto + (nota ? ' · ' + nota : ''), null);
  notificaciones.crear(r.usuario_id, aprobar ? 'recarga_aprobada' : 'recarga_rechazada', {
    recarga_id: id, monto: Number(r.monto), nota: nota || null,
  });
  if (aprobar) notificaciones.auditar('RECARGA APROBADA · vendedor #' + r.usuario_id + ' · $ ' + r.monto + (nota ? ' · ' + nota : ''));
  return { ok: true, estado: aprobar ? 'aprobada' : 'rechazada', monto: r.monto, usuario_id: r.usuario_id };
}

export function comprobanteDe(id) {
  migrar();
  const r = base().prepare('SELECT archivo, archivo_nombre FROM recargas WHERE id = ?').get(Number(id));
  if (!r || !r.archivo) return null;
  try { return { archivo: r.archivo, nombre: r.archivo_nombre, datos: fs.readFileSync(r.archivo) }; }
  catch (_) { return null; }
}
