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
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { armarBloque, SEPARADOR, normalizarTitular } from './lote.js'; import * as persona from './persona.js';
import { mascarar } from './mascara.js';
import { precioCorto } from './precio-corto.js';
import * as notificaciones from './notificaciones.js';

const RUTA = process.env.RESOLVER_STOCK_DB || path.join(import.meta.dirname, '..', 'datos', 'stock.db');
export const ETIQUETA_DEFECTO = 'Saldeadas';
export const ESTADOS = ['DISPONIBLE', 'RESERVADA', 'PAGADA', 'VENDIDA', 'BAJA', 'RECLAMADA', 'ANULADA', 'REVISION'];

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
  col('cc', 'eliminado', 'INTEGER DEFAULT 0');
  col('cc', 'es_test', 'INTEGER DEFAULT 0');
  col('cc', 'saldo_disp_num', 'INTEGER');
  col('cc', 'saldo_total_num', 'INTEGER');
  col('cc', 'saldo', 'INTEGER');
  col('cc', 'saldo_ref', 'INTEGER');
  col('cc', 'moneda', "TEXT DEFAULT 'CLP'");
  col('cc', 'reservado_por', 'TEXT');
  col('cc', 'reservado_el', 'TEXT');
  col('cc', 'reservado_hasta', 'TEXT');
  col('cc', 'asignada_en', 'TEXT');
  col('cc', 'verif_estado', "TEXT DEFAULT 'sin_verificar'");
  col('cc', 'verif_intentos', 'INTEGER DEFAULT 0');
  col('cc', 'reserva_vence', 'TEXT');col('cc', 'codigo_venta', 'TEXT');
  /* Campos de la carga masiva del panel (fase analizar/confirmar). */
  col('cc', 'codigo', 'TEXT');
  col('cc', 'huella', 'TEXT');
  col('cc', 'numero_mask', 'TEXT');
  col('cc', 'luhn_ok', 'INTEGER');
  col('cc', 'largo_ok', 'INTEGER');
  col('cc', 'venc_mm', 'TEXT');
  col('cc', 'venc_yy', 'TEXT');
  col('cc', 'dias_para_vencer', 'INTEGER');
  col('cc', 'vencida', 'INTEGER');
  col('cc', 'lote_id', 'INTEGER');
  col('cc', 'precio_sugerido', 'INTEGER');
  col('cc', 'precio_cuotas', 'INTEGER');
  /* Columnas que el panel agrega; se aseguran aca para una base nueva. */
  col('cc', 'banco', 'TEXT');
  col('cc', 'pais', 'TEXT');
  col('cc', 'pais2', 'TEXT');
  col('cc', 'tipo', 'TEXT');
  col('cc', 'nivel', 'TEXT');
  col('cc', 'zip', 'TEXT');
  col('cc', 'refund', 'INTEGER DEFAULT 1');
  col('cc', 'precio_num', 'INTEGER');
  db.exec('CREATE TABLE IF NOT EXISTS lotes_cc(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, archivo TEXT, ' +
    'total INTEGER DEFAULT 0, ok INTEGER DEFAULT 0, duplicadas INTEGER DEFAULT 0, ' +
    'invalidas INTEGER DEFAULT 0, estado TEXT, creado TEXT, meta TEXT, es_test INTEGER DEFAULT 0)');
  col('lotes_cc', 'es_test', 'INTEGER DEFAULT 0');
  db.exec('CREATE TABLE IF NOT EXISTS precios(bin TEXT PRIMARY KEY, precio INTEGER NOT NULL, moneda TEXT, actualizado TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS bininfo(bin TEXT PRIMARY KEY, marca TEXT, tipo TEXT, nivel TEXT, banco TEXT, pais TEXT, pais2 TEXT, moneda TEXT, json TEXT, fuente TEXT, actualizado TEXT)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cc_estado ON cc(estado)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cc_ref ON cc(bin, ref)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cc_codigo ON cc(codigo_venta)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_huella ON cc(huella) WHERE huella IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_codigo_publico ON cc(codigo) WHERE codigo IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cc_lote_id ON cc(lote_id)');
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

export const mascara = mascarar;
export const mascaraBonita = mascarar;

/* ---------------------- carga masiva del panel ---------------------------- */
/* Codigo publico corto: base32 sin caracteres ambiguos (0/O/1/I/L). */
const ALFABETO = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function codigoCorto(largo = 7) {
  const b = crypto.randomBytes(largo);
  let s = '';
  for (let i = 0; i < largo; i++) s += ALFABETO[b[i] % ALFABETO.length];
  return s;
}

export const huellaDe = (n) => crypto.createHash('sha256').update(soloDigitos(n)).digest('hex');

/** Normaliza vencimiento a {mm:'07', yy:'2028'}. Acepta 7, 07, 2028, 28. */
export function normalizarVenc(mes, anio) {
  const m = soloDigitos(mes);
  let mm = m.slice(-2).padStart(2, '0');
  if (!m || Number(mm) < 1 || Number(mm) > 12) mm = null;
  let y = soloDigitos(anio);
  if (y.length === 2) y = '20' + y;
  const yy = y.length === 4 ? y : null;
  return { mm, yy };
}

/** Dias hasta el fin del mes de vencimiento (negativo = vencida). */
export function diasParaVencer(mm, yy) {
  if (!mm || !yy) return null;
  const fin = new Date(Number(yy), Number(mm), 0, 23, 59, 59).getTime();
  return Math.ceil((fin - Date.now()) / 86400000);
}

