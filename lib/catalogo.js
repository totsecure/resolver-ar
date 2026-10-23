/* catalogo.js — stock visible para vendedores y reservas con debito de saldo.
 *
 * Compatibilidad: `cc.estado` sigue en MAYUSCULAS (DISPONIBLE, RESERVADA,
 * VENDIDA, BAJA) porque el panel, el bot y los tests existentes dependen de
 * esos valores. La API web expone en minusculas (disponible, reservada, ...).
 *
 * Nunca devuelve el numero completo: la mascara se arma en SQL.
 */
import crypto from 'node:crypto';
import { base, asignarTitulares } from './stock.js';
import { audit } from './auth.js';
import { aplicarTx } from './wallet.js';
import * as pedidos from './pedidos.js';
import { porUsuario } from './vendedores.js';
import * as notificaciones from './notificaciones.js';
import * as precios from './precios.js';
import * as ledger from './ledger.js';
import { mostrarTramitePendiente } from './config.js';

export const ESTADOS = {
  disponible: 'DISPONIBLE', reservada: 'RESERVADA', pagada: 'PAGADA', vendida: 'VENDIDA',
  reclamada: 'RECLAMADA', anulada: 'ANULADA', revision: 'REVISION',
};

/* Maquina de estados explicita. Toda transicion valida y audita. */
export const TRANSICIONES = {
  DISPONIBLE: ['RESERVADA', 'VENDIDA', 'BAJA', 'ANULADA', 'REVISION'],
  RESERVADA: ['PAGADA', 'DISPONIBLE', 'ANULADA'],
  PAGADA: ['VENDIDA', 'RECLAMADA', 'ANULADA'],
  VENDIDA: ['RECLAMADA'],
  RECLAMADA: ['VENDIDA', 'ANULADA'],
  BAJA: ['DISPONIBLE'],
  ANULADA: ['DISPONIBLE'],
  REVISION: ['DISPONIBLE', 'ANULADA'],
};

/**
 * UPDATE ... WHERE id=? AND estado=<desde>, verificando filas afectadas.
 * Es la unica puerta para cambiar de estado en la fase 3.
 */
export function transicion(d, ccId, desde, hacia, { usuarioId = null, detalle = null, sets = {} } = {}) {
  const permitidas = TRANSICIONES[desde] || [];
  if (!permitidas.includes(hacia)) throw new Error('transicion_invalida:' + desde + '->' + hacia);
  const cols = Object.keys(sets);
  const sql = 'UPDATE cc SET estado=?' + (cols.length ? ',' + cols.map((c) => c + '=?').join(',') : '') +
    ' WHERE id=? AND estado=?';
  const r = d.prepare(sql).run(hacia, ...cols.map((c) => sets[c]), Number(ccId), desde);
  if (!r.changes) throw new Error('transicion_conflicto:' + desde + '->' + hacia);
  d.prepare('INSERT INTO movs(cc_id, accion, usuario, chat_id, fecha, detalle) VALUES(?,?,?,?,?,?)')
    .run(Number(ccId), 'ESTADO_' + hacia, usuarioId == null ? null : String(usuarioId), null, ahora(),
      desde + '->' + hacia + (detalle ? ' ' + detalle : ''));
  return true;
}

const ahora = () => new Date().toISOString();
const MASCARA = "substr(c.numero,1,8)||substr('xxxxxxxxxxx',1,max(0,length(c.numero)-12))||substr(c.numero,-4)";
const PRECIO = 'COALESCE(c.precio_num, pr.precio)';

