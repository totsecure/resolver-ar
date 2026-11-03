/* panel.js — datos, facetas y compras para el panel web privado.
 * El panel no toca la base por su cuenta: pasa por aca.
 * Acciones en lote: aceptan ids (exacto) o refs/ref (compatibilidad).
 */
import { base, preciosTabla, entrega, resumen, stats, alertas, precios, setPrecio } from './stock.js';
import { buscar, baja, devolver, reservar, setEtiqueta, setSaldo, publicar, saldoANumero } from './stock.js';
import { mascarar } from './mascara.js';
import { lookup as binLookup } from './bininfo.js';

const ESTADOS_VALIDOS = ['DISPONIBLE', 'RESERVADA', 'PAGADA', 'VENDIDA', 'BAJA', 'RECLAMADA', 'ANULADA', 'REVISION'];

function col(t, n, d) {
  const cols = base().prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
  if (!cols.includes(n)) base().exec('ALTER TABLE ' + t + ' ADD COLUMN ' + n + ' ' + d);
}

export function migrar() {
  col('cc', 'banco', 'TEXT');
  col('cc', 'pais', 'TEXT');
  col('cc', 'pais2', 'TEXT');
  col('cc', 'tipo', 'TEXT');
  col('cc', 'nivel', 'TEXT');
  col('cc', 'zip', 'TEXT');
  col('cc', 'refund', 'INTEGER DEFAULT 1');
  col('cc', 'eliminado', 'INTEGER DEFAULT 0');
  col('cc', 'precio_num', 'INTEGER');
  col('cc', 'precio_cuotas', 'INTEGER');
  base().exec('CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, tipo TEXT, nombre TEXT, contenido TEXT, creado TEXT, enviado TEXT, error TEXT)');
  preciosTabla();
  base().exec('CREATE INDEX IF NOT EXISTS idx_cc_estado_bin ON cc(estado, bin)');
}

const lista = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const FUENTE = ' FROM cc c LEFT JOIN bininfo b ON b.bin = c.bin LEFT JOIN precios pr ON pr.bin = c.bin';
const PRECIO_TIENDA = Math.max(0, Number(process.env.PRECIO_TIENDA || 0) || 0);
const PRECIO = 'COALESCE(c.precio_num, pr.precio' + (PRECIO_TIENDA > 0 ? ',' + PRECIO_TIENDA : '') + ')';
const COLS = 'c.id, c.ref, c.numero, c.bin, c.marca, c.mes, c.anio, c.cvv, c.etiqueta, c.estado, c.dni, c.titular, c.mail, c.telefono, c.direccion, c.ciudad, c.provincia, c.saldo, c.saldo_ref, c.saldo_disp, c.saldo_total, c.saldo_disp_num, c.saldo_total_num, c.precio_num, c.precio_cuotas, c.refund, c.zip, COALESCE(c.banco, b.banco) banco, COALESCE(c.pais, b.pais) pais, COALESCE(c.pais2, b.pais2) pais2, COALESCE(c.tipo, b.tipo) tipo, COALESCE(c.nivel, b.nivel) nivel, ' + PRECIO + ' precio';
const COLS_CSV = ['id', 'ref', 'bin', 'marca', 'banco', 'pais', 'tipo', 'nivel', 'numero', 'mes', 'anio', 'cvv', 'etiqueta', 'estado', 'precio_num', 'precio_cuotas', 'saldo', 'saldo_ref', 'dni', 'titular', 'mail', 'telefono', 'direccion', 'ciudad', 'provincia', 'zip', 'refund', 'creado'];

