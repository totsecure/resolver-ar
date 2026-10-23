/* ledger.js — contabilidad de doble entrada para el wallet de vendedores.
 *
 * Convención: monto firmado, entero. Cada asiento suma exactamente 0.
 * Saldo de una cuenta = SUM(ledger_lineas.monto). El wallet del vendedor es un
 * pasivo: saldo a favor = positivo.
 *
 * Los movimientos viejos de mov_saldo se backfillean una vez y se linkean por
 * asiento_id. Si la suma del ledger no coincide con saldos.saldo, se crea un
 * asiento de apertura por la diferencia.
 */
import { base } from './stock.js';

const CUENTAS_BASE = [
  ['recargas:banco', 'activo'],
  ['reservas:pendientes', 'puente'],
  ['ingresos:ventas', 'ingreso'],
  ['comisiones:plataforma', 'ingreso'],
  ['ajustes:admin', 'ajuste'],
  ['patrimonio:apertura', 'patrimonio'],
  ['historico:sin_clasificar', 'puente'],
];

const cache = new Map();
let listo = false;
const ahora = () => new Date().toISOString();

function contrapartida(tipo) {
  switch (String(tipo)) {
    case 'recarga': return 'recargas:banco';
    case 'reserva':
    case 'reserva_cuenta':
    case 'reserva_vencida':
    case 'reserva_cancelada':
    case 'devolucion_reclamo':
    case 'doble_venta': return 'reservas:pendientes';
    case 'comision': return 'comisiones:plataforma';
    case 'ajuste':
    case 'ajuste_admin':
    case 'debito': return 'ajustes:admin';
    default: return 'historico:sin_clasificar';
  }
}

function tipoDe(codigo) {
  if (codigo.startsWith('wallet:')) return 'pasivo';
  const base = CUENTAS_BASE.find((c) => c[0] === codigo);
  return base ? base[1] : 'puente';
}

export function cuenta(d, codigo, tipo = null, usuarioId = null) {
  const clave = String(codigo);
  if (cache.has(clave)) return cache.get(clave);
  d.prepare(
    'INSERT INTO ledger_cuentas(codigo, tipo, usuario_id, nombre, creado) VALUES(?,?,?,?,?) ' +
    'ON CONFLICT(codigo) DO NOTHING'
  ).run(clave, tipo || tipoDe(clave), usuarioId == null ? null : Number(usuarioId), clave, ahora());
  const f = d.prepare('SELECT id FROM ledger_cuentas WHERE codigo=?').get(clave);
  if (!f) throw new Error('cuenta_ledger_no_creada:' + clave);
  cache.set(clave, Number(f.id));
  return Number(f.id);
}

export function asiento(d, { tipo, refTipo = null, refId = null, descripcion = null, creadoPor = null, idemKey = null, lineas }) {
  if (idemKey) {
    const ya = d.prepare('SELECT id FROM ledger_asientos WHERE idem_key=?').get(String(idemKey));
    if (ya) return Number(ya.id);
  }
  const suma = lineas.reduce((s, l) => s + Number(l[1]), 0);
  if (suma !== 0) throw new Error('asiento_desbalanceado:' + suma);
  const info = d.prepare(
    'INSERT INTO ledger_asientos(fecha, tipo, ref_tipo, ref_id, descripcion, creado_por, idem_key, creado) ' +
    'VALUES(?,?,?,?,?,?,?,?)'
  ).run(ahora(), String(tipo), refTipo == null ? null : String(refTipo), refId == null ? null : String(refId),
    descripcion == null ? null : String(descripcion), creadoPor == null ? null : Number(creadoPor),
    idemKey == null ? null : String(idemKey), ahora());
  const id = Number(info.lastInsertRowid);
  const ins = d.prepare('INSERT INTO ledger_lineas(asiento_id, cuenta_id, monto, moneda) VALUES(?,?,?,?)');
  for (const [codigo, monto] of lineas) {
    ins.run(id, cuenta(d, codigo), Number(monto), 'ARS');
  }
  return id;
}

export function movimientoWallet(d, { usuarioId, monto, tipo, ref = null, nota = null }) {
  const uid = Number(usuarioId);
  const m = Number(monto);
  const wallet = 'wallet:' + uid;
  return asiento(d, {
    tipo, refTipo: ref == null ? null : 'ref', refId: ref, descripcion: nota,
    lineas: [[wallet, m], [contrapartida(tipo), -m]],
  });
}