let listo = false;
export function migrar() {
  if (listo) return base();
  const d = base();
  const cols = new Set(d.prepare('PRAGMA table_info(cc)').all().map((c) => c.name));
  const add = (n, def) => { if (!cols.has(n)) d.exec('ALTER TABLE cc ADD COLUMN ' + n + ' ' + def); };
  add('reservado_hasta', 'TEXT');
  add('verif_estado', "TEXT DEFAULT 'sin_verificar'");
  add('verif_intentos', 'INTEGER DEFAULT 0');
  add('asignada_en', 'TEXT');
  d.exec(
    'CREATE TABLE IF NOT EXISTS reservas(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, grupo TEXT, cc_id INTEGER NOT NULL, ' +
    'usuario_id INTEGER NOT NULL, precio INTEGER NOT NULL, creado TEXT NOT NULL, ' +
    "expira TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'activa', pagado_en TEXT)"
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_reservas_usuario ON reservas(usuario_id, estado)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_reservas_cc ON reservas(cc_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_reservas_vence ON reservas(estado, expira)');
  const rcols = new Set(d.prepare('PRAGMA table_info(reservas)').all().map((c) => c.name));
  if (!rcols.has('avisado_vence')) d.exec('ALTER TABLE reservas ADD COLUMN avisado_vence INTEGER DEFAULT 0');
  d.exec('CREATE INDEX IF NOT EXISTS idx_cc_estado_precio ON cc(estado, precio_num)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_cc_reserva ON cc(estado, reservado_hasta)');
  listo = true;
  return d;
}

/* ------------------------------- consulta -------------------------------- */
const lista = (v) => String(v == null ? '' : v).split(',').map((x) => x.trim()).filter(Boolean);

export function consultar(f = {}, usuarioId = null) {
  migrar();
  precios.migrar();
  const d = base();
  const uid = usuarioId ? Number(usuarioId) : null;
  const fallback = Math.max(0, Number((uid ? process.env.PRECIO_VENDEDOR : process.env.PRECIO_TIENDA) || 0) || 0);
  let precio = uid
    ? 'COALESCE(pv.precio, pt.precio, c.precio_num, pr.precio'
    : 'COALESCE(pt.precio, c.precio_num, pr.precio';
  if (fallback > 0) precio += ', ' + fallback;
  precio += ')';
  const w = ["c.estado = 'DISPONIBLE'", precio + ' IS NOT NULL', precio + ' > 0'];
  const p = [];
  const inLista = (campo, valores) => {
    const l = lista(valores);
    if (!l.length) return;
    w.push(campo + ' IN (' + l.map(() => '?').join(',') + ')');
    for (const x of l) p.push(x);
  };
  inLista('c.bin', f.bins);
  inLista('COALESCE(c.banco, b.banco)', f.bancos);
  inLista('c.marca', f.marcas);
  inLista('COALESCE(c.pais, b.pais)', f.paises);
  if (Number.isFinite(Number(f.pmin)) && f.pmin !== '') { w.push(precio + ' >= ?'); p.push(Number(f.pmin)); }
  if (Number.isFinite(Number(f.pmax)) && f.pmax !== '') { w.push(precio + ' <= ?'); p.push(Number(f.pmax)); }
  if (f.q) {
    w.push('(c.bin LIKE ? OR COALESCE(c.banco, b.banco) LIKE ? OR c.marca LIKE ?)');
    const q = '%' + String(f.q).trim() + '%';
    p.push(q, q, q);
  }
  const where = ' WHERE ' + w.join(' AND ');
  const fuente = ' FROM cc c LEFT JOIN bininfo b ON b.bin = c.bin LEFT JOIN precios pr ON pr.bin = c.bin ' +
    'LEFT JOIN precios_tramos pt ON pt.bin = c.bin AND pt.desde <= 1 AND (pt.hasta IS NULL OR pt.hasta >= 1) ' +
    (uid ? 'LEFT JOIN precios_vendedor pv ON pv.usuario_id = ? AND pv.bin = c.bin ' : '') + where;
  const params = uid ? [uid, ...p] : p;

  const ordenes = {
    precio_asc: precio + ' ASC, c.id', precio_desc: precio + ' DESC, c.id',
    nuevo: 'c.id DESC', viejo: 'c.id ASC', bin: 'c.bin, c.ref',
  };
  const orden = ordenes[f.orden] || 'c.bin, c.ref';
  const por = Math.max(5, Math.min(60, Number(f.por) || 20));
  const pagina = Math.max(1, Number(f.pagina) || 1);

  const filas = d.prepare(
    'SELECT c.id, c.ref, c.bin, c.marca, c.mes, c.anio, ' + MASCARA + ' numero_mask, ' +
    'c.saldo, c.saldo_ref, COALESCE(c.saldo_disp_num, c.saldo) saldo_legacy, ' +
    'COALESCE(c.saldo_total_num, c.saldo_ref) saldo_ref_legacy, ' +
    'COALESCE(c.banco, b.banco) banco, COALESCE(c.pais, b.pais) pais, ' +
    'COALESCE(c.tipo, b.tipo) tipo, COALESCE(c.nivel, b.nivel) nivel, ' +
    precio + ' precio' + fuente + ' ORDER BY ' + orden + ' LIMIT ? OFFSET ?'
  ).all(...params, por, (pagina - 1) * por);

  const total = d.prepare('SELECT COUNT(*) n' + fuente).get(...params).n;
  const fac = (expr, limite = 40) => d.prepare(
    'SELECT ' + expr + ' v, COUNT(*) n' + fuente + ' AND ' + expr + ' IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT ' + limite
  ).all(...params);
  const facetas = {
    bins: d.prepare(
      'SELECT c.bin v, COUNT(*) n, MAX(COALESCE(c.banco, b.banco)) banco' + fuente + ' GROUP BY 1 ORDER BY 2 DESC LIMIT 100'
    ).all(...params),
    bancos: fac('COALESCE(c.banco, b.banco)'),
    marcas: fac('c.marca'),
    paises: fac('COALESCE(c.pais, b.pais)'),
    precios: d.prepare('SELECT MIN(' + precio + ') min, MAX(' + precio + ') max' + fuente).get(...params),
  };

  const cuentaMascaras = new Map();
  for (const r of filas) cuentaMascaras.set(r.numero_mask, (cuentaMascaras.get(r.numero_mask) || 0) + 1);

  return {
    total, pagina, por,
    items: filas.map((r) => ({
      id: r.id, ref: r.ref, bin: r.bin, marca: r.marca, banco: r.banco, pais: r.pais,
      tipo: r.tipo, nivel: r.nivel, exp: (r.mes || '') + '/' + (r.anio || ''),
      numero_mask: r.numero_mask + (cuentaMascaras.get(r.numero_mask) > 1 ? ' (' + (r.ref != null ? r.ref : '-') + ')' : ''),
      precio: Number(r.precio),
      saldo: r.saldo != null ? Number(r.saldo) : (r.saldo_legacy != null ? Number(r.saldo_legacy) : null),
      saldo_ref: r.saldo_ref != null ? Number(r.saldo_ref) : (r.saldo_ref_legacy != null ? Number(r.saldo_ref_legacy) : null),
    })),
    facetas,
  };
}

/** Resumen para /stock del bot: disponibles por BIN con precio. */
export function resumen(usuarioId = null) {
  migrar();
  precios.migrar();
  const uid = usuarioId ? Number(usuarioId) : null;
  const fallback = Math.max(0, Number((uid ? process.env.PRECIO_VENDEDOR : process.env.PRECIO_TIENDA) || 0) || 0);
  let precio = uid
    ? 'COALESCE(pv.precio, pt.precio, c.precio_num, pr.precio'
    : 'COALESCE(pt.precio, c.precio_num, pr.precio';
  if (fallback > 0) precio += ', ' + fallback;
  precio += ')';
  return base().prepare(
    'SELECT c.bin, COUNT(*) n, MIN(' + precio + ') precio_min, MAX(' + precio + ') precio_max, ' +
    'MAX(COALESCE(c.banco, b.banco)) banco FROM cc c ' +
    'LEFT JOIN bininfo b ON b.bin = c.bin LEFT JOIN precios pr ON pr.bin = c.bin ' +
    'LEFT JOIN precios_tramos pt ON pt.bin = c.bin AND pt.desde <= 1 AND (pt.hasta IS NULL OR pt.hasta >= 1) ' +
    (uid ? 'LEFT JOIN precios_vendedor pv ON pv.usuario_id = ' + uid + ' AND pv.bin = c.bin ' : '') +
    " WHERE c.estado = 'DISPONIBLE' AND " + precio + ' > 0 GROUP BY c.bin ORDER BY n DESC'
  ).all();
}

/* -------------------------------- reservas -------------------------------- */
function grupoNuevo() {
  const f = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return 'R-' + f + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function perfilActivo(usuarioId) {
  const v = porUsuario(usuarioId);
  if (!v) return { ok: false, error: 'no_es_vendedor' };
  if (v.estado !== 'activo' || v.usuario_estado !== 'activo') return { ok: false, error: 'vendedor_inactivo' };
  return { ok: true, vendedor: v };
}

/**
 * Reserva transaccional. Modos:
 *   { refs: [id, ...] }          -> exactamente esas tarjetas
 *   { bin: '516585', cantidad }  -> N del BIN
 * Debita el saldo y devuelve numeros enmascarados. Nada parcial.
 */
export function reservar(usuarioId, opts = {}) {
  migrar();
  const d = base();
  const v = perfilActivo(usuarioId);
  if (!v.ok) return v;
  const vendedor = v.vendedor;
  const modo = String(process.env.DESCUENTO_MODO || 'saldo').toLowerCase() === 'cuenta' ? 'cuenta' : 'saldo';
  const ventaSinSaldo = String(process.env.VENTA_SIN_SALDO || '0') === '1';

  /* Vencidas primero, para no bloquear stock ni contar reservas muertas. */
  expirar();

  const refs = Array.isArray(opts.refs) ? [...new Set(opts.refs.map((x) => Number(x)).filter(Number.isFinite))] : [];
  const cantidad = Math.max(1, Number(opts.cantidad) || refs.length || 1);
  if (!refs.length && !opts.bin) return { ok: false, error: 'falta_seleccion' };

  const inicioHoy = new Date().toISOString().slice(0, 10);
  const activas = d.prepare("SELECT COUNT(*) n FROM reservas WHERE usuario_id = ? AND estado = 'activa'").get(Number(usuarioId)).n;
  const hoy = d.prepare('SELECT COUNT(*) n FROM reservas WHERE usuario_id = ? AND creado >= ?').get(Number(usuarioId), inicioHoy).n;
  const limiteDiario = Number(vendedor.limite_reservas_dia || 0);
  const limiteSimul = Number(vendedor.limite_simultaneas || 0);
  const queridas = refs.length || cantidad;
  if (limiteSimul > 0 && activas + queridas > limiteSimul) {
    return { ok: false, error: 'limite_simultaneas', detalle: 'Tenés ' + activas + ' reservadas y el límite es ' + limiteSimul + '.' };
  }
  if (limiteDiario > 0 && hoy + queridas > limiteDiario) {
    return { ok: false, error: 'limite_diario', detalle: 'Límite diario: ' + limiteDiario + ' tarjetas.' };
  }

  precios.migrar();
  const seleccion = "SELECT c.id, c.ref, c.bin, COALESCE(c.precio_num, pr.precio) precio_base, " +
    "c.numero, c.mes, c.anio, 'DISPONIBLE' estado " +
    'FROM cc c LEFT JOIN precios pr ON pr.bin = c.bin ';

  d.exec('BEGIN IMMEDIATE');
  try {
    let filas;
    if (refs.length) {
      filas = d.prepare(seleccion + 'WHERE c.id IN (' + refs.map(() => '?').join(',') + ") AND c.estado = 'DISPONIBLE'")
        .all(...refs);
      if (filas.length !== refs.length) throw new Error('sin_stock');
    } else {
      filas = d.prepare(seleccion + "WHERE c.bin = ? AND c.estado = 'DISPONIBLE' ORDER BY c.id LIMIT ?")
        .all(String(opts.bin), cantidad);
      if (filas.length < cantidad) throw new Error('sin_stock');
    }
    /* Precio por vendedor / tramo por cantidad / base de la tarjeta. */
    const porBin = new Map();
    for (const f of filas) porBin.set(f.bin, (porBin.get(f.bin) || 0) + 1);
    const unidades = new Map();
    let total = 0;
    for (const f of filas) {
      const u = precios.unitario(d, usuarioId, f.bin, porBin.get(f.bin), f.precio_base);
      if (u == null || u <= 0) throw new Error('sin_precio');
      unidades.set(f.id, u);
      total += u;
    }
    const saldo = d.prepare('SELECT saldo FROM saldos WHERE usuario_id = ?').get(Number(usuarioId));
    const disponible = saldo ? Number(saldo.saldo) : 0;
    const aCuenta = modo === 'cuenta' || disponible < total;
    if (modo === 'saldo' && disponible < total && !ventaSinSaldo) throw new Error('saldo_insuficiente');

    const grupo = grupoNuevo();
    const creado = ahora();
    const ventanaMin = Math.max(1, Number(process.env.VENTANA_MIN || 15));
    const expira = new Date(Date.now() + ventanaMin * 60000).toISOString();
    aplicarTx(d, usuarioId, -total, aCuenta ? 'reserva_cuenta' : 'reserva', grupo, 'reserva ' + filas.length + ' cc', { permitirNegativo: aCuenta });

    const ins = d.prepare(
      'INSERT INTO reservas(grupo, cc_id, usuario_id, precio, creado, expira, estado) VALUES(?,?,?,?,?,?,?)'
    );
    for (const f of filas) {
      transicion(d, f.id, 'DISPONIBLE', 'RESERVADA', {
        usuarioId,
        detalle: 'grupo=' + grupo,
        sets: {
          reservado_por: String(usuarioId), reservado_hasta: expira,
          asignada_en: creado,
        },
      });
      ins.run(grupo, f.id, Number(usuarioId), unidades.get(f.id), creado, expira, 'activa');
    }
    const pedido = pedidos.crear(d, { grupo, usuarioId, cantidad: filas.length, total, expira, ccs: filas });
    d.exec('COMMIT');
    audit(usuarioId, 'RESERVA', 'reserva', grupo, 'cc=' + filas.length + ' total=' + total + ' saldo=' + (disponible - total) + ' modo=' + (aCuenta ? 'cuenta' : 'saldo'), null);
    /* Asignacion: se completa el titular y se revela el numero completo. */
    try { asignarTitulares(filas.map((f) => ({ id: f.id }))); } catch (_) {}
    notificaciones.crear(usuarioId, 'reserva_asignada', {
      grupo, cantidad: filas.length, total, expira,
    });
    return {
      ok: true, grupo, total, cantidad: filas.length, pedido,
      saldo: disponible - total, expira, modo: aCuenta ? 'cuenta' : 'saldo', ventana_min: ventanaMin,
      items: filas.map((f) => {
        const it = detalle(d, f.id);
        return it ? { ...it, precio: unidades.get(f.id) } : null;
      }).filter(Boolean),
    };
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    const msg = String(e?.message || e);
    if (['sin_stock', 'sin_precio', 'saldo_insuficiente'].includes(msg)) {
      const saldo = d.prepare('SELECT saldo FROM saldos WHERE usuario_id = ?').get(Number(usuarioId));
      return { ok: false, error: msg, saldo: saldo ? Number(saldo.saldo) : 0 };
    }
    throw e;
  }
}

/* ------------------------- revelado de la asignacion ---------------------- */
function filaCompleta(d, ccId) {
  return d.prepare(
    'SELECT c.id, c.ref, c.bin, c.marca, c.mes, c.anio, c.cvv, c.numero, c.titular, c.dni, ' +
    'c.nro_tramite, c.fecha_nac, c.mail, c.telefono, c.direccion, c.ciudad, c.provincia, ' +
    'c.banco, c.estado, c.precio_num, c.asignada_en, c.reservado_hasta, c.verif_estado, c.codigo ' +
    'FROM cc c WHERE c.id = ?'
  ).get(Number(ccId)) || null;
}

export function detalle(d, ccId) {
  const f = filaCompleta(d, ccId);
  if (!f) return null;
  return {
    id: f.id, ref: f.ref, bin: f.bin, marca: f.marca, banco: f.banco,
    mes: f.mes, anio: f.anio, exp: (f.mes || '') + '/' + (f.anio || ''), cvv: f.cvv,
    numero: f.numero, titular: f.titular || null, dni: f.dni || null,
    nro_tramite: (String(f.nro_tramite || '') === '(pendiente)' && !mostrarTramitePendiente())
      ? null : (f.nro_tramite || null),
    fecha_nac: f.fecha_nac || null,
    mail: f.mail || null, telefono: f.telefono || null, direccion: f.direccion || null,
    ciudad: f.ciudad || null, provincia: f.provincia || null,
    precio: f.precio_num == null ? null : Number(f.precio_num),
    estado: String(f.estado || '').toLowerCase(), verif_estado: f.verif_estado || 'sin_verificar',
    codigo: f.codigo || null,
    asignada_en: f.asignada_en || null, expira: f.reservado_hasta || null,
  };
}

/**
 * Datos completos de una reserva propia (numero + titular). Es el unico punto
 * que revela el PAN, y solo para el vendedor asignado.
 */
export function datosReserva(usuarioId, reservaId) {
  migrar();
  expirar();
  const d = base();
  const r = d.prepare('SELECT * FROM reservas WHERE id = ? AND usuario_id = ?')
    .get(Number(reservaId), Number(usuarioId));
  if (!r) return { ok: false, error: 'reserva_inexistente' };
  if (!['activa', 'pagada', 'ok', 'falla'].includes(r.estado)) {
    return { ok: false, error: 'reserva_cerrada', estado: r.estado };
  }
  const item = detalle(d, r.cc_id);
  if (!item) return { ok: false, error: 'cc_inexistente' };
  item.precio = Number(r.precio);
  audit(usuarioId, 'REVELAR_RESERVA', 'reserva', r.id, 'cc=' + r.cc_id, null);
  return { ok: true, reserva: { id: r.id, grupo: r.grupo, estado: r.estado, expira: r.expira, pagado_en: r.pagado_en }, item };
}

/**
 * Pago: confirma la reserva. El saldo ya se debito al reservar, asi que pagar
 * no vuelve a cobrar. Pasa RESERVADA -> PAGADA y arranca el auto-OK.
 */
export function pagar(usuarioId, { id = null, grupo = null } = {}) {
  migrar();
  expirar();
  const d = base();
  const filas = id
    ? d.prepare("SELECT * FROM reservas WHERE id=? AND usuario_id=? AND estado='activa'").all(Number(id), Number(usuarioId))
    : d.prepare("SELECT * FROM reservas WHERE grupo=? AND usuario_id=? AND estado='activa'").all(String(grupo), Number(usuarioId));
  if (!filas.length) return { ok: false, error: 'reserva_no_activa' };
  const pagado = ahora();
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const r of filas) {
      const up = d.prepare("UPDATE reservas SET estado='pagada', pagado_en=? WHERE id=? AND estado='activa'")
        .run(pagado, r.id);
      if (!up.changes) throw new Error('transicion_conflicto');
      transicion(d, r.cc_id, 'RESERVADA', 'PAGADA', { usuarioId, detalle: 'grupo=' + r.grupo });
    }
    pedidos.estadoDeGrupo(d, filas[0].grupo, 'pagado', 'pago confirmado', { actorId: usuarioId, rol: 'vendedor' });
    ledger.reconocerVenta(d, filas[0].grupo, filas.reduce((s, r) => s + Number(r.precio), 0));
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    const msg = String(e?.message || e);
    /* Si otra reserva ganó la misma tarjeta, esta reserva no debe retener
     * saldo: se cierra como perdida y se devuelve exactamente lo debitado. */
    if (filas.length === 1 && /transicion_conflicto|ya_cambiada/.test(msg)) {
      const r = filas[0];
      const dd = base();
      dd.exec('BEGIN IMMEDIATE');
      try {
        const actual = dd.prepare('SELECT estado FROM reservas WHERE id=?').get(r.id);
        if (actual && actual.estado === 'activa') {
          dd.prepare("UPDATE reservas SET estado='perdida' WHERE id=? AND estado='activa'").run(r.id);
          aplicarTx(dd, r.usuario_id, Number(r.precio), 'doble_venta', r.grupo, 'devolución por doble venta');
          pedidos.estadoDeGrupo(dd, r.grupo, 'cancelado', 'doble venta: otra reserva ganó', { rol: 'sistema' });
          dd.exec('COMMIT');
          audit(r.usuario_id, 'RESERVA_PERDIDA', 'reserva', r.id, 'doble venta; saldo devuelto', null);
          return { ok: false, error: 'sin_stock', grupo: r.grupo, devuelto: Number(r.precio) };
        }
        dd.exec('ROLLBACK');
      } catch (_) {
        try { dd.exec('ROLLBACK'); } catch (_) {}
      }
    }
    return { ok: false, error: msg };
  }
  const g = filas[0].grupo;
  const total = filas.reduce((s, r) => s + Number(r.precio), 0);
  audit(usuarioId, 'PAGO', 'reserva', g, 'cc=' + filas.length + ' pagado=' + pagado, null);
  notificaciones.crear(usuarioId, 'pago_confirmado', { grupo: g, cantidad: filas.length, total, expira: filas[0].expira });
  notificaciones.auditar('VENTA ' + g + ' · vendedor #' + usuarioId + ' · ' + filas.length + ' CC · $ ' + total);
  const expira = filas.reduce((min, r) => (String(r.expira) < String(min) ? r.expira : min), filas[0].expira);
  return {
    ok: true, estado: 'pagada', grupo: g, pagado_en: pagado, expira,
    cantidad: filas.length, total,
    items: filas.map((r) => {
      const it = detalle(d, r.cc_id);
      return it ? { ...it, precio: Number(r.precio) } : null;
    }).filter(Boolean),
  };
}

/** Devuelve a disponible las impagas vencidas y cierra como vendidas las pagadas. */
export function expirar() {
  migrar();
  const d = base();
  let liberadas = 0;
  let cerradas = 0;

  const impagas = d.prepare(
    "SELECT * FROM reservas WHERE estado='activa' AND expira < ? ORDER BY id LIMIT 500"
  ).all(ahora());
  for (const r of impagas) {
    d.exec('BEGIN IMMEDIATE');
    try {
      const up = d.prepare("UPDATE reservas SET estado='vencida' WHERE id=? AND estado='activa'").run(r.id);
      if (!up.changes) { d.exec('ROLLBACK'); continue; }
      const ccActual = d.prepare('SELECT estado FROM cc WHERE id=?').get(r.cc_id);
      /* Si VENDEDOR_GANA_CARRERA=0 y el bot vendió la tarjeta, la reserva
       * igual vence y se devuelve el saldo; solo se omite el cambio de stock. */
      if (ccActual && ccActual.estado === 'RESERVADA') {
        transicion(d, r.cc_id, 'RESERVADA', 'DISPONIBLE', {
          detalle: 'reserva vencida ' + r.grupo,
          sets: { reservado_por: null, reservado_hasta: null, asignada_en: null },
        });
      }
      aplicarTx(d, r.usuario_id, Number(r.precio), 'reserva_vencida', r.grupo, 'devolución reserva vencida');
      pedidos.estadoDeGrupo(d, r.grupo, 'vencido', 'reserva vencida', { rol: 'sistema' });
      d.exec('COMMIT');
      liberadas++;
      audit(null, 'RESERVA_VENCIDA', 'reserva', r.id, 'cc=' + r.cc_id + ' usuario=' + r.usuario_id, null);
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch (_) {}
    }
  }

  const pagadas = d.prepare(
    "SELECT * FROM reservas WHERE estado='pagada' AND expira < ? ORDER BY id LIMIT 500"
  ).all(ahora());
  for (const r of pagadas) {
    d.exec('BEGIN IMMEDIATE');
    try {
      const up = d.prepare("UPDATE reservas SET estado='ok' WHERE id=? AND estado='pagada'").run(r.id);
      if (!up.changes) { d.exec('ROLLBACK'); continue; }
      transicion(d, r.cc_id, 'PAGADA', 'VENDIDA', {
        usuarioId: r.usuario_id,
        detalle: 'auto-OK grupo=' + r.grupo,
        sets: {
          vendido_a: String(r.usuario_id), vendido_el: ahora(), codigo_venta: r.grupo,
          verif_estado: 'ok',
        },
      });
      pedidos.estadoDeGrupo(d, r.grupo, 'entregado', 'auto-OK', { rol: 'sistema' });
      d.exec('COMMIT');
      cerradas++;
      audit(null, 'RESERVA_AUTO_OK', 'reserva', r.id, 'cc=' + r.cc_id + ' usuario=' + r.usuario_id, null);
      notificaciones.crear(r.usuario_id, 'venta_ok', { grupo: r.grupo, cc_id: r.cc_id, auto: true });
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch (_) {}
    }
  }

  return { liberadas, cerradas };
}

export function cancelar(usuarioId, reservaId) {
  migrar();
  const d = base();
  const r = d.prepare('SELECT * FROM reservas WHERE id = ?').get(Number(reservaId));
  if (!r) return { ok: false, error: 'reserva_inexistente' };
  if (Number(r.usuario_id) !== Number(usuarioId)) return { ok: false, error: 'no_es_tuya' };
  if (r.estado !== 'activa') return { ok: false, error: 'no_activa', estado: r.estado };
  d.exec('BEGIN IMMEDIATE');
  try {
    const up = d.prepare("UPDATE reservas SET estado='cancelada' WHERE id=? AND estado='activa'").run(r.id);
    if (!up.changes) throw new Error('no_activa');
    pedidos.estadoDeGrupo(d, r.grupo, 'cancelado', 'cancelación del vendedor', { actorId: usuarioId, rol: 'vendedor' });
    transicion(d, r.cc_id, 'RESERVADA', 'DISPONIBLE', {
      usuarioId,
      detalle: 'cancelacion reserva ' + r.grupo,
      sets: { reservado_por: null, reservado_hasta: null, asignada_en: null },
    });
    aplicarTx(d, r.usuario_id, Number(r.precio), 'reserva_cancelada', r.grupo, 'cancelación del vendedor');
    d.exec('COMMIT');
    audit(usuarioId, 'RESERVA_CANCELAR', 'reserva', r.id, 'cc=' + r.cc_id, null);
    return { ok: true, devuelto: Number(r.precio) };
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

export function misReservas(usuarioId, limite = 100) {
  migrar();
  expirar();
  return base().prepare(
    'SELECT r.id, r.grupo, r.precio, r.creado, r.expira, r.estado, r.pagado_en, ' +
    'c.id cc_id, c.ref, c.bin, c.marca, c.mes, c.anio, c.codigo, ' + MASCARA + ' numero_mask, ' +
    "COALESCE(c.banco, b.banco) banco, c.estado AS cc_estado " +
    'FROM reservas r JOIN cc c ON c.id = r.cc_id LEFT JOIN bininfo b ON b.bin = c.bin ' +
    'WHERE r.usuario_id = ? ORDER BY r.id DESC LIMIT ?'
  ).all(Number(usuarioId), Math.max(1, Math.min(1000, Number(limite) || 100)));
}

/** Reserva activa mas proxima a vencer (para countdown y avisos). */
export function proximaVence(usuarioId) {
  migrar();
  return base().prepare(
    "SELECT MIN(expira) expira FROM reservas WHERE usuario_id=? AND estado IN ('activa','pagada')"
  ).get(Number(usuarioId)).expira || null;
}