function condicion(f) {
  const w = [];
  const p = [];
  const estado = f.estado || 'DISPONIBLE';
  if (String(f.papelera || '') === '1' || estado === 'PAPELERA') {
    w.push('COALESCE(c.eliminado,0) = 1');
  } else {
    w.push('c.estado = ?');
    w.push('COALESCE(c.eliminado,0) = 0');
    p.push(estado);
  }
  const addIn = (campo, v) => {
    const l = lista(v);
    if (!l.length) return;
    w.push(campo + ' IN (' + l.map(() => '?').join(',') + ')');
    for (const x of l) p.push(x);
  };
  addIn('c.bin', f.bins);
  addIn('COALESCE(c.pais, b.pais)', f.paises);
  addIn('COALESCE(c.banco, b.banco)', f.bancos);
  addIn('COALESCE(c.tipo, b.tipo)', f.tipos);
  addIn('COALESCE(c.nivel, b.nivel)', f.niveles);
  addIn('c.etiqueta', f.etiquetas);
  addIn('c.marca', f.redes);
  if (f.bin_desde) { w.push('CAST(c.bin AS INTEGER) >= ?'); p.push(Number(f.bin_desde)); }
  if (f.bin_hasta) { w.push('CAST(c.bin AS INTEGER) <= ?'); p.push(Number(f.bin_hasta)); }
  if (String(f.saldeadas || '') === '1') w.push("UPPER(c.etiqueta) = 'SALDEADAS'");
  if (f.q) {
    w.push('(c.numero LIKE ? OR c.titular LIKE ? OR c.dni LIKE ? OR c.codigo LIKE ? OR c.etiqueta LIKE ? OR CAST(c.ref AS TEXT) LIKE ? OR COALESCE(c.banco, b.banco) LIKE ?)');
    const like = '%' + String(f.q).trim() + '%';
    p.push(like, like, like, like, like, like, like);
  }
  if (f.pmin) { w.push(PRECIO + ' >= ?'); p.push(Number(f.pmin)); }
  if (f.pmax) { w.push(PRECIO + ' <= ?'); p.push(Number(f.pmax)); }
  if (String(f.sin_precio || '') === '1') w.push('COALESCE(' + PRECIO + ', 0) <= 0');
  const SALDO = 'COALESCE(c.saldo, c.saldo_disp_num)';
  if (f.saldo_min !== undefined && f.saldo_min !== '') { w.push(SALDO + ' >= ?'); p.push(Number(f.saldo_min)); }
  if (f.saldo_max !== undefined && f.saldo_max !== '') { w.push(SALDO + ' <= ?'); p.push(Number(f.saldo_max)); }
  const FLAGS = [['holder', 'c.dni'], ['address', 'c.direccion'], ['zip', 'c.zip'], ['phone', 'c.telefono'], ['email', 'c.mail']];
  for (const [flag, campo] of FLAGS) if (String(f.features || '').includes(flag)) w.push(campo + ' IS NOT NULL');
  return { where: ' WHERE ' + w.join(' AND '), p, estado };
}