const CAMPOS_CABECERA = [
  ['numero', /^(numero|n[uú]mero|card|pan|tarjeta|cc)$/i],
  ['venc', /^(venc|vencimiento|exp|expira| expiry)$/i],
  ['mes', /^(mes|mm|month)$/i],
  ['anio', /^(anio|año|ano|yy|year)$/i],
  ['cvv', /^(cvv|cvc|codigo|c[oó]digo|cod)$/i],
  ['titular', /^(titular|nombre|holder|name)$/i],
  ['dni', /^(dni|documento|doc)$/i],
  ['banco', /^(banco|bank|emisor)$/i],
  ['precio', /^(precio|price|valor|importe)$/i],
  ['precio_cuotas', /^(precio_cuotas|cuotas|en_cuotas|precio_cuota)$/i],
  ['saldo', /^(saldo|saldo_disp|disponible)$/i],
  ['saldo_ref', /^(saldo_ref|saldo_total|total)$/i],
  ['nota', /^(nota|notas|obs|observacion|observaci[oó]n)$/i],
];

function mapaCabecera(linea) {
  const tokens = linea.split(/\s*[|;\t,]\s*/).map((t) => t.trim().replace(/^["']|["']$/g, ''));
  if (tokens.length < 2) return null;
  const mapa = {};
  let reconocidos = 0;
  tokens.forEach((t, i) => {
    for (const [campo, re] of CAMPOS_CABECERA) {
      if (re.test(t)) { if (!(campo in mapa)) { mapa[campo] = i; reconocidos++; } break; }
    }
  });
  return reconocidos >= 2 ? mapa : null;
}

function esCvv(t) { return /^\d{3,4}$/.test(t); }
function esDni(t) { return /^\d{7,8}$/.test(t) || /^\d{2}\.?\d{3}\.?\d{3}$/.test(t); }

function vencDeToken(t) {
  const m = String(t).match(/^(\d{1,2})\s*[\/\-.]\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  return normalizarVenc(m[1], m[2]);
}

/**
 * Parser flexible: acepta | ; tab , o espacios, con o sin cabecera.
 * Campos: numero, venc (MM/YY), cvv, titular, dni, banco, precio, nota.
 * Devuelve filas crudas; la validacion la hace cargar().
 */
/** Salida multilínea de /lote: bloques TARJETA # ... DATOS TARJETA. */
function parsearBloquesLote(texto) {
  const bloques = String(texto == null ? '' : texto).split(/(?=^TARJETA #\d+\s*$)/m)
    .filter((b) => /^TARJETA #\d+\s*$/m.test(b));
  const out = [];
  for (const bloque of bloques) {
    const campo = (etiqueta) => {
      const m = bloque.match(new RegExp('^' + etiqueta + '\\s+(.+)$', 'm'));
      return m ? m[1].trim() : null;
    };
    const numero = soloDigitos(campo('CC'));
    if (!numero) continue;
    const venc = vencDeToken(campo('VENCIMIENTO') || '');
    /* SALDO viene como "disponible/referencia" (ej. 21m/61m696k). */
    const saldoBruto = campo('SALDO') || '';
    const mitades = saldoBruto.split('/');
    const val = (etiqueta) => { const v = campo(etiqueta); return v && v !== '-' ? v : null; };
    out.push({
      linea: bloque.split('\n')[0] || 'bloque', formato: 'bloque', numero,
      mes: venc ? venc.mm : null, anio: venc ? venc.yy : null,
      cvv: campo('CODIGO') || null,
      titular: val('TITULAR'),
      dni: val('DNI') ? soloDigitos(val('DNI')) : null,
      fechaNac: val('FECHA NAC'),
      mail: val('MAIL'),
      telefono: val('TELEFONO'),
      direccion: val('DIRECCION'),
      ciudad: val('CIUDAD'),
      provincia: val('PROVINCIA'),
      saldo: mitades[0] ? mitades[0].trim() : null,
      saldo_ref: mitades[1] ? mitades[1].trim() : null,
      saldo_disp: mitades[0] ? mitades[0].trim() : null,
      saldo_total: mitades[1] ? mitades[1].trim() : null,
      banco: null, precio: null, notas: null,
    });
  }
  return out;
}

export function parsearEntradaFlexible(texto) {
  const original = String(texto == null ? '' : texto);
  if (/^TARJETA #\d+\s*$/m.test(original) && /^DATOS TARJETA\s*$/m.test(original)) {
    return parsearBloquesLote(original);
  }
  const lineas = original.split(/\r?\n/);
  const out = [];
  let cabecera = null;
  let primera = true;
  for (const cruda of lineas) {
    let s = cruda.replace(/^\uFEFF/, '').trim();
    if (!s || s.charAt(0) === '#') continue;
    if (primera) {
      primera = false;
      const m = mapaCabecera(s);
      if (m) { cabecera = m; continue; }
    }
    /* Formato nuevo de 11 campos con pipes:
     * NUMERO|VENC|CVV|TITULAR|DNI|NACIMIENTO|MAIL|TELEFONO|DIRECCION|CIUDAD|PROVINCIA
     * Los pipes con menos campos siguen cayendo al parser viejo (lotes 4 campos). */
    const pipe = s.split('|').map((x) => x.trim());
    if (pipe.length >= 11) {
      const v = vencDeToken(pipe[1]);
      out.push({
        linea: cruda, formato: 'pipe', numero: pipe[0] || null,
        mes: v ? v.mm : (pipe[1] || null), anio: v ? v.yy : null,
        cvv: pipe[2] || null, titular: pipe[3] || null, dni: pipe[4] || null,
        fechaNac: pipe[5] || null, mail: pipe[6] || null, telefono: pipe[7] || null,
        direccion: pipe[8] || null, ciudad: pipe[9] || null, provincia: pipe[10] || null,
        saldo_disp: pipe[11] || null, saldo_total: pipe[12] || null,
        saldo: pipe[11] || null, saldo_ref: pipe[12] || null,
        banco: null, precio: null, precio_cuotas: null, notas: null,
      });
      continue;
    }

    if (pipe.length >= 5 && pipe.length <= 6 && !vencDeToken(pipe[4])) {
      const v = vencDeToken(pipe[1]);
      out.push({
        linea: cruda, formato: 'viejo', numero: pipe[0] || null,
        mes: (v && v.mm) ? v.mm : (pipe[1] || null), anio: (v && v.yy) ? v.yy : (pipe[2] || null), cvv: pipe[3] || null,
        saldo_disp: pipe[4] || null, saldo_total: pipe[5] || null,
        saldo: pipe[4] || null, saldo_ref: pipe[5] || null,
        titular: null, dni: null, banco: null, precio: null, precio_cuotas: null, notas: null,
      });
      continue;
    }

    const fuertes = s.split(/\s*[|;\t,]\s*/).map((x) => x.trim()).filter(Boolean);
    const tokens = fuertes.length > 1 ? fuertes : s.split(/\s+/).filter(Boolean);
    const f = { linea: cruda, formato: 'viejo', numero: null, mes: null, anio: null, cvv: null, titular: null, dni: null, banco: null, precio: null, precio_cuotas: null, notas: null };

    if (cabecera) {
      const get = (campo) => (cabecera[campo] != null ? (tokens[cabecera[campo]] || '').trim() : '');
      f.numero = get('numero');
      f.cvv = get('cvv');
      f.titular = get('titular');
      f.dni = get('dni');
      f.banco = get('banco');
      f.precio = get('precio') || null;
      f.precio_cuotas = get('precio_cuotas') || null;
      f.saldo = get('saldo') || null;
      f.saldo_ref = get('saldo_ref') || null;
      f.notas = get('nota') || null;
      if (cabecera.venc != null) {
        const v = vencDeToken(get('venc'));
        if (v) { f.mes = v.mm; f.anio = v.yy; }
      } else {
        f.mes = get('mes') || null;
        f.anio = get('anio') || null;
      }
    } else {
      /* Sin cabecera: detectar por patron. El numero es el token mas largo
       * que pase Luhn; si ninguno pasa, el mas largo de 12-19 digitos. */
      let idxNumero = -1;
      let mejorLuhn = -1;
      let mejorLargo = -1;
      tokens.forEach((t, i) => {
        const d = soloDigitos(t);
        if (d.length < 12 || d.length > 19) return;
        if (luhn(d) && d.length > mejorLuhn) { mejorLuhn = d.length; idxNumero = i; }
        if (d.length > mejorLargo) mejorLargo = d.length;
      });
      if (idxNumero < 0) {
        tokens.forEach((t, i) => {
          const d = soloDigitos(t);
          if (d.length >= 12 && d.length <= 19 && d.length === mejorLargo) idxNumero = idxNumero < 0 ? i : idxNumero;
        });
      }
      if (idxNumero >= 0) f.numero = tokens[idxNumero];

      tokens.forEach((t, i) => {
        if (i === idxNumero) return;
        if (!f.mes && vencDeToken(t)) { const v = vencDeToken(t); f.mes = v.mm; f.anio = v.yy; return; }
        if (!f.saldo && /^[\d.,]+[km]?(\/[\d.,]+[km]?)?$/i.test(t) && /[km/]/i.test(t)) {
          const partes = t.split('/');
          f.saldo = partes[0] || null; f.saldo_ref = partes[1] || null;
          return;
        }
        if (!f.cvv && esCvv(t)) { f.cvv = t; return; }
        if (!f.dni && esDni(t)) { f.dni = t; return; }
        if (!f.precio && /^\$?\d{1,9}([.,]\d{1,2})?$/.test(t)) { f.precio = t; return; }
        if (!f.precio_cuotas && /^\$?\d{1,9}([.,]\d{1,2})?$/.test(t) && f.precio) { f.precio_cuotas = t; return; }
        if (!f.titular && /[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(t) && !f.banco) { f.titular = t; return; }
        if (!f.banco && /[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(t)) { f.banco = t; return; }
        if (!f.notas) f.notas = t;
      });
    }
    out.push(f);
  }
  return out;
}


export function saldoANumero(txt) {
  let s = String(txt === null || txt === undefined ? '' : txt).trim().toLowerCase().replace(/\s/g, '');
  if (!s) return null;
  /* Formato humano de miles AR: "1.234.567" o "1.234,56" → normalizar a número. */
  if (/^\$?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  s = s.replace(/^\$/, '');
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d+\.\d+$/.test(s)) return Number(s);
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
  const publicarDirecto = String(process.env.PUBLICAR_DIRECTO ?? '0') === '1';
  const flexible = opts.flexible === true || opts.fase !== undefined || opts.columnas !== undefined;
  const lineas = typeof entrada === 'string'
    ? (flexible ? parsearEntradaFlexible(entrada) : parsearLineasCarga(entrada))
    : entrada;
  const usuario = opts.usuario || null;
  const chat_id = opts.chat_id || null;
  const lote = opts.lote || opts.nombre || ahora().slice(0, 19).replace('T', ' ');
  const analizar = opts.fase === 'analizar';
  const reactivarBajas = opts.reactivar === true;
  const res = {
    fase: analizar ? 'analizar' : 'confirmar',
    lote, lote_id: null, total: lineas.length,
    nuevas: 0, reactivadas: [], duplicadas: [], invalidas: [], avisos: [], ids: [], filas: [], binsNuevos: [],
  };
  let loteId = null;
  if (!analizar) {
    const info = d.prepare('INSERT INTO lotes_cc(nombre, archivo, total, estado, creado, meta, es_test) VALUES(?,?,?,?,?,?,?)')
      .run(lote, opts.archivo || null, lineas.length, 'procesando', ahora(), null, opts.es_test ? 1 : 0);
    loteId = Number(info.lastInsertRowid);
    res.lote_id = loteId;
  }

  const ins = d.prepare(
    'INSERT INTO cc(numero, mes, anio, cvv, bin, marca, dni, titular, banco, precio, precio_num, ' +
    'saldo_disp, saldo_total, saldo_disp_num, saldo_total_num, moneda, etiqueta, lote, lote_id, notas, creado, ref, ' +
    'codigo, huella, numero_mask, luhn_ok, largo_ok, venc_mm, venc_yy, dias_para_vencer, vencida, precio_sugerido, ' +
    'saldo, saldo_ref, precio_cuotas, es_test) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const vistos = new Set();
  if (!analizar) d.exec('BEGIN');
  try {
    for (const l of lineas) {
      const numero = soloDigitos(l.numero);
      const mask = numero ? mascaraBonita(numero) : '(vacio)';
      const nuevoFormato = l.formato === 'pipe' || l.formato === 'bloque';
      const baseFila = {
        linea: l.linea != null ? String(l.linea).slice(0, 120) : null,
        numero_mask: mask, bin: numero ? binDe(numero) : null,
        mes: l.mes || null, anio: l.anio || null, titular: l.titular || null,
        dni: l.dni ? soloDigitos(l.dni) : null, banco: l.banco || null, precio: l.precio || null,
        formato: l.formato || 'viejo',
      };
      const invalida = (motivo) => {
        res.invalidas.push({ numero_mask: mask, motivo });
        res.filas.push({ ...baseFila, estado: 'invalida', motivo });
      };
      if (!numero) { invalida('vacio'); continue; }
      if (!luhn(numero)) { invalida('luhn'); continue; }
      if (numero.length < 12 || numero.length > 19) { invalida('largo ' + numero.length); continue; }

      const huella = huellaDe(numero);
      const ya = d.prepare('SELECT id, ref, estado, vendido_el, codigo FROM cc WHERE huella = ? OR numero = ? LIMIT 1').get(huella, numero);
      let reactivando = null;
      if (ya) {
        const esBaja = String(ya.estado).toUpperCase() === 'BAJA';
        if (esBaja && reactivarBajas) {
          reactivando = ya;
        } else {
          res.duplicadas.push({
            numero_mask: mask, ref: ya.ref, estado: ya.estado, vendido_el: ya.vendido_el,
            reactivable: esBaja,
          });
          res.filas.push({
            ...baseFila, estado: 'duplicada',
            puede_reactivar: esBaja,
            motivo: esBaja
              ? 'ya existe en BAJA (se puede reactivar)'
              : 'ya existe (ref ' + ya.ref + ', ' + ya.estado + ')',
          });
          continue;
        }
      }
      if (vistos.has(huella)) {
        res.duplicadas.push({ numero_mask: mask, ref: null, estado: 'EN EL LOTE' });
        res.filas.push({ ...baseFila, estado: 'duplicada', motivo: 'repetida en el mismo lote' });
        continue;
      }
      vistos.add(huella);

      /* Formato pipe: el TITULAR pegado se compara contra el derivado por DNI. */
      if (nuevoFormato && baseFila.dni) {
        const titularDerivado = derivarTitular(baseFila.dni);
        const coincide = titularDerivado ? mismoTitular(l.titular, titularDerivado) : null;
        let aviso = null;
        if (!titularDerivado) aviso = 'sin titular derivado para comparar';
        else if (coincide === false) aviso = 'TITULAR no coincide: pegado "' + (l.titular || '') + '" / derivado "' + titularDerivado + '"';
        baseFila.titular_derivado = titularDerivado;
        baseFila.titular_coincide = coincide;
        baseFila.aviso = aviso;
        if (aviso) res.avisos.push({ numero: mask, motivo: aviso });
      }

      const bin = binDe(numero);
      const prev = d.prepare('SELECT MAX(ref) m FROM cc WHERE bin = ?').get(bin);
      const ref = reactivando ? reactivando.ref : ((prev && prev.m ? prev.m : 0) + 1);
      const venc = normalizarVenc(l.mes, l.anio);
      const dias = diasParaVencer(venc.mm, venc.yy);
      const precioNum = l.precio != null ? saldoANumero(l.precio) : null;
      const sugerido = d.prepare('SELECT precio FROM precios WHERE bin = ?').get(bin);
      const infoBin = d.prepare('SELECT marca, banco, pais, pais2, tipo, nivel FROM bininfo WHERE bin = ?').get(bin);
      if (!infoBin) res.binsNuevos.push(bin);

      if (analizar) {
        if (reactivando) {
          res.reactivadas.push({ numero_mask: mask, ref: reactivando.ref, estado: 'REVISION' });
          res.filas.push({ ...baseFila, bin, estado: 'reactivada', motivo: 'BAJA reactivada', ref: reactivando.ref });
        } else {
          res.filas.push({ ...baseFila, bin, estado: 'ok', motivo: null });
          res.nuevas += 1;
        }
        continue;
      }

      let codigo = reactivando && reactivando.codigo ? reactivando.codigo : codigoCorto();
      if (!reactivando || !reactivando.codigo) {
        for (let intento = 0; intento < 5 && d.prepare('SELECT 1 FROM cc WHERE codigo = ?').get(codigo); intento++) codigo = codigoCorto();
      }

      /* El formato bloque trae titular/dni/contacto completos: guardarlos.
       * El formato pipe clásico guarda solo numero/venc/cvv/dni (el resto se
       * deriva al vender). */
      const esBloque = l.formato === 'bloque';
      const vTitular = esBloque ? (l.titular || null) : (nuevoFormato ? null : (l.titular || null));
      const vBanco = nuevoFormato ? null : (l.banco || (infoBin && infoBin.banco) || null);
      const vPrecio = nuevoFormato ? null : (l.precio != null ? String(l.precio) : null);
      const vPrecioNum = nuevoFormato ? null : (precioNum == null ? null : Math.round(precioNum));
      const vPrecioCuotas = nuevoFormato ? null : (l.precio_cuotas != null ? saldoANumero(l.precio_cuotas) : null);
      const vSaldoDisp = l.saldo_disp || l.saldo || null;
      const vSaldoTotal = l.saldo_total || l.saldo_ref || null;
      const vFechaNac = esBloque ? (l.fechaNac || null) : null;
      const vMail = esBloque ? (l.mail || null) : null;
      const vTel = esBloque ? (l.telefono || null) : null;
      const vDir = esBloque ? (l.direccion || null) : null;
      const vCiudad = esBloque ? (l.ciudad || null) : null;
      const vProvincia = esBloque ? (l.provincia || null) : null;
      const vSaldoDispNum = saldoANumero(vSaldoDisp);
      const vSaldoTotalNum = saldoANumero(vSaldoTotal);
      const vSaldo = vSaldoDispNum;
      const vSaldoRef = l.saldo_ref != null ? saldoANumero(l.saldo_ref) : vSaldoTotalNum;
      const vNotas = nuevoFormato ? null : (l.notas || null);
      const vSugerido = nuevoFormato ? null : (sugerido && sugerido.precio != null ? Number(sugerido.precio) : null);

      let id;
      if (reactivando) {
        const upd = d.prepare(
          'UPDATE cc SET numero=?, mes=?, anio=?, cvv=?, bin=?, marca=?, dni=?, titular=?, banco=?, ' +
          'precio=?, precio_num=?, precio_cuotas=?, saldo_disp=?, saldo_total=?, saldo_disp_num=?, saldo_total_num=?, saldo=?, saldo_ref=?, ' +
          'moneda=?, etiqueta=?, lote=?, lote_id=?, notas=?, creado=?, codigo=?, huella=?, numero_mask=?, ' +
          'luhn_ok=1, largo_ok=1, venc_mm=?, venc_yy=?, dias_para_vencer=?, vencida=?, precio_sugerido=?, ' +
          "estado='REVISION', vendido_a=NULL, vendido_el=NULL, codigo_venta=NULL, reservado_por=NULL, " +
          'reservado_hasta=NULL, asignada_en=NULL, verif_estado=\'sin_verificar\', verif_intentos=0, es_test=?, ' +
          'mail=NULL, telefono=NULL, direccion=NULL, ciudad=NULL, provincia=NULL, nro_tramite=NULL, fecha_nac=NULL ' +
          'WHERE id=?'
        );
        upd.run(
          numero, l.mes || venc.mm, l.anio || venc.yy, l.cvv || null, bin,
          (infoBin && infoBin.marca) || marcaDe(numero), baseFila.dni,
          vTitular, vBanco, vPrecio, vPrecioNum, vPrecioCuotas, vSaldoDisp, vSaldoTotal, vSaldoDispNum, vSaldoTotalNum, vSaldo, vSaldoRef,
          opts.moneda || 'CLP', opts.etiqueta || ETIQUETA_DEFECTO, lote, loteId, vNotas, ahora(),
          codigo, huella, mask, venc.mm, venc.yy, dias, dias != null && dias < 0 ? 1 : 0, vSugerido,
          opts.es_test ? 1 : 0, reactivando.id
        );
        id = Number(reactivando.id);
        mov(id, 'REACTIVAR', usuario, chat_id, 'lote=' + lote + ' bin=' + bin + ' ref=' + ref + ' desde BAJA a REVISION');
        res.reactivadas.push({ numero_mask: mask, ref, estado: 'REVISION' });
        res.filas.push({ ...baseFila, bin, estado: 'reactivada', motivo: 'BAJA reactivada', codigo, venc: venc.mm ? venc.mm + '/' + venc.yy : null });
      } else {
        const info = ins.run(
          numero, l.mes || venc.mm, l.anio || venc.yy, l.cvv || null, bin,
          (infoBin && infoBin.marca) || marcaDe(numero),
          baseFila.dni, vTitular, vBanco, vPrecio, vPrecioNum, vSaldoDisp, vSaldoTotal, vSaldoDispNum, vSaldoTotalNum,
          opts.moneda || 'CLP', opts.etiqueta || ETIQUETA_DEFECTO, lote, loteId,
          vNotas, ahora(), ref,
          codigo, huella, mask, 1, 1, venc.mm, venc.yy, dias, dias != null && dias < 0 ? 1 : 0,
          vSugerido, vSaldo, vSaldoRef, vPrecioCuotas, opts.es_test ? 1 : 0
        );
        id = Number(info.lastInsertRowid);
        if (!publicarDirecto) d.prepare("UPDATE cc SET estado='REVISION' WHERE id=?").run(id);
        mov(id, 'CARGA', usuario, chat_id, 'lote=' + lote + ' bin=' + bin + ' ref=' + ref + ' codigo=' + codigo + ' estado=' + (publicarDirecto ? 'DISPONIBLE' : 'REVISION'));
        res.nuevas += 1;
        res.filas.push({ ...baseFila, bin, estado: 'ok', motivo: null, codigo, venc: venc.mm ? venc.mm + '/' + venc.yy : null });
      }
      res.ids.push(id);
      /* El formato bloque trae full datos: persistir titular/contacto. */
      if (esBloque && id) {
        d.prepare('UPDATE cc SET titular=COALESCE(?, titular), dni=COALESCE(?, dni), fecha_nac=COALESCE(?, fecha_nac), ' +
          'mail=COALESCE(?, mail), telefono=COALESCE(?, telefono), direccion=COALESCE(?, direccion), ' +
          'ciudad=COALESCE(?, ciudad), provincia=COALESCE(?, provincia) WHERE id=?')
          .run(l.titular || null, baseFila.dni || null, vFechaNac, vMail, vTel, vDir, vCiudad, vProvincia, id);
      }
    }
    if (!analizar) {
      const exitosas = res.nuevas + res.reactivadas.length;
      const est = res.invalidas.length || res.duplicadas.length ? (exitosas ? 'parcial' : 'sin_nuevas') : 'confirmado';
      d.prepare('UPDATE lotes_cc SET ok=?, duplicadas=?, invalidas=?, estado=? WHERE id=?')
        .run(exitosas, res.duplicadas.length, res.invalidas.length, est, loteId);
      d.exec('COMMIT');
    }
  } catch (e) {
    if (!analizar) { try { d.exec('ROLLBACK'); } catch (_) {} try { d.prepare("UPDATE lotes_cc SET estado='error', meta=? WHERE id=?").run(String(e?.message || e), loteId); } catch (_) {} }
    throw e;
  }
  if (!analizar && publicarDirecto) {
    const bins = new Set(res.binsNuevos);
    if (loteId) for (const f of d.prepare('SELECT DISTINCT bin FROM cc WHERE lote_id=?').all(loteId)) bins.add(f.bin);
    for (const bin of bins) {
      const n = d.prepare("SELECT COUNT(*) n FROM cc WHERE bin=? AND estado='DISPONIBLE' AND COALESCE(eliminado,0)=0").get(bin).n;
      try { notificaciones.avisarStock(bin, n); } catch (_) {}
    }
  }
  res.publicar_directo = publicarDirecto;
  res.estado = publicarDirecto ? 'DISPONIBLE' : 'REVISION';
  res.duplicadas_count = res.duplicadas.length;
  res.reactivadas_count = res.reactivadas.length;
  res.invalidas_count = res.invalidas.length;
  res.binsNuevos = [...new Set(res.binsNuevos)];
  return res;
}

export function listarBin(bin, opts = {}) {
  const d = base();
  const filas = d.prepare("SELECT id, numero, ref, codigo, etiqueta, saldo, saldo_ref, saldo_disp, saldo_total FROM cc WHERE bin = ? AND estado = 'DISPONIBLE' AND COALESCE(eliminado,0) = 0 ORDER BY id").all(String(bin));
  if (!filas.length) return null;
  const etiqueta = opts.etiqueta || filas[0].etiqueta || ETIQUETA_DEFECTO;
  const salida = ['\u{1F4B0} ' + etiqueta + ' BIN ' + bin + ' (' + filas.length + ')', ''];
  const cuentaMascaras = new Map();
  for (const f of filas) cuentaMascaras.set(mascara(f.numero), (cuentaMascaras.get(mascara(f.numero)) || 0) + 1);
  filas.forEach((f, i) => {
    const mask = mascara(f.numero);
    let l = (i + 1) + '> ' + mask;
    if (cuentaMascaras.get(mask) > 1) l += ' (' + (f.ref != null ? f.ref : (f.codigo || '-')) + ')';
    if (opts.refs) l += ' #' + f.ref;
    const saldoBruto = f.saldo != null ? f.saldo : f.saldo_disp;
    const saldoRefBruto = f.saldo_ref != null ? f.saldo_ref : f.saldo_total;
    const s = saldoBruto != null ? precioCorto(saldoBruto) : '';
    const sr = saldoRefBruto != null ? precioCorto(saldoRefBruto) : '';
    if (s) l += ' \u00b7 ' + s + (sr ? '/' + sr : '');
    salida.push(l);
  });
  return salida.join('\n');
}

export async function saldeadas(opts = {}) {
  const { pedidoTexto } = await import('./pedido.js');
  const texto = pedidoTexto({ filtro: 'saldeadas', incluirBorradas: opts.todo === true || opts.todo === '1' }).texto;
  return { texto };
}

export function listado(opts = {}) {
  const bins = base().prepare("SELECT DISTINCT bin FROM cc WHERE estado = 'DISPONIBLE' AND COALESCE(eliminado,0) = 0 ORDER BY bin").all();
  const partes = [];
  for (const b of bins) {
    const t = listarBin(b.bin, opts);
    if (t) partes.push(t);
  }
  return partes.join('\n\n');
}

export function resumen() {
  return base().prepare("SELECT bin, MAX(etiqueta) etiqueta, SUM(CASE WHEN estado = 'DISPONIBLE' AND COALESCE(eliminado,0) = 0 THEN 1 ELSE 0 END) disp, SUM(CASE WHEN estado = 'RESERVADA' THEN 1 ELSE 0 END) res, SUM(CASE WHEN estado = 'VENDIDA' THEN 1 ELSE 0 END) vend, SUM(CASE WHEN estado = 'BAJA' THEN 1 ELSE 0 END) baja, SUM(CASE WHEN estado = 'DISPONIBLE' AND COALESCE(eliminado,0) = 0 THEN COALESCE(saldo_total_num, 0) ELSE 0 END) saldo FROM cc GROUP BY bin ORDER BY bin").all();
}

export function buscar(ref) {
  const d = base();
  const s = String(ref === null || ref === undefined ? '' : ref).trim();
  if (!s) return [];
  const solo = soloDigitos(s);
  if (solo && solo.length <= 8) {
    /* Exacto primero: un ref no debe confundirse con un pedazo del PAN. */
    const exacto = d.prepare('SELECT * FROM cc WHERE numero = ?').all(solo);
    if (exacto.length) return exacto;
    const porRef = d.prepare('SELECT * FROM cc WHERE ref = ?').all(Number(solo));
    if (porRef.length) return porRef;
    const porNumero = d.prepare('SELECT * FROM cc WHERE numero LIKE ?').all('%' + solo + '%');
    if (porNumero.length) return porNumero;
  }
  return d.prepare('SELECT * FROM cc WHERE numero LIKE ?').all('%' + solo + '%');
}

/** Bloque completo de una CC (formato TARJETA #… DATOS TITULAR / DATOS TARJETA). */
export function bloqueDe(cc, n) {
  if (!cc) return null;
  const titular = {
    titular: cc.titular, dni: cc.dni, fechaNac: cc.fecha_nac, nroTramite: cc.nro_tramite,
    mail: cc.mail, telefono: cc.telefono, direccion: cc.direccion, ciudad: cc.ciudad, provincia: cc.provincia,
  };
  const saldoNum = cc.saldo != null ? Number(cc.saldo) : (cc.saldo_disp_num != null ? Number(cc.saldo_disp_num) : null);
  const saldoRefNum = cc.saldo_ref != null ? Number(cc.saldo_ref) : (cc.saldo_total_num != null ? Number(cc.saldo_total_num) : null);
  const tarjeta = {
    numero: cc.numero, mes: cc.mes, anio: cc.anio, cvv: cc.cvv,
    saldo: saldoNum != null && Number.isFinite(saldoNum) ? precioCorto(saldoNum) : (cc.saldo_disp || null),
    saldoRef: saldoRefNum != null && Number.isFinite(saldoRefNum) ? precioCorto(saldoRefNum) : (cc.saldo_total || null),
  };
  return armarBloque(titular, tarjeta, n);
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
    return d.prepare("SELECT * FROM cc WHERE bin = ? AND estado = 'DISPONIBLE' AND COALESCE(eliminado,0) = 0 ORDER BY " + orden + ' LIMIT ?').all(String(opts.bin), cant);
  }
  return d.prepare("SELECT * FROM cc WHERE estado = 'DISPONIBLE' AND COALESCE(eliminado,0) = 0 ORDER BY " + orden + ' LIMIT ?').all(cant);
}

function proximoCodigo() {
  const n = base().prepare('SELECT COUNT(DISTINCT codigo_venta) c FROM cc WHERE codigo_venta IS NOT NULL').get().c;
  const f = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return 'V-' + f + '-' + String(n + 1).padStart(3, '0');
}

export function vender(opts = {}) {
  const d = base();
  const ccs = opts.refs && opts.refs.length ? opts.refs.flatMap((r) => buscar(r)) : candidatos(opts);
  const libres = ccs.filter((c) => (c.estado === 'DISPONIBLE' || c.estado === 'RESERVADA') && !Number(c.eliminado));
  if (!libres.length) return { codigo: null, ccs: [] };
  const codigo = opts.codigo || proximoCodigo();
  /* VENDEDOR_GANA_CARRERA=1 (default): no vender una tarjeta reservada por el
   * catalogo web. Con 0, el admin/bot puede venderla; la reserva vence y se
   * devuelve el saldo, sin tocar el stock ya vendido. */
  const protegeVendedor = String(process.env.VENDEDOR_GANA_CARRERA ?? '1') === '1';
  /* Una RESERVADA viva la protege el vendedor. La reserva del catálogo web
   * usa reservado_hasta; la del bot usa reserva_vence. Si alguna venció, el
   * admin/bot puede venderla. */
  /* protegido=1 (default): una RESERVADA viva la protege el vendedor; si
   * venció, se puede vender. protegido=0: se puede vender igual. La reserva
   * del catálogo web usa reservado_hasta; la del bot usa reserva_vence. */
  const protegido = protegeVendedor ? 1 : 0;
  const condicionVenta = "(estado = 'DISPONIBLE' OR (estado = 'RESERVADA' AND (? = 0 OR COALESCE(reservado_hasta, reserva_vence) IS NULL OR COALESCE(reservado_hasta, reserva_vence) < ?)))";
  const upd = d.prepare("UPDATE cc SET estado = 'VENDIDA', vendido_a = ?, vendido_el = ?, codigo_venta = ? WHERE id = ? AND " + condicionVenta);
  const hechas = [];
  for (const c of libres) {
    const r = upd.run(opts.comprador || null, ahora(), codigo, c.id, protegido, ahora());
    if (r.changes) {
      mov(c.id, 'VENTA', opts.usuario, opts.chat_id, 'codigo=' + codigo + (opts.comprador ? ' comprador=' + opts.comprador : ''));
      hechas.push(Object.assign({}, c, { estado: 'VENDIDA', codigo_venta: codigo }));
    }
  }
  return { codigo: hechas.length ? codigo : null, ccs: hechas };
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

/** Cliente se queja: saca la CC de la venta y la manda a REVISION manual. */
export function revisar(refs, usuario, chat_id) {
  const d = base();
  const hechas = [];
  for (const r of refs) {
    for (const c of buscar(r)) {
      if (c.estado === 'REVISION') continue;
      d.prepare("UPDATE cc SET estado='REVISION', vendido_a=NULL, vendido_el=NULL, codigo_venta=NULL, " +
        "reservado_por=NULL, reservado_hasta=NULL WHERE id=?").run(c.id);
      mov(c.id, 'REVISAR', usuario, chat_id, 'desde ' + c.estado + (c.codigo_venta ? ' codigo=' + c.codigo_venta : ''));
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
/** Publica tarjetas cargadas en REVISION (PUBLICAR_DIRECTO=0). */
export function publicar(refs, usuario, chat_id) {
  const d = base();
  const hechas = [];
  const bins = new Set();
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const r of refs) {
      for (const c of buscar(r)) {
        if (c.estado !== 'REVISION') continue;
        const up = d.prepare("UPDATE cc SET estado='DISPONIBLE' WHERE id=? AND estado='REVISION'").run(c.id);
        if (!up.changes) continue;
        mov(c.id, 'PUBLICAR', usuario, chat_id, 'ref=' + c.ref);
        hechas.push(c.ref);
        if (c.bin) bins.add(c.bin);
      }
    }
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
  for (const bin of bins) {
    const n = d.prepare("SELECT COUNT(*) n FROM cc WHERE bin=? AND estado='DISPONIBLE'").get(bin).n;
    try { notificaciones.avisarStock(bin, n); } catch (_) {}
  }
  return hechas;
}

export function setSaldo(ref, disp, total, usuario, chat_id) {
  const d = base();
  const c = buscar(ref)[0];
  if (!c) return null;
  const dn = disp === null || disp === undefined || disp === '' ? null : saldoANumero(disp);
  const tn = total === null || total === undefined || total === '' ? dn : saldoANumero(total);
  d.prepare('UPDATE cc SET saldo_disp=?, saldo_total=?, saldo_disp_num=?, saldo_total_num=?, saldo=?, saldo_ref=?, saldo_fecha=? WHERE id=?').run(dn === null ? null : String(dn), tn === null ? null : String(tn), dn, tn, dn, tn, ahora(), c.id);
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

/** CC por id exacto. */
export function porId(id) {
  return base().prepare('SELECT * FROM cc WHERE id = ?').get(Number(id)) || null;
}

/** Última CC vendida desde un chat (para /revisar sin N dentro de la ventana). */
export function ultimaVenta(chatId, minutos = 5) {
  const desde = new Date(Date.now() - Math.max(1, Number(minutos) || 5) * 60000).toISOString();
  const m = base().prepare(
    "SELECT c.* FROM movs m JOIN cc c ON c.id = m.cc_id " +
    "WHERE m.accion='VENTA' AND m.chat_id = ? AND m.fecha >= ? AND c.estado='VENDIDA' " +
    "ORDER BY m.id DESC LIMIT 1"
  ).get(String(chatId), desde);
  return m || null;
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

/** Titular AFIP por DNI (sin congelarlo en la tarjeta). */
export function titularPorDni(dni) {
  const d = soloDigitos(dni);
  if (!d) return null;
  try {
    return abrirPadron().prepare(
      'SELECT dni, apellido, nombre FROM personas WHERE dni = ? ORDER BY cuit LIMIT 1'
    ).get(d) || null;
  } catch (_) {
    return null;
  }
}

function comparableNombre(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function mismoTitular(a, b) {
  const x = comparableNombre(a);
  const y = comparableNombre(b);
  if (!x || !y) return null;
  if (x === y) return true;
  const sx = new Set(x.split(' '));
  const sy = new Set(y.split(' '));
  return sx.size === sy.size && [...sx].every((t) => sy.has(t));
}

/** Titular derivado desde DNI (padrón/AFIP + generador), sin persistirlo. */
function derivarTitular(dni) {
  const d = soloDigitos(dni);
  if (!d) return null;
  const p = titularPorDni(d) || {};
  const real = persona.real(d) || {};
  /* El padrón (apellido/nombre de personas) manda sobre un `nombre` completo
   * que pueda traer otra fuente. Mismo orden que /lote: real, luego padrón. */
  const t = normalizarTitular({ ...real, ...p, dni: d });
  return t.titular && t.titular !== '-' ? t.titular : null;
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
  return ccs.map((c, i) => {
    /* DNI como llave: si la tarjeta solo guarda DNI, el titular se resuelve
     * contra el padrón y el resto se deriva en este momento. */
    const base = {
      ...persona.real(c.dni),
      ...(titularPorDni(c.dni) || {}),
      dni: c.dni,
      titular: c.titular || undefined,
      mail: c.mail || undefined,
      telefono: c.telefono || undefined,
      direccion: c.direccion || undefined,
      ciudad: c.ciudad || undefined,
      provincia: c.provincia || undefined,
    };
    return armarBloque(tit[i] || base, { numero: c.numero, mes: c.mes, anio: c.anio, cvv: c.cvv }, desde + i);
  }).join(SEPARADOR);
}

export function entrega(opts = {}) {
  const r = vender(opts);
  if (!r.codigo) return { codigo: null, ccs: [], texto: '' };
  asignarTitulares(r.ccs); const titulares = opts.titulares || (opts.conTitulares === false ? [] : []);
  const texto = textoEntrega(r.ccs, { formato: opts.formato, desde: opts.desde, titulares });
  mov(r.ccs[0].id, 'ENTREGA', opts.usuario, opts.chat_id, 'codigo=' + r.codigo + ' n=' + r.ccs.length);
  return { codigo: r.codigo, ccs: r.ccs, texto };
}

export function reentrega(codigo, opts = {}) {
  const ccs = porCodigo(codigo); asignarTitulares(ccs);
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

/** Asigna y PERSISTE un titular real del padron a cada CC sin titular. */
export function asignarTitulares(ccs) {
  const d = base();
  const upd = d.prepare('UPDATE cc SET dni=?, titular=?, nro_tramite=?, fecha_nac=?, mail=?, telefono=?, direccion=?, ciudad=?, provincia=? WHERE id=?');
  let n = 0;
  for (const c of ccs) {
    if (c.dni) continue;
    const p = titularesPara(1, c.id % 5000000)[0] || titularesPara(1, 0)[0];
    if (!p) continue;
    const t = normalizarTitular({ ...persona.real(p.dni), dni: p.dni, apellido: p.apellido, nombre: p.nombre });
    upd.run(t.dni, t.titular, t.nroTramite, t.fechaNac, t.mail, t.telefono, t.direccion, t.ciudad, t.provincia, c.id);
    c.dni = t.dni; c.titular = t.titular; c.nro_tramite = t.nroTramite; c.fecha_nac = t.fechaNac;
    c.mail = t.mail; c.telefono = t.telefono; c.direccion = t.direccion; c.ciudad = t.ciudad; c.provincia = t.provincia;
    n += 1;
  }
  return n;
}
