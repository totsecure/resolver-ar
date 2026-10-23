/* pedidos.js — entidad pedido sobre las reservas.
 *
 * Un pedido agrupa N tarjetas reservadas a un vendedor. Las tarjetas y sus
 * precios siguen viviendo en `reservas`; aca quedan el estado explicito, los
 * enlaces de un solo uso y el comprobante.
 */
import crypto from 'node:crypto';
import { base } from './stock.js';
import { mascarar } from './mascara.js';

const ahora = () => new Date().toISOString();
const ESTADOS = ['reservado', 'pagado', 'entregado', 'verificado', 'vencido', 'cancelado', 'reclamo'];

/* Máquina de estados explícita. */
export const TRANSICIONES = {
  reservado: ['pagado', 'vencido', 'cancelado'],
  pagado: ['entregado', 'verificado', 'reclamo', 'cancelado'],
  entregado: ['verificado', 'reclamo'],
  verificado: ['reclamo', 'cancelado'],
  reclamo: ['verificado', 'cancelado'],
  vencido: [],
  cancelado: [],
};

const PERMITIDAS_VENDEDOR = new Set([
  'reservado>pagado', 'reservado>cancelado',
  'pagado>reclamo', 'entregado>reclamo', 'verificado>reclamo',
]);

export function transicionValida(desde, hacia, rol = 'sistema') {
  if (!ESTADOS.includes(desde) || !ESTADOS.includes(hacia)) return false;
  if (!(TRANSICIONES[desde] || []).includes(hacia)) return false;
  if (rol === 'vendedor') return PERMITIDAS_VENDEDOR.has(desde + '>' + hacia);
  return true;
}
let listo = false;