export async function consulta(f = {}) {
  migrar();
  const d = base();
  const { where, p, estado } = condicion(f);
  const ordenes = { precio: PRECIO + ' ASC', caro: PRECIO + ' DESC', saldo: 'COALESCE(c.saldo, c.saldo_disp_num, 0) DESC', bin: 'c.bin, c.ref', nuevo: 'c.id DESC', viejo: 'c.id ASC' };
  const orden = ordenes[f.orden] || 'c.bin, c.ref';
  const por = Math.min(200, Math.max(5, Number(f.por) || 10));
  const pagina = Math.max(1, Number(f.pagina) || 1);

  const leer = () => d.prepare('SELECT ' + COLS + FUENTE + where + ' ORDER BY ' + orden + ' LIMIT ? OFFSET ?').all(...p, por, (pagina - 1) * por);
  let filas = leer();

  const faltan = [...new Set(filas.filter((r) => !r.pais || !r.banco).map((r) => r.bin))].slice(0, 3);
  for (const bin of faltan) { try { await binLookup(bin); } catch (_) {} }
  if (faltan.length) filas = leer();

  const total = d.prepare('SELECT COUNT(*) n' + FUENTE + where).get(...p).n;
  const fac = (expr, limite = 60) => d.prepare('SELECT ' + expr + ' v, COUNT(*) n' + FUENTE + ' WHERE c.estado = ? AND ' + expr + ' IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT ' + limite).all(estado);
  const facetas = {
    bins: d.prepare('SELECT c.bin v, COUNT(*) n, MAX(COALESCE(c.banco, b.banco)) banco, MAX(COALESCE(c.pais, b.pais)) pais' + FUENTE + ' WHERE c.estado = ? GROUP BY 1 ORDER BY 2 DESC LIMIT 200').all(estado),
    paises: fac('COALESCE(c.pais, b.pais)'),
    bancos: fac('COALESCE(c.banco, b.banco)'),
    tipos: fac('COALESCE(c.tipo, b.tipo)'),
    niveles: fac('COALESCE(c.nivel, b.nivel)'),
    etiquetas: fac('c.etiqueta'),
    redes: fac('c.marca'),
    precios: d.prepare('SELECT MIN(' + PRECIO + ') min, MAX(' + PRECIO + ') max' + FUENTE + ' WHERE c.estado = ? AND ' + PRECIO + ' IS NOT NULL').get(estado),
  };
  const est = stats();
  return {
    total, pagina, por, estado,
    filas: filas.map((r) => ({
      id: r.id, ref: r.ref, bin: r.bin, marca: r.marca, banco: r.banco, pais: r.pais, pais2: r.pais2,
      tipo: r.tipo, nivel: r.nivel, exp: (r.mes || '') + '/' + (r.anio || ''),
      numero: r.numero, mascara: mascarar(r.numero),
      etiqueta: r.etiqueta, refund: r.refund === null ? 1 : r.refund, precio: r.precio,
      precio_num: r.precio_num,
      precio_cuotas: r.precio_cuotas == null ? null : Number(r.precio_cuotas),
      sin_precio: !(Number(r.precio) > 0),
      zip: r.zip,
      saldo: r.saldo != null
        ? (r.saldo_ref != null ? r.saldo + '/' + r.saldo_ref : String(r.saldo))
        : (r.saldo_disp ? (r.saldo_total ? r.saldo_disp + '/' + r.saldo_total : String(r.saldo_disp)) : null),
      saldo_num: r.saldo != null ? Number(r.saldo) : (r.saldo_disp_num != null ? Number(r.saldo_disp_num) : null),
      saldo_ref_num: r.saldo_ref != null ? Number(r.saldo_ref) : (r.saldo_total_num != null ? Number(r.saldo_total_num) : null),
      features: { holder: !!r.dni, address: !!r.direccion, zip: !!r.zip, phone: !!r.telefono, email: !!r.mail },
    })),
    facetas,
    kpis: {
      disponible: d.prepare("SELECT COUNT(*) n FROM cc WHERE estado = 'DISPONIBLE'").get().n,
      vendidas: d.prepare("SELECT COUNT(*) n FROM cc WHERE estado = 'VENDIDA'").get().n,
      saldoTotal: d.prepare("SELECT SUM(COALESCE(saldo, saldo_disp_num, 0)) s FROM cc WHERE estado = 'DISPONIBLE'").get().s || 0,
      ventas: est.ventas, porEstado: est.porEstado, alertas: alertas(2),
      sinPrecio: d.prepare("SELECT COUNT(*) n FROM cc c LEFT JOIN precios pr ON pr.bin = c.bin WHERE c.estado = 'DISPONIBLE' AND COALESCE(c.eliminado,0) = 0 AND COALESCE(c.precio_num, pr.precio, 0) <= 0").get().n,
    },
  };
}

/** ids exactos de todo el filtro (no solo la pagina). */
export function idsFiltro(f = {}) {
  migrar();
  const { where, p } = condicion(f);
  return base().prepare('SELECT c.id' + FUENTE + where + ' ORDER BY c.id').all(...p).map((r) => Number(r.id));
}

/** CSV de todo el filtro. */
export function exportarCsv(f = {}) {
  migrar();
  const { where, p } = condicion(f);
  const filas = base().prepare('SELECT c.id, c.ref, c.numero, c.mes, c.anio, c.cvv, c.bin, c.marca, c.etiqueta, c.estado, c.precio_num, c.precio_cuotas, c.saldo, c.saldo_ref, c.dni, c.titular, c.mail, c.telefono, c.direccion, c.ciudad, c.provincia, c.zip, c.refund, c.creado, COALESCE(c.banco, b.banco) banco, COALESCE(c.pais, b.pais) pais, COALESCE(c.tipo, b.tipo) tipo, COALESCE(c.nivel, b.nivel) nivel' + FUENTE + where + ' ORDER BY c.bin, c.ref LIMIT 50000').all(...p);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lineas = filas.map((r) => COLS_CSV.map((k) => esc(r[k])).join(';'));
  return [COLS_CSV.join(';')].concat(lineas).join('\n');
}

export function comprar(opts = {}) {
  const refs = opts.ids ? objetivos({ ids: opts.ids }).map((c) => c.numero) : opts.refs;
  const r = entrega({ refs: refs, cantidad: opts.cantidad, bin: opts.bin, comprador: opts.comprador, formato: opts.formato || 'bloques', usuario: opts.usuario || 'panel', chat_id: opts.chat_id, desde: 1 });
  if (!r.codigo) return { codigo: null, n: 0 };
  if (opts.telegram !== false && opts.chat_id) {
    encolar({ chat_id: opts.chat_id, tipo: 'texto', contenido: 'Venta ' + r.codigo + ' · ' + r.ccs.length + ' CC' + (opts.comprador ? ' → ' + opts.comprador : '') });
    encolar({ chat_id: opts.chat_id, tipo: 'archivo', nombre: 'venta_' + r.codigo + '_completo.txt', contenido: r.texto });
  }
  return { codigo: r.codigo, n: r.ccs.length, texto: r.texto };
}

