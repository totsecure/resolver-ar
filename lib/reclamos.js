/* reclamos.js — disputa del vendedor sobre una tarjeta asignada.
 * En fase 4 solo registra el reclamo; la resolucion (reemplazo/devolucion)
 * se opera desde la fase 5 con el mismo modulo.
 */
import crypto from 'node:crypto';
import { base, asignarTitulares } from './stock.js';
import { audit } from './auth.js';
import * as wallet from './wallet.js';
import * as catalogo from './catalogo.js';
import * as notificaciones from './notificaciones.js';

let listo = false;
export function migrar() {
  if (listo) return base();
  const d = base();
  d.exec(
    'CREATE TABLE IF NOT EXISTS reclamos(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, reserva_id INTEGER, cc_id INTEGER, usuario_id INTEGER, ' +
    "motivo TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'pendiente', resolucion TEXT, " +
    'resuelto_por INTEGER, creado TEXT NOT NULL, resuelto_en TEXT)'
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_reclamos_estado ON reclamos(estado, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_reclamos_usuario ON reclamos(usuario_id, id)');
  listo = true;
  return d;
}

const ahora = () => new Date().toISOString();

export function crear({ usuarioId, reservaId, ccId, motivo }) {
  migrar();
  if (!String(motivo || '').trim()) throw new Error('motivo obligatorio');
  const info = base().prepare(
    "INSERT INTO reclamos(reserva_id, cc_id, usuario_id, motivo, estado, creado) VALUES(?,?,?,?,'pendiente',?)"
  ).run(reservaId == null ? null : Number(reservaId), Number(ccId), Number(usuarioId), String(motivo).trim(), ahora());
  audit(usuarioId, 'RECLAMO_CREAR', 'reclamo', info.lastInsertRowid, 'cc=' + ccId + ' motivo=' + motivo, null);
  return { ok: true, id: Number(info.lastInsertRowid), estado: 'pendiente' };
}

export function listar({ estado = null, limite = 200 } = {}) {
  migrar();
  const sql =
    'SELECT r.*, u.usuario, c.ref, c.bin, c.codigo, c.estado AS cc_estado, ' +
    'rs.grupo, rs.precio, rs.estado AS reserva_estado, ' +
    "substr(c.numero,1,8)||substr('xxxxxxxxxxx',1,max(0,length(c.numero)-12))||substr(c.numero,-4) numero_mask " +
    'FROM reclamos r LEFT JOIN usuarios u ON u.id=r.usuario_id LEFT JOIN cc c ON c.id=r.cc_id ' +
    'LEFT JOIN reservas rs ON rs.id=r.reserva_id ' +
    (estado ? 'WHERE r.estado=? ' : '') + 'ORDER BY r.id DESC LIMIT ?';
  const p = estado ? [String(estado), Math.max(1, Number(limite) || 200)] : [Math.max(1, Number(limite) || 200)];
  return base().prepare(sql).all(...p);
}

/**
 * Resolucion operativa desde el panel:
 *   accion='reemplazo'  -> asigna otra tarjeta del mismo BIN, sin cobrar
 *   accion='devolucion' -> devuelve el precio de la reserva al saldo
 *   accion='rechazar'   -> la tarjeta era valida, vuelve a VENDIDA/ok
 */
export function resolverAccion({ reclamoId, adminId, accion, nota = null }) {
  migrar();
  const d = base();
  const r = d.prepare('SELECT * FROM reclamos WHERE id=?').get(Number(reclamoId));
  if (!r) return { ok: false, error: 'reclamo_inexistente' };
  if (r.estado !== 'pendiente') return { ok: false, error: 'ya_resuelto', estado: r.estado };
  const cc = d.prepare('SELECT * FROM cc WHERE id=?').get(Number(r.cc_id));
  if (!cc) return { ok: false, error: 'cc_inexistente' };
  if (cc.estado !== 'RECLAMADA') return { ok: false, error: 'cc_no_reclamada', estado: cc.estado };
  const res = r.reserva_id ? d.prepare('SELECT * FROM reservas WHERE id=?').get(Number(r.reserva_id)) : null;
  const vendor = Number(r.usuario_id || (res && res.usuario_id) || cc.reservado_por || 0);
  const notaTxt = String(nota || '').trim();
  if (!['reemplazo', 'devolucion', 'rechazar'].includes(accion)) return { ok: false, error: 'accion_invalida' };

  let remplazo = null;
  let grupo = null;
  let devuelto = 0;
  const fecha = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  d.exec('BEGIN IMMEDIATE');
  try {
    if (accion === 'reemplazo') {
      const rep = d.prepare(
        "SELECT id, codigo, bin, numero FROM cc WHERE bin=? AND estado='DISPONIBLE' AND id<>? " +
        'ORDER BY COALESCE(precio_num, 0), id LIMIT 1'
      ).get(cc.bin, cc.id);
      if (!rep) throw new Error('sin_stock');
      grupo = 'REP-' + fecha + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const ahoraIso = ahora();
      catalogo.transicion(d, cc.id, 'RECLAMADA', 'ANULADA', {
        usuarioId: adminId, detalle: 'reclamo #' + r.id + ' reemplazo',
        sets: { verif_estado: 'falla' },
      });
      catalogo.transicion(d, rep.id, 'DISPONIBLE', 'VENDIDA', {
        usuarioId: adminId, detalle: 'reemplazo reclamo #' + r.id,
        sets: {
          vendido_a: String(vendor), vendido_el: ahoraIso, codigo_venta: grupo,
          verif_estado: 'sin_verificar', asignada_en: ahoraIso,
          reservado_por: String(vendor), reservado_hasta: null,
        },
      });
      d.prepare(
        "INSERT INTO reservas(grupo, cc_id, usuario_id, precio, creado, expira, estado, pagado_en) " +
        "VALUES(?,?,?,0,?,?, 'ok', ?)"
      ).run(grupo, rep.id, vendor, ahoraIso, ahoraIso, ahoraIso);
      d.prepare("UPDATE reclamos SET estado='resuelta', resolucion=?, resuelto_por=?, resuelto_en=? WHERE id=?")
        .run('reemplazo ' + (rep.codigo || ('#' + rep.id)) + (notaTxt ? ' · ' + notaTxt : ''), Number(adminId), ahora(), r.id);
      remplazo = { id: rep.id, codigo: rep.codigo || null, bin: rep.bin, grupo };
    } else if (accion === 'devolucion') {
      const precio = res ? Number(res.precio) : 0;
      catalogo.transicion(d, cc.id, 'RECLAMADA', 'ANULADA', {
        usuarioId: adminId, detalle: 'reclamo #' + r.id + ' devolucion',
        sets: { verif_estado: 'falla' },
      });
      if (precio > 0) {
        wallet.aplicarTx(d, vendor, precio, 'devolucion_reclamo', res.grupo, notaTxt || 'reclamo #' + r.id);
        devuelto = precio;
      }
      if (res) d.prepare("UPDATE reservas SET estado='devuelta' WHERE id=?").run(res.id);
      d.prepare("UPDATE reclamos SET estado='resuelta', resolucion=?, resuelto_por=?, resuelto_en=? WHERE id=?")
        .run('devolucion $' + devuelto + (notaTxt ? ' · ' + notaTxt : ''), Number(adminId), ahora(), r.id);
    } else {
      catalogo.transicion(d, cc.id, 'RECLAMADA', 'VENDIDA', {
        usuarioId: adminId, detalle: 'reclamo #' + r.id + ' rechazado',
        sets: { verif_estado: 'ok' },
      });
      if (res) d.prepare("UPDATE reservas SET estado='ok' WHERE id=?").run(res.id);
      d.prepare("UPDATE reclamos SET estado='rechazada', resolucion=?, resuelto_por=?, resuelto_en=? WHERE id=?")
        .run('rechazado' + (notaTxt ? ' · ' + notaTxt : ''), Number(adminId), ahora(), r.id);
    }
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    const msg = String(e?.message || e);
    return { ok: false, error: msg === 'sin_stock' ? 'sin_stock' : msg };
  }

  if (remplazo) {
    try { asignarTitulares([{ id: remplazo.id }]); } catch (_) {}
  }
  const resolucionTxt = accion === 'reemplazo'
    ? 'reemplazo ' + (remplazo.codigo || '#' + remplazo.id)
    : accion === 'devolucion' ? 'devolucion $' + devuelto : 'rechazado';
  audit(adminId, 'RECLAMO_RESOLVER', 'reclamo', r.id, resolucionTxt + (notaTxt ? ' · ' + notaTxt : ''), null);
  notificaciones.crear(vendor, 'reclamo_resuelto', {
    reclamo_id: r.id, resolucion: resolucionTxt, codigo: remplazo ? remplazo.codigo : null, monto: devuelto,
  });
  notificaciones.auditar('RECLAMO RESUELTO · #' + r.id + ' · ' + resolucionTxt + ' · vendedor #' + vendor);
  return { ok: true, accion, grupo, reemplazo: remplazo, devuelto, resolucion: resolucionTxt };
}

export function resolver(id, adminId, resolucion, estado = 'resuelta') {
  migrar();
  if (!String(resolucion || '').trim()) throw new Error('resolucion obligatoria');
  const r = base().prepare('SELECT * FROM reclamos WHERE id=?').get(Number(id));
  if (!r) return { ok: false, error: 'reclamo_inexistente' };
  if (r.estado !== 'pendiente') return { ok: false, error: 'ya_resuelto', estado: r.estado };
  const up = base().prepare("UPDATE reclamos SET estado=?, resolucion=?, resuelto_por=?, resuelto_en=? WHERE id=? AND estado='pendiente'")
    .run(String(estado), String(resolucion), Number(adminId), ahora(), Number(id));
  if (!up.changes) return { ok: false, error: 'ya_resuelto' };
  audit(adminId, 'RECLAMO_RESOLVER', 'reclamo', id, estado + ' · ' + resolucion, null);
  return { ok: true, estado: String(estado) };
}