/** Al confirmarse una venta, mueve el puente de reservas a ingresos. */
export function reconocerVenta(d, grupo, total) {
  const m = Number(total);
  if (!m) return null;
  return asiento(d, {
    tipo: 'venta', refTipo: 'pedido', refId: grupo, descripcion: 'venta ' + grupo,
    idemKey: 'venta:' + grupo,
    lineas: [['reservas:pendientes', -m], ['ingresos:ventas', m]],
  });
}

export function saldoLedger(usuarioId) {
  const f = base().prepare(
    'SELECT COALESCE(SUM(l.monto),0) s FROM ledger_lineas l ' +
    'JOIN ledger_cuentas c ON c.id=l.cuenta_id WHERE c.codigo=?'
  ).get('wallet:' + Number(usuarioId));
  return Number(f ? f.s : 0);
}

export function movimientosSinAsiento() {
  return base().prepare('SELECT COUNT(*) n FROM mov_saldo WHERE asiento_id IS NULL').get().n;
}

export function migrar() {
  if (listo) return base();
  const d = base();
  d.exec(
    'CREATE TABLE IF NOT EXISTS ledger_cuentas(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, tipo TEXT NOT NULL, ' +
    'usuario_id INTEGER, nombre TEXT, creado TEXT NOT NULL)'
  );
  d.exec(
    'CREATE TABLE IF NOT EXISTS ledger_asientos(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL, tipo TEXT NOT NULL, ' +
    'ref_tipo TEXT, ref_id TEXT, descripcion TEXT, creado_por INTEGER, idem_key TEXT UNIQUE, creado TEXT NOT NULL)'
  );
  d.exec(
    'CREATE TABLE IF NOT EXISTS ledger_lineas(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, asiento_id INTEGER NOT NULL, cuenta_id INTEGER NOT NULL, ' +
    'monto INTEGER NOT NULL, moneda TEXT NOT NULL DEFAULT \'ARS\')'
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_ledger_lineas_asiento ON ledger_lineas(asiento_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_ledger_lineas_cuenta ON ledger_lineas(cuenta_id)');
  const cols = new Set(d.prepare('PRAGMA table_info(mov_saldo)').all().map((c) => c.name));
  if (!cols.has('asiento_id')) d.exec('ALTER TABLE mov_saldo ADD COLUMN asiento_id INTEGER');
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_mov_saldo_asiento ON mov_saldo(asiento_id) WHERE asiento_id IS NOT NULL');

  for (const [codigo, tipo] of CUENTAS_BASE) cuenta(d, codigo, tipo);

  // Backfill de movimientos históricos sin asiento.
  const viejos = d.prepare('SELECT id, usuario_id, tipo, monto, ref, nota FROM mov_saldo WHERE asiento_id IS NULL ORDER BY id').all();
  for (const mv of viejos) {
    const uid = Number(mv.usuario_id);
    const m = Number(mv.monto);
    const a = asiento(d, {
      tipo: 'backfill', refTipo: 'mov_saldo', refId: mv.id, descripcion: mv.tipo,
      idemKey: 'backfill:mov:' + mv.id,
      lineas: [['wallet:' + uid, m], [contrapartida(mv.tipo), -m]],
    });
    d.prepare('UPDATE mov_saldo SET asiento_id=? WHERE id=? AND asiento_id IS NULL').run(a, mv.id);
  }

  // Apertura por diferencia entre el ledger y el saldo materializado.
  const saldos = d.prepare('SELECT usuario_id, saldo FROM saldos').all();
  for (const s of saldos) {
    const uid = Number(s.usuario_id);
    const objetivo = Number(s.saldo);
    const suma = saldoLedger(uid);
    const dif = objetivo - suma;
    if (dif === 0) continue;
    asiento(d, {
      tipo: 'apertura', refTipo: 'usuario', refId: uid, descripcion: 'apertura de saldo',
      idemKey: 'apertura:' + uid,
      lineas: [['wallet:' + uid, dif], ['patrimonio:apertura', -dif]],
    });
  }
  listo = true;
  return d;
}