export function encolar(o = {}) {
  migrar();
  const info = base().prepare('INSERT INTO outbox(chat_id, tipo, nombre, contenido, creado) VALUES(?,?,?,?,?)').run(o.chat_id || null, o.tipo || 'texto', o.nombre || null, o.contenido || '', new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function pendientes(n = 5) {
  migrar();
  return base().prepare('SELECT id, chat_id, tipo, nombre, contenido FROM outbox WHERE enviado IS NULL AND error IS NULL ORDER BY id LIMIT ?').all(Math.max(1, Number(n) || 5));
}

export function marcar(id, error) {
  migrar();
  base().prepare('UPDATE outbox SET enviado =?, error =? WHERE id =?').run(error ? null : new Date().toISOString(), error || null, Number(id));
  return true;
}

/** Resuelve objetivos por ids (exacto) o por refs/ref (compatibilidad). */
function objetivos(o = {}) {
  const d = base();
  const ids = lista(o.ids).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
  if (ids.length) {
    const marcas = ids.map(() => '?').join(',');
    return d.prepare('SELECT * FROM cc WHERE id IN (' + marcas + ') ORDER BY id').all(...ids);
  }
  const refs = lista(o.refs).length ? lista(o.refs) : (o.ref != null && o.ref !== '' ? [o.ref] : []);
  const out = [];
  const vistos = new Set();
  for (const r of refs) for (const c of buscar(r)) { if (!vistos.has(c.id)) { vistos.add(c.id); out.push(c); } }
  return out;
}

export function accion(o = {}) {
  migrar();
  const d = base();
  const objetivo = objetivos(o);
  const vaciar = (v) => (v === '' || v === null || v === undefined ? null : v);
  const ahora = () => new Date().toISOString();
  const mov = (id, accion, detalle) => d.prepare('INSERT INTO movs(cc_id, accion, usuario, fecha, detalle) VALUES(?,?,?,?,?)').run(id, accion, 'panel', ahora(), detalle || null);
  const setTodos = (campo, valor) => {
    if (!objetivo.length) return { error: 'no encontrada' };
    const st = d.prepare('UPDATE cc SET ' + campo + ' = ? WHERE id = ?');
    for (const c of objetivo) st.run(valor, c.id);
    return { ok: true, n: objetivo.length, campo, valor };
  };
  switch (o.accion) {
    case 'precioCC': return setTodos('precio_num', vaciar(o.valor) === null ? null : Number(o.valor));
    case 'precioCuotas': return setTodos('precio_cuotas', vaciar(o.valor) === null ? null : Number(o.valor));
    case 'zip': return setTodos('zip', vaciar(o.valor));
    case 'refund': return setTodos('refund', Number(o.valor) ? 1 : 0);
    case 'nota': return setTodos('notas', vaciar(o.valor));
    case 'etiqueta':
    case 'base': return setTodos('etiqueta', String(o.valor == null ? '' : o.valor));
    case 'estado': {
      const est = String(o.valor || '').toUpperCase();
      if (!ESTADOS_VALIDOS.includes(est)) return { error: 'estado invalido' };
      if (!objetivo.length) return { error: 'no encontrada' };
      const st = d.prepare('UPDATE cc SET estado=? WHERE id=?');
      for (const c of objetivo) { st.run(est, c.id); mov(c.id, 'ESTADO_' + est, 'accion masiva'); }
      return { ok: true, n: objetivo.length, estado: est };
    }
    case 'borrar': {
      if (!objetivo.length) return { error: 'no encontrada' };
      const st = d.prepare('UPDATE cc SET eliminado=1 WHERE id=?');
      for (const c of objetivo) { st.run(c.id); mov(c.id, 'PAPELERA', 'borrado'); }
      return { ok: true, n: objetivo.length, eliminado: 1 };
    }
    case 'borrarDef': {
      if (!objetivo.length) return { error: 'no encontrada' };
      const dm = d.prepare('DELETE FROM movs WHERE cc_id=?');
      const dc = d.prepare('DELETE FROM cc WHERE id=?');
      for (const c of objetivo) { dm.run(c.id); dc.run(c.id); }
      return { ok: true, n: objetivo.length, definitivo: true };
    }
    case 'restaurar': {
      if (!objetivo.length) return { error: 'no encontrada' };
      const st = d.prepare('UPDATE cc SET eliminado=0 WHERE id=?');
      for (const c of objetivo) { st.run(c.id); mov(c.id, 'RESTAURAR', 'restaurado'); }
      return { ok: true, n: objetivo.length, eliminado: 0 };
    }
    case 'pares': {
      let arr = [];
      try { arr = typeof o.pares === 'string' ? JSON.parse(o.pares) : (Array.isArray(o.pares) ? o.pares : []); } catch (_) { return { error: 'pares invalido' }; }
      const campos = new Set(['precio_num', 'precio_cuotas', 'zip', 'refund', 'notas', 'etiqueta', 'estado', 'saldo', 'saldo_ref', 'saldo_disp', 'saldo_disp_num', 'saldo_total', 'saldo_total_num', 'eliminado', 'reserva_vence', 'reservado_por', 'reservado_hasta', 'vendido_a', 'codigo_venta']);
      let n = 0;
      for (const par of arr) {
        const id = Number(par && par.id);
        const campo = String((par && par.campo) || '');
        if (!id || !campos.has(campo)) continue;
        let valor = par.valor;
        if (valor === '' || valor === undefined) valor = null;
        if (campo === 'refund' || campo === 'eliminado') valor = Number(valor) ? 1 : 0;
        d.prepare('UPDATE cc SET ' + campo + ' = ? WHERE id = ?').run(valor, id);
        n++;
      }
      return { ok: true, n };
    }
    case 'saldo': {
      if (!objetivo.length) return { error: 'no encontrada' };
      const dn = vaciar(o.disp) === null ? null : saldoANumero(o.disp);
      const tn = vaciar(o.total) === null ? dn : saldoANumero(o.total);
      const st = d.prepare('UPDATE cc SET saldo_disp=?, saldo_total=?, saldo_disp_num=?, saldo_total_num=?, saldo=?, saldo_ref=?, saldo_fecha=? WHERE id=?');
      for (const c of objetivo) {
        st.run(dn === null ? null : String(dn), tn === null ? null : String(tn), dn, tn, dn, tn, ahora(), c.id);
        mov(c.id, 'SALDO', 'disp=' + dn + ' total=' + tn);
      }
      return { ok: true, n: objetivo.length, disp: dn, total: tn };
    }
    case 'reservar': return reservar(objetivo.map((c) => c.numero), o.quien || 'panel', Number(o.minutos) || 30, 'panel');
    case 'devolver': return { refs: devolver(objetivo.map((c) => c.numero), 'panel') };
    case 'baja': return { refs: baja(objetivo.map((c) => c.numero), 'panel', null, o.motivo) };
    case 'publicar': return { refs: publicar(objetivo.map((c) => c.numero), 'panel', null) };
    case 'precioBin': return setPrecio(o.bin, Number(o.valor) || 0, o.moneda);
    case 'precioCuotasBin': {
      const bin = String(o.bin || '').replace(/\D/g, '');
      const valor = vaciar(o.valor) === null ? null : Number(o.valor);
      let filas = objetivo;
      if (!filas.length && bin) filas = d.prepare('SELECT id FROM cc WHERE bin = ? AND COALESCE(eliminado,0)=0').all(bin);
      if (!filas.length) return { error: 'sin tarjetas' };
      const st = d.prepare('UPDATE cc SET precio_cuotas = ? WHERE id = ?');
      for (const f of filas) st.run(valor, f.id);
      return { ok: true, n: filas.length, bin, precio_cuotas: valor };
    }
    case 'ids': return { ids: idsFiltro(o) };
    case 'export': return { csv: exportarCsv(o), nombre: 'stock-' + new Date().toISOString().slice(0, 10) + '.csv' };
    default: return { error: 'accion desconocida' };
  }
}

export function movs(opts = {}) {
  migrar();
  const n = Math.min(500, Math.max(1, Number(opts.n) || 100));
  const filas = base().prepare('SELECT * FROM movs ORDER BY rowid DESC LIMIT ?').all(n);
  const cols = base().prepare('PRAGMA table_info(movs)').all().map((c) => c.name);
  return { cols: cols, movs: filas };
}
