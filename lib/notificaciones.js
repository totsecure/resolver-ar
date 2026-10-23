/* notificaciones.js — cola unica para el bot.
 *
 * La web y el bot solo escriben/leen esta tabla. El bot la drena cada pocos
 * segundos. `canal='audit'` va al canal de Telegram de auditoria.
 */
import { base } from './stock.js';

let listo = false;
export function migrar() {
  if (listo) return base();
  const d = base();
  d.exec(
    'CREATE TABLE IF NOT EXISTS notificaciones(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER, tipo TEXT NOT NULL, ' +
    "payload TEXT, enviado TEXT, creado TEXT NOT NULL, canal TEXT NOT NULL DEFAULT 'usuario', error TEXT)"
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_notif_pendientes ON notificaciones(enviado, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_notif_usuario ON notificaciones(usuario_id, id)');
  d.exec('CREATE TABLE IF NOT EXISTS avisos_stock(usuario_id INTEGER NOT NULL, bin TEXT NOT NULL, creado TEXT NOT NULL, PRIMARY KEY(usuario_id, bin))');
  listo = true;
  return d;
}

const ahora = () => new Date().toISOString();

export function crear(usuarioId, tipo, payload = null, canal = 'usuario') {
  migrar();
  const info = base().prepare(
    'INSERT INTO notificaciones(usuario_id, tipo, payload, creado, canal) VALUES(?,?,?,?,?)'
  ).run(usuarioId == null ? null : Number(usuarioId), String(tipo),
    payload == null ? null : (typeof payload === 'string' ? payload : JSON.stringify(payload)), ahora(), canal);
  return Number(info.lastInsertRowid);
}

/** Publica en el canal de auditoria (sin usuario). */
export function auditar(texto, payload = null) {
  return crear(null, 'auditoria', payload || { texto: String(texto) }, 'audit');
}

export function pendientes(n = 20) {
  migrar();
  return base().prepare(
    'SELECT n.*, u.usuario, u.telegram_id FROM notificaciones n ' +
    'LEFT JOIN usuarios u ON u.id = n.usuario_id ' +
    'WHERE n.enviado IS NULL AND n.error IS NULL ORDER BY n.id LIMIT ?'
  ).all(Math.max(1, Math.min(100, Number(n) || 20)));
}

export function marcar(id, error = null) {
  migrar();
  base().prepare('UPDATE notificaciones SET enviado=?, error=? WHERE id=?')
    .run(error ? null : ahora(), error || null, Number(id));
  return true;
}

/**
 * Encola "reserva por vencer" una sola vez por reserva activa.
 * Se llama desde el job del server.
 */
export function colaVencimientos(minutos = 5) {
  migrar();
  const d = base();
  const limite = new Date(Date.now() + Math.max(1, Number(minutos) || 5) * 60000).toISOString();
  const filas = d.prepare(
    "SELECT r.id, r.grupo, r.usuario_id, r.expira, c.codigo, c.bin, " +
    "substr(c.numero,1,8)||substr('xxxxxxxxxxx',1,max(0,length(c.numero)-12))||substr(c.numero,-4) numero_mask " +
    "FROM reservas r JOIN cc c ON c.id=r.cc_id " +
    "WHERE r.estado='activa' AND COALESCE(r.avisado_vence,0)=0 AND r.expira > ? AND r.expira < ? LIMIT 200"
  ).all(ahora(), limite);
  let n = 0;
  for (const f of filas) {
    d.exec('BEGIN IMMEDIATE');
    try {
      const up = d.prepare('UPDATE reservas SET avisado_vence=1 WHERE id=? AND COALESCE(avisado_vence,0)=0').run(f.id);
      if (!up.changes) { d.exec('ROLLBACK'); continue; }
      crear(f.usuario_id, 'reserva_por_vencer', {
        reserva_id: f.id, grupo: f.grupo, expira: f.expira,
        codigo: f.codigo || null, bin: f.bin, numero_mask: f.numero_mask,
      });
      d.exec('COMMIT');
      n++;
    } catch (_) {
      try { d.exec('ROLLBACK'); } catch (_) {}
    }
  }
  return n;
}

export function suscribirStock(usuarioId, bin) {
  migrar();
  const b = String(bin || '').replace(/\D/g, '').slice(0, 6);
  if (!usuarioId || b.length < 6) return false;
  base().prepare('INSERT OR IGNORE INTO avisos_stock(usuario_id, bin, creado) VALUES(?,?,?)')
    .run(Number(usuarioId), b, ahora());
  return true;
}

/** Avisa a los suscriptos cuando un BIN vuelve a tener stock. */
export function avisarStock(bin, cantidad = null) {
  migrar();
  const d = base();
  const b = String(bin || '').replace(/\D/g, '').slice(0, 6);
  if (b.length < 6) return 0;
  const filas = d.prepare('SELECT usuario_id FROM avisos_stock WHERE bin=?').all(b);
  for (const f of filas) crear(f.usuario_id, 'stock_bin', { bin: b, cantidad: cantidad == null ? null : Number(cantidad) });
  d.prepare('DELETE FROM avisos_stock WHERE bin=?').run(b);
  return filas.length;
}

export function deUsuario(usuarioId, limite = 50) {
  migrar();
  return base().prepare(
    'SELECT id, tipo, payload, enviado, creado, canal FROM notificaciones WHERE usuario_id=? ORDER BY id DESC LIMIT ?'
  ).all(Number(usuarioId), Math.max(1, Number(limite) || 50));
}
