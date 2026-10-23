/* checker.js — verificacion de tarjetas con hook enchufable.
 *
 * Ahora:
 *   - proveedor 'manual' (default): deja la tarjeta pendiente de revision;
 *     el admin marca OK/falla con motivo desde el panel.
 *   - cualquier integracion externa se registra con registrarProveedor() y se
 *     elige con CHECKER_PROVEEDOR=<nombre>. No hay que tocar el resto.
 *
 * La cola y el historial viven en stock.db. Nunca se guarda el numero completo
 * en resultados ni en logs.
 */
import { base } from './stock.js';
import { audit } from './auth.js';
import * as notificaciones from './notificaciones.js';

let listo = false;
export function migrar() {
  if (listo) return base();
  const d = base();
  const cols = new Set(d.prepare('PRAGMA table_info(cc)').all().map((c) => c.name));
  if (!cols.has('verif_estado')) d.exec("ALTER TABLE cc ADD COLUMN verif_estado TEXT DEFAULT 'sin_verificar'");
  if (!cols.has('verif_intentos')) d.exec('ALTER TABLE cc ADD COLUMN verif_intentos INTEGER DEFAULT 0');
  d.exec(
    'CREATE TABLE IF NOT EXISTS checker_resultados(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, cc_id INTEGER NOT NULL, proveedor TEXT NOT NULL, ' +
    "estado TEXT NOT NULL, motivo TEXT, creado TEXT NOT NULL)"
  );
  d.exec(
    'CREATE TABLE IF NOT EXISTS checker_cola(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, cc_id INTEGER NOT NULL, lote_id INTEGER, ' +
    "estado TEXT NOT NULL DEFAULT 'pendiente', intentos INTEGER NOT NULL DEFAULT 0, " +
    'creado TEXT NOT NULL, procesado TEXT, motivo TEXT)'
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_checker_res_cc ON checker_resultados(cc_id, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_checker_cola_estado ON checker_cola(estado, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_checker_cola_cc ON checker_cola(cc_id, estado)');
  listo = true;
  return d;
}

const ahora = () => new Date().toISOString();
const ESTADOS = ['ok', 'falla', 'pendiente', 'error'];

/* ------------------------------ proveedores ------------------------------- */
const proveedores = new Map();

export function registrarProveedor(nombre, fn) {
  if (typeof fn !== 'function') throw new Error('proveedor invalido');
  proveedores.set(String(nombre), fn);
  return true;
}

export function proveedoresDisponibles() {
  return [...proveedores.keys()];
}

/* Proveedor manual: no decide, deja para el admin. */
registrarProveedor('manual', async () => ({
  estado: 'pendiente', motivo: 'verificación manual pendiente', proveedor: 'manual',
}));

/* Proveedor de prueba: no sale a la red. Sirve para probar el hook. */
registrarProveedor('prueba', async (cc) => {
  const d = String(cc && cc.numero || '').replace(/\D/g, '');
  const par = Number(d.slice(-1)) % 2 === 0;
  return { estado: par ? 'ok' : 'falla', motivo: par ? 'aprobada por proveedor de prueba' : 'rechazada por proveedor de prueba', proveedor: 'prueba' };
});

function normalizar(r, nombre) {
  const estado = ESTADOS.includes(r && r.estado) ? r.estado : 'error';
  return {
    estado,
    motivo: r && r.motivo ? String(r.motivo).slice(0, 500) : null,
    proveedor: (r && r.proveedor) || nombre,
  };
}

/**
 * Hook unico. Acepta cc (fila u objeto) o {id}. Devuelve
 * {estado, motivo, proveedor} y deja registro en checker_resultados.
 */
export async function verificar(cc, opts = {}) {
  migrar();
  const d = base();
  const fila = typeof cc === 'number' || (cc && cc.id && !cc.numero)
    ? d.prepare('SELECT * FROM cc WHERE id = ?').get(Number(cc.id || cc))
    : cc;
  if (!fila || !fila.id) return { estado: 'error', motivo: 'cc inexistente', proveedor: 'manual' };

  const nombre = String(opts.proveedor || process.env.CHECKER_PROVEEDOR || 'manual');
  const fn = proveedores.get(nombre);
  let r;
  try {
    r = fn ? await fn(fila) : { estado: 'error', motivo: 'proveedor desconocido: ' + nombre, proveedor: nombre };
  } catch (e) {
    r = { estado: 'error', motivo: 'error del proveedor: ' + String(e?.message || e).slice(0, 300), proveedor: nombre };
  }
  const res = normalizar(r, nombre);

  const info = d.prepare('INSERT INTO checker_resultados(cc_id, proveedor, estado, motivo, creado) VALUES(?,?,?,?,?)')
    .run(Number(fila.id), res.proveedor, res.estado, res.motivo, ahora());
  d.prepare('UPDATE cc SET verif_intentos = COALESCE(verif_intentos,0) + 1 WHERE id=?').run(Number(fila.id));
  if (res.estado === 'ok' || res.estado === 'falla') {
    d.prepare('UPDATE cc SET verif_estado=? WHERE id=?').run(res.estado, Number(fila.id));
  }
  audit(null, 'CHECKER_' + res.estado.toUpperCase(), 'cc', fila.id, res.proveedor + (res.motivo ? ' · ' + res.motivo : ''), null);
  return { ...res, resultado_id: Number(info.lastInsertRowid) };
}

/* ---------------------------------- cola ---------------------------------- */
export function encolar(ccIds, loteId = null) {
  migrar();
  const d = base();
  const ids = [...new Set((ccIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x)))];
  let n = 0;
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ids) {
      const ya = d.prepare("SELECT 1 FROM checker_cola WHERE cc_id=? AND estado='pendiente'").get(id);
      if (ya) continue;
      d.prepare("INSERT INTO checker_cola(cc_id, lote_id, estado, creado) VALUES(?,?,'pendiente',?)").run(id, loteId == null ? null : Number(loteId), ahora());
      n++;
    }
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
  return n;
}

/** Encola todas las tarjetas sin verificar de un lote (idempotente). */
export function encolarLote(loteId) {
  migrar();
  const d = base();
  const filas = d.prepare("SELECT id FROM cc WHERE lote_id=? AND verif_estado='sin_verificar' ORDER BY id").all(Number(loteId));
  const n = encolar(filas.map((f) => f.id), Number(loteId));
  audit(null, 'CHECKER_LOTE', 'lote', loteId, 'encoladas=' + n, null);
  return { ok: true, lote_id: Number(loteId), encoladas: n, total: filas.length };
}

export function pendientes(n = 100) {
  migrar();
  return base().prepare(
    'SELECT q.*, c.bin, c.codigo, c.verif_estado, ' +
    "substr(c.numero,1,8)||substr('xxxxxxxxxxx',1,max(0,length(c.numero)-12))||substr(c.numero,-4) numero_mask " +
    'FROM checker_cola q JOIN cc c ON c.id=q.cc_id WHERE q.estado=\'pendiente\' ORDER BY q.id LIMIT ?'
  ).all(Math.max(1, Number(n) || 100));
}

export function resumen() {
  migrar();
  const d = base();
  return {
    cola_pendiente: d.prepare("SELECT COUNT(*) n FROM checker_cola WHERE estado='pendiente'").get().n,
    sin_verificar: d.prepare("SELECT COUNT(*) n FROM cc WHERE verif_estado='sin_verificar'").get().n,
    resultados: d.prepare('SELECT COUNT(*) n FROM checker_resultados').get().n,
    proveedor: String(process.env.CHECKER_PROVEEDOR || 'manual'),
    proveedores: proveedoresDisponibles(),
  };
}

/**
 * Procesa la cola. Si el proveedor es manual (resultado pendiente), deja la
 * fila en cola para que el admin decida. Con un proveedor externo, cierra.
 */
export async function procesar(n = 10) {
  migrar();
  const d = base();
  /* Con el proveedor manual no hay nada automatico que hacer: el admin marca. */
  if (String(process.env.CHECKER_PROVEEDOR || 'manual') === 'manual') {
    return { procesados: 0, manual: true, pendientes: resumen().cola_pendiente };
  }
  const filas = pendientes(n);
  let procesados = 0;
  let manual = 0;
  for (const f of filas) {
    const r = await verificar(Number(f.cc_id));
    d.prepare('UPDATE checker_cola SET intentos=COALESCE(intentos,0)+1 WHERE id=?').run(f.id);
    if (r.estado === 'pendiente') {
      manual++;
      d.prepare("UPDATE checker_cola SET motivo=? WHERE id=?").run('esperando revisión manual', f.id);
      continue;
    }
    d.prepare("UPDATE checker_cola SET estado='procesado', procesado=?, motivo=? WHERE id=?")
      .run(ahora(), (r.estado + (r.motivo ? ' · ' + r.motivo : '')).slice(0, 400), f.id);
    procesados++;
  }
  return { procesados, manual, pendientes: pendientes(1).length ? resumen().cola_pendiente : 0 };
}

/** Marca manual del admin: OK o falla con motivo. Cierra la cola de esa cc. */
export function marcarManual(ccId, estado, motivo, adminId = null) {
  migrar();
  if (!['ok', 'falla'].includes(String(estado))) throw new Error('estado invalido');
  const d = base();
  const cc = d.prepare('SELECT * FROM cc WHERE id=?').get(Number(ccId));
  if (!cc) throw new Error('cc inexistente');
  const detalle = String(motivo || '').trim() || (estado === 'ok' ? 'ok manual' : 'falla manual');
  const info = d.prepare('INSERT INTO checker_resultados(cc_id, proveedor, estado, motivo, creado) VALUES(?,?,?,?,?)')
    .run(cc.id, 'manual_admin', estado, detalle, ahora());
  d.prepare("UPDATE cc SET verif_estado=?, verif_intentos=COALESCE(verif_intentos,0)+1 WHERE id=?")
    .run(estado, cc.id);
  d.prepare("UPDATE checker_cola SET estado='procesado', procesado=?, motivo=? WHERE cc_id=? AND estado='pendiente'")
    .run(ahora(), estado + ' · ' + detalle, cc.id);
  d.prepare('INSERT INTO movs(cc_id, accion, usuario, fecha, detalle) VALUES(?,?,?,?,?)')
    .run(cc.id, 'CHECKER_MANUAL', adminId == null ? null : String(adminId), ahora(), estado + ' · ' + detalle);
  audit(adminId, 'CHECKER_MANUAL', 'cc', cc.id, estado + ' · ' + detalle, null);
  notificaciones.auditar('CHECKER ' + estado.toUpperCase() + ' · cc #' + cc.id + ' · ' + detalle);
  return { ok: true, cc_id: cc.id, estado, resultado_id: Number(info.lastInsertRowid) };
}

/* -------------------------------- consultas ------------------------------- */
export function resultados({ ccId = null, loteId = null, limite = 200 } = {}) {
  migrar();
  const w = [];
  const p = [];
  if (ccId) { w.push('r.cc_id = ?'); p.push(Number(ccId)); }
  if (loteId) { w.push('c.lote_id = ?'); p.push(Number(loteId)); }
  const sql =
    'SELECT r.*, c.bin, c.codigo, c.ref, c.lote_id, ' +
    "substr(c.numero,1,8)||substr('xxxxxxxxxxx',1,max(0,length(c.numero)-12))||substr(c.numero,-4) numero_mask " +
    'FROM checker_resultados r JOIN cc c ON c.id=r.cc_id ' +
    (w.length ? 'WHERE ' + w.join(' AND ') + ' ' : '') + 'ORDER BY r.id DESC LIMIT ?';
  p.push(Math.max(1, Math.min(1000, Number(limite) || 200)));
  return base().prepare(sql).all(...p);
}

/** Tarjetas candidatas a revisión manual (para el panel). */
export function tarjetasSinVerificar(limite = 100) {
  migrar();
  return base().prepare(
    'SELECT id, bin, ref, codigo, etiqueta, estado, verif_estado, verif_intentos, lote_id, ' +
    "substr(numero,1,8)||substr('xxxxxxxxxxx',1,max(0,length(numero)-12))||substr(numero,-4) numero_mask " +
    'FROM cc WHERE verif_estado=\'sin_verificar\' ORDER BY id DESC LIMIT ?'
  ).all(Math.max(1, Math.min(1000, Number(limite) || 100)));
}