export function migrar() {
  if (listo) return base();
  const d = base();
  d.exec(
    'CREATE TABLE IF NOT EXISTS pedidos(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT UNIQUE NOT NULL, grupo TEXT NOT NULL, ' +
    'usuario_id INTEGER NOT NULL, estado TEXT NOT NULL DEFAULT \'reservado\', ' +
    'cantidad INTEGER NOT NULL DEFAULT 1, total INTEGER NOT NULL DEFAULT 0, ' +
    'creado TEXT NOT NULL, vence TEXT, pagado_en TEXT, entregado_en TEXT, ' +
    'verificado_en TEXT, link_usado TEXT)'
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_pedidos_usuario ON pedidos(usuario_id, id)');
  d.exec(
    'CREATE TABLE IF NOT EXISTS pedido_tarjetas(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, cc_id INTEGER NOT NULL, ' +
    'token TEXT UNIQUE NOT NULL, usado TEXT)'
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_pedido_tarjetas_pedido ON pedido_tarjetas(pedido_id)');
  d.exec(
    'CREATE TABLE IF NOT EXISTS pedido_eventos(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, estado TEXT NOT NULL, ' +
    'detalle TEXT, creado TEXT NOT NULL)'
  );
  const ecols = new Set(d.prepare('PRAGMA table_info(pedido_eventos)').all().map((c) => c.name));
  for (const [n, def] of [['desde', 'TEXT'], ['hacia', 'TEXT'], ['actor_id', 'INTEGER'], ['actor_rol', 'TEXT'], ['motivo', 'TEXT'], ['ip', 'TEXT']]) {
    if (!ecols.has(n)) d.exec('ALTER TABLE pedido_eventos ADD COLUMN ' + n + ' ' + def);
  }
  listo = true;
  return d;
}

function codigo(prefixo = 'P') {
  return prefixo + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function token() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

export function evento(d, pedidoId, estado, detalle = null) {
  d.prepare('INSERT INTO pedido_eventos(pedido_id, estado, detalle, creado) VALUES(?,?,?,?)')
    .run(Number(pedidoId), String(estado), detalle == null ? null : String(detalle), ahora());
}

/** Se llama dentro de la transaccion de catalogo.reservar. */
export function crear(d, { grupo, usuarioId, cantidad, total, expira, ccs = [] }) {
  migrar();
  const cod = codigo('P');
  const info = d.prepare(
    'INSERT INTO pedidos(codigo, grupo, usuario_id, estado, cantidad, total, creado, vence) ' +
    "VALUES(?,?,?,'reservado',?,?,?,?)"
  ).run(cod, String(grupo), Number(usuarioId), Number(cantidad), Number(total), ahora(), expira || null);
  const id = Number(info.lastInsertRowid);
  const ins = d.prepare('INSERT INTO pedido_tarjetas(pedido_id, cc_id, token) VALUES(?,?,?)');
  for (const c of ccs) ins.run(id, Number(c.id || c), token());
  evento(d, id, 'reservado', 'grupo=' + grupo + ' cc=' + ccs.length + ' total=' + total);
  return { id, codigo: cod, grupo: String(grupo), cantidad: Number(cantidad), total: Number(total), vence: expira || null };
}

export function porGrupo(d, grupo) {
  migrar();
  return d.prepare('SELECT * FROM pedidos WHERE grupo=? ORDER BY id DESC LIMIT 1').get(String(grupo)) || null;
}

/** Actualiza el pedido asociado a un grupo; no falla si no existe. */
export function estadoDeGrupo(d, grupo, estado, detalle = null, opts = {}) {
  migrar();
  const p = porGrupo(d, grupo);
  if (!p) return null;
  const hacia = String(estado);
  const rol = String(opts.rol || 'sistema');
  const actorId = opts.actorId == null ? null : Number(opts.actorId);
  if (!ESTADOS.includes(hacia)) throw new Error('estado_invalido:' + hacia);
  if (p.estado === hacia) return p;
  if (rol === 'vendedor' && actorId !== Number(p.usuario_id)) throw new Error('pedido_ajeno');
  if (!transicionValida(p.estado, hacia, rol)) throw new Error('transicion_invalida:' + p.estado + '->' + hacia);
  const sets = ['estado=?'];
  const vals = [hacia];
  if (hacia === 'pagado') { sets.push('pagado_en=?'); vals.push(ahora()); }
  if (hacia === 'entregado') { sets.push('entregado_en=?'); vals.push(ahora()); }
  if (hacia === 'verificado') { sets.push('verificado_en=?'); vals.push(ahora()); }
  const up = d.prepare('UPDATE pedidos SET ' + sets.join(',') + ' WHERE id=? AND estado=?').run(...vals, p.id, p.estado);
  if (!up.changes) throw new Error('transicion_conflicto:' + p.estado + '->' + hacia);
  d.prepare(
    'INSERT INTO pedido_eventos(pedido_id, estado, detalle, creado, desde, hacia, actor_id, actor_rol, motivo, ip) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(p.id, hacia, detalle == null ? null : String(detalle), ahora(), p.estado, hacia,
    actorId, rol, detalle == null ? null : String(detalle), opts.ip == null ? null : String(opts.ip));
  return p;
}

export function listar({ usuarioId = null, estado = null, desde = null, hasta = null, limite = 100 } = {}) {
  migrar();
  const w = [];
  const p = [];
  if (usuarioId) { w.push('p.usuario_id=?'); p.push(Number(usuarioId)); }
  if (estado) { w.push('p.estado=?'); p.push(String(estado)); }
  if (desde) { w.push('p.creado >= ?'); p.push(String(desde)); }
  if (hasta) { w.push('p.creado <= ?'); p.push(String(hasta)); }
  p.push(Math.max(1, Math.min(500, Number(limite) || 100)));
  const filas = base().prepare(
    'SELECT p.*, u.usuario, u.nombre FROM pedidos p LEFT JOIN usuarios u ON u.id=p.usuario_id ' +
    (w.length ? 'WHERE ' + w.join(' AND ') + ' ' : '') +
    'ORDER BY p.id DESC LIMIT ?'
  ).all(...p);
  return filas.map((f) => ({ ...f, items: tarjetas(f.id).map((t) => ({ ...t, numero_mask: mascarar(t.numero) })) }));
}

export function tarjetas(pedidoId) {
  migrar();
  return base().prepare(
    'SELECT pt.id, pt.cc_id, pt.token, pt.usado, c.numero, c.bin, c.marca, c.mes, c.anio, c.cvv, c.titular, c.dni ' +
    'FROM pedido_tarjetas pt JOIN cc c ON c.id=pt.cc_id WHERE pt.pedido_id=? ORDER BY pt.id'
  ).all(Number(pedidoId));
}

export function obtener(clave, { usuarioId = null } = {}) {
  migrar();
  const s = String(clave || '');
  const d = base();
  const p = d.prepare('SELECT p.*, u.usuario, u.nombre FROM pedidos p LEFT JOIN usuarios u ON u.id=p.usuario_id WHERE p.codigo=? OR CAST(p.id AS TEXT)=? OR p.grupo=? ORDER BY p.id DESC LIMIT 1')
    .get(s, s, s);
  if (!p || (usuarioId && Number(p.usuario_id) !== Number(usuarioId))) return null;
  return { ...p, items: tarjetas(p.id).map((t) => ({ ...t, numero_mask: mascarar(t.numero) })) };
}

/** Consume el enlace /p/<codigo> una sola vez. */
export function consumirPedido(codigo) {
  migrar();
  const d = base();
  const p = d.prepare('SELECT * FROM pedidos WHERE codigo=?').get(String(codigo));
  if (!p) return { ok: false, error: 'no_existe' };
  if (p.link_usado) return { ok: false, error: 'link_usado' };
  const up = d.prepare('UPDATE pedidos SET link_usado=? WHERE id=? AND link_usado IS NULL').run(ahora(), p.id);
  if (!up.changes) return { ok: false, error: 'link_usado' };
  return { ok: true, pedido: obtener(codigo) };
}

/** Consume el enlace /c/<token> una sola vez. */
export function consumirTarjeta(token) {
  migrar();
  const d = base();
  const t = d.prepare(
    'SELECT pt.*, p.codigo pedido_codigo, p.grupo, p.usuario_id, p.estado pedido_estado, c.* ' +
    'FROM pedido_tarjetas pt JOIN pedidos p ON p.id=pt.pedido_id JOIN cc c ON c.id=pt.cc_id WHERE pt.token=?'
  ).get(String(token));
  if (!t) return { ok: false, error: 'no_existe' };
  if (t.usado) return { ok: false, error: 'link_usado' };
  const up = d.prepare('UPDATE pedido_tarjetas SET usado=? WHERE id=? AND usado IS NULL').run(ahora(), t.id);
  if (!up.changes) return { ok: false, error: 'link_usado' };
  return { ok: true, tarjeta: { ...t, numero_mask: mascarar(t.numero) } };
}

export function comprobanteHtml(clave, { usuarioId = null } = {}) {
  const p = obtener(clave, { usuarioId });
  if (!p) return null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const filas = p.items.map((t) => '<tr><td>' + esc(t.numero_mask || mascarar(t.numero)) + '</td><td>' + esc(t.bin || '') +
    '</td><td>' + esc(t.titular || '-') + '</td><td>' + esc(t.dni || '-') + '</td></tr>').join('');
  return '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Pedido ' + esc(p.codigo) + '</title>' +
    '<style>body{font:14px -apple-system,Segoe UI,sans-serif;max-width:760px;margin:32px auto;color:#111}' +
    'table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left}' +
    'h1{font-size:20px}.muted{color:#666}</style></head><body>' +
    '<h1>Pedido ' + esc(p.codigo) + '</h1>' +
    '<p class="muted">Grupo ' + esc(p.grupo) + ' · ' + esc(p.estado) + ' · ' + esc(p.creado) + '</p>' +
    '<p>Vendedor: ' + esc(p.usuario || p.nombre || ('#' + p.usuario_id)) + ' · Total: $' + esc(p.total) + ' · ' + esc(p.cantidad) + ' CC</p>' +
    '<table><thead><tr><th>Tarjeta</th><th>BIN</th><th>Titular</th><th>DNI</th></tr></thead><tbody>' + filas + '</tbody></table>' +
    '<p class="muted">Comprobante generado por Resolver Store.</p></body></html>';
}
