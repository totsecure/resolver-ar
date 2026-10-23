/* precios.js — precio base por BIN, tramos por cantidad y precio por vendedor.
 *
 * Prioridad al cobrar:
 *   1. precio especifico del vendedor para ese BIN
 *   2. tramo por cantidad (desde <= cantidad <= hasta)
 *   3. precio base de la tarjeta (cc.precio_num)
 *   4. precio base del BIN (tabla precios)
 */
import { base } from './stock.js';
import { audit } from './auth.js';

let listo = false;
export function migrar() {
  if (listo) return base();
  const d = base();
  d.exec(
    'CREATE TABLE IF NOT EXISTS precios_tramos(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, bin TEXT NOT NULL, desde INTEGER NOT NULL, ' +
    'hasta INTEGER, precio INTEGER NOT NULL, actualizado TEXT, UNIQUE(bin, desde))'
  );
  d.exec(
    'CREATE TABLE IF NOT EXISTS precios_vendedor(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL, bin TEXT NOT NULL, ' +
    'precio INTEGER NOT NULL, actualizado TEXT, UNIQUE(usuario_id, bin))'
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_tramos_bin ON precios_tramos(bin, desde)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_precio_vend ON precios_vendedor(usuario_id, bin)');
  listo = true;
  return d;
}

const ahora = () => new Date().toISOString();
const entero = (v) => (Number.isInteger(Number(v)) ? Number(v) : null);

export function setTramo(bin, desde, hasta, precio, adminId = null) {
  migrar();
  const b = String(bin || '').replace(/\D/g, '').slice(0, 8);
  const de = entero(desde);
  const ha = hasta == null || hasta === '' ? null : entero(hasta);
  const pr = entero(precio);
  if (!b || de == null || de < 1 || !pr || pr <= 0) throw new Error('tramo invalido');
  if (ha != null && ha < de) throw new Error('hasta debe ser >= desde');
  base().prepare(
    'INSERT INTO precios_tramos(bin, desde, hasta, precio, actualizado) VALUES(?,?,?,?,?) ' +
    'ON CONFLICT(bin, desde) DO UPDATE SET hasta=excluded.hasta, precio=excluded.precio, actualizado=excluded.actualizado'
  ).run(b, de, ha, pr, ahora());
  audit(adminId, 'PRECIO_TRAMO', 'bin', b, de + '-' + (ha == null ? '∞' : ha) + ' = ' + pr, null);
  return { ok: true, bin: b, desde: de, hasta: ha, precio: pr };
}

export function borrarTramo(id, adminId = null) {
  migrar();
  base().prepare('DELETE FROM precios_tramos WHERE id=?').run(Number(id));
  audit(adminId, 'PRECIO_TRAMO_BORRAR', 'tramo', id, null, null);
  return { ok: true };
}

export function tramos(bin = null) {
  migrar();
  return bin
    ? base().prepare('SELECT * FROM precios_tramos WHERE bin=? ORDER BY desde').all(String(bin))
    : base().prepare('SELECT * FROM precios_tramos ORDER BY bin, desde').all();
}

export function setPrecioVendedor(usuarioId, bin, precio, adminId = null) {
  migrar();
  const b = String(bin || '').replace(/\D/g, '').slice(0, 8);
  const pr = entero(precio);
  if (!b || pr == null) throw new Error('precio invalido');
  if (pr === 0) {
    base().prepare('DELETE FROM precios_vendedor WHERE usuario_id=? AND bin=?').run(Number(usuarioId), b);
    audit(adminId, 'PRECIO_VENDEDOR_BORRAR', 'usuario', usuarioId, 'bin=' + b, null);
    return { ok: true, borrado: true };
  }
  if (pr < 0) throw new Error('precio invalido');
  base().prepare(
    'INSERT INTO precios_vendedor(usuario_id, bin, precio, actualizado) VALUES(?,?,?,?) ' +
    'ON CONFLICT(usuario_id, bin) DO UPDATE SET precio=excluded.precio, actualizado=excluded.actualizado'
  ).run(Number(usuarioId), b, pr, ahora());
  audit(adminId, 'PRECIO_VENDEDOR', 'usuario', usuarioId, 'bin=' + b + ' = ' + pr, null);
  return { ok: true, usuario_id: Number(usuarioId), bin: b, precio: pr };
}

export function preciosVendedor(usuarioId = null) {
  migrar();
  return usuarioId
    ? base().prepare('SELECT * FROM precios_vendedor WHERE usuario_id=? ORDER BY bin').all(Number(usuarioId))
    : base().prepare('SELECT pv.*, u.usuario FROM precios_vendedor pv JOIN usuarios u ON u.id=pv.usuario_id ORDER BY pv.usuario_id, pv.bin').all();
}

/** Precio unitario final. `d` permite usarlo dentro de una transaccion. */
export function unitario(d, usuarioId, bin, cantidad, baseCc = null) {
  migrar();
  const db = d || base();
  const b = String(bin || '').replace(/\D/g, '').slice(0, 8);
  const cant = Math.max(1, Number(cantidad) || 1);
  if (usuarioId) {
    const v = db.prepare('SELECT precio FROM precios_vendedor WHERE usuario_id=? AND bin=?').get(Number(usuarioId), b);
    if (v && Number(v.precio) > 0) return Number(v.precio);
  }
  const t = db.prepare(
    'SELECT precio FROM precios_tramos WHERE bin=? AND desde<=? AND (hasta IS NULL OR hasta>=?) ORDER BY desde DESC LIMIT 1'
  ).get(b, cant, cant);
  if (t && Number(t.precio) > 0) return Number(t.precio);
  if (baseCc != null && Number(baseCc) > 0) return Number(baseCc);
  const p = db.prepare('SELECT precio FROM precios WHERE bin=?').get(b);
  if (p && Number(p.precio) > 0) return Number(p.precio);
  /* Fallback global configurable (B4). 0 = deshabilitado. */
  const global = Number((usuarioId ? process.env.PRECIO_VENDEDOR : process.env.PRECIO_TIENDA) || 0);
  return Number.isFinite(global) && global > 0 ? global : null;
}

/** Precio de vidriera para una tarjeta (cantidad 1). */
export function deVidriera(d, usuarioId, bin, baseCc) {
  return unitario(d, usuarioId, bin, 1, baseCc);
}
