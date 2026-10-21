/* lote.js — armado de bloques de titulares y tarjetas.
 *
 * Un bloque completo tiene la forma:
 *
 *   TARJETA #<n>
 *   DATOS TITULAR
 *   TITULAR <APELLIDO> <Nombre Apellido>
 *   ...
 *   PAIS Argentina
 *
 *   DATOS TARJETA
 *   CC <numero>
 *   VENCIMIENTO <MM>/<YY>
 *   CODIGO <cvv>
 *
 * Los datos que no vienen en el titular se completan con lib/faker-extra.js
 * (deterministas por DNI). Si aun asi no se pueden calcular, se imprime "-".
 *
 * Los titulares se seleccionan desde `personas` con la columna `orden` (hash
 * estable precalculado por scripts/ordenar.js) y LIMIT/OFFSET. No hay estado
 * en el servidor y la consulta usa el indice idx_personas_orden.
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generarExtra } from './faker-extra.js';

const DASH = '-';
const RUTA_DB = process.env.RESOLVER_DB || path.join(import.meta.dirname, '..', 'datos', 'padron.db');

/* Hash estable de 32 bits con semilla fija (LCG + mezcla). Lo usa
 * scripts/ordenar.js para llenar `personas.orden` UNA sola vez. No cambiar:
 * cambiarlo cambia el orden de los lotes. */
const SEMILLA = 12345;
export const HASH_DNI =
  `((((CAST(dni AS INTEGER) * 1103515245 + ${SEMILLA}) & 2147483647) * 1664525 + 1013904223) & 2147483647)`;

/* Solo las columnas que necesita el armado del bloque. */
const SQL_TITULARES = `
  SELECT dni, apellido, nombre
  FROM personas
  ORDER BY orden
  LIMIT ? OFFSET ?`;

let dbPorDefecto = null;

function abrirDb(ruta = RUTA_DB) {
  if (ruta === RUTA_DB) {
    if (!dbPorDefecto) {
      dbPorDefecto = new DatabaseSync(ruta);
      dbPorDefecto.exec('PRAGMA busy_timeout = 5000');
    }
    return dbPorDefecto;
  }
  const db = new DatabaseSync(ruta);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function entero(valor, porDefecto) {
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) ? n : porDefecto;
}

function texto(valor) {
  if (valor === null || valor === undefined) return null;
  const s = String(valor).trim();
  return s === '' || s === DASH ? null : s;
}

function primero(...valores) {
  for (const v of valores) {
    const s = texto(v);
    if (s !== null) return s;
  }
  return null;
}

function decodificar(valor) {
  let out = String(valor ?? '');
  for (let i = 0; i < 2; i++) {
    if (!/%[0-9a-f]{2}/i.test(out)) break;
    try { out = decodeURIComponent(out); } catch (_) { break; }
  }
  return out
    .replace(/%7C/gi, '|')
    .replace(/%2C/gi, ',')
    .replace(/%3B/gi, ';');
}

function dosDigitos(valor) {
  const d = String(valor ?? '').replace(/\D/g, '');
  return d ? d.padStart(2, '0').slice(-2) : '';
}

function dniFmt(valor) {
  let d = String(valor ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11) d = d.slice(2, 10);
  else if (d.length > 8) d = d.slice(-8);
  else d = d.padStart(8, '0');
  return /^\d{8}$/.test(d) ? d : null;
}

function tramiteFmt(valor) {
  let d = String(valor ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length > 11) d = d.slice(-11);
  return d.padStart(11, '0');
}

function fechaFmt(valor) {
  if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
    const dd = String(valor.getUTCDate()).padStart(2, '0');
    const mm = String(valor.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${valor.getUTCFullYear()}`;
  }
  const s = texto(valor);
  if (!s) return null;

  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return `${dosDigitos(m[3])}/${dosDigitos(m[2])}/${m[1]}`;

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return `${dosDigitos(m[1])}/${dosDigitos(m[2])}/${m[3]}`;

  return null;
}

function vencimientoFmt(mes, anio, vencimiento) {
  const par = (mm, yy) => {
    const m = Number(String(mm).replace(/\D/g, ''));
    const a = String(yy ?? '').replace(/\D/g, '');
    if (!(m >= 1 && m <= 12) || a.length < 2) return null;
    return `${dosDigitos(m)}/${a.slice(-2)}`;
  };

  const v = texto(vencimiento);
  if (v) {
    let m = v.match(/^(\d{1,2})\s*[\/\-.]\s*(\d{2,4})$/);
    if (m) {
      const r = par(m[1], m[2]);
      if (r) return r;
    }
    m = v.match(/^(\d{1,2})(\d{2})$/);
    if (m) {
      const r = par(m[1], m[2]);
      if (r) return r;
    }
  }

  const mm = texto(mes);
  const yy = texto(anio);
  if (mm && yy) {
    const r = par(mm, yy);
    if (r) return r;
  }
  return DASH;
}

function numeroTarjetaFmt(valor) {
  const s = texto(valor);
  if (!s) return DASH;
  const limpio = s.replace(/[\s-]+/g, '');
  return limpio || DASH;
}

function codigoFmt(valor) {
  const d = String(valor ?? '').replace(/\D/g, '');
  return d || DASH;
}

function telefonoFmt(area, numero, bruto) {
  const a = String(area ?? '').replace(/\D/g, '');
  const n = String(numero ?? '').replace(/\D/g, '');
  if (a && n) return `${a} ${n}`;

  const s = texto(bruto);
  if (!s) return null;
  const m = s.match(/^(\d{1,4})\s+(.+)$/);
  if (m) {
    const resto = m[2].replace(/\D/g, '');
    return resto ? `${m[1]} ${resto}` : m[1];
  }
  const d = s.replace(/\D/g, '');
  return d || null;
}

function direccionFmt(valor) {
  const s = String(valor ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!s) return null;
  return /\d+\s*$/.test(s) ? s : s + ' 0';
}

function mayusculas(valor) {
  const s = texto(valor);
  return s ? s.replace(/\s+/g, ' ').toUpperCase() : null;
}

function titularFmt(t, apellido, nombre) {
  const bruto = primero(t.titular, t.TITULAR);
  if (bruto) return bruto.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

  const a = texto(apellido);
  const n = texto(nombre);
  if (!a && !n) return null;
  return [a ? a.toUpperCase() : '', n || '']
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Parsea un campo de tarjeta. Acepta:
 *   cc|mm|yy|cvv        (formato principal)
 *   cc|vencimiento|cvv  (vencimiento = MM/YY, MM-YY, MMYY)
 *   cc|mm|yy            (sin codigo)
 * Campos vacios se conservan como ausentes. */
function parsearTarjeta(bruto) {
  let s = decodificar(bruto).trim();
  if (!s) return {};

  let partes = s.split('|').map((p) => p.trim());
  if (partes.length === 1) {
    const tokens = s.split(/\s+/);
    if (tokens.length >= 3) partes = tokens;
  }

  const numero = partes[0] ?? '';
  let mes = '';
  let anio = '';
  let vencimiento = '';
  let codigo = '';

  if (partes.length >= 4) {
    mes = partes[1] ?? '';
    anio = partes[2] ?? '';
    codigo = partes[3] ?? '';

    /* Tolerar "cc|11/25||575": el vencimiento viene entero en el segundo campo. */
    if (/[\/\-.]/.test(mes) || /^\d{4}$/.test(mes)) {
      vencimiento = mes;
      mes = '';
      anio = '';
      if (!codigo) codigo = partes[2] ?? '';
    }
  } else if (partes.length === 3) {
    const p1 = partes[1] ?? '';
    const p2 = partes[2] ?? '';
    if (/[\/\-.]/.test(p1) || /^\d{4}$/.test(p1)) {
      vencimiento = p1;
      codigo = p2;
    } else if (/^\d{1,2}$/.test(p1) && /^\d{2,4}$/.test(p2)) {
      mes = p1;
      anio = p2;
    } else {
      vencimiento = p1;
      codigo = p2;
    }
  } else if (partes.length === 2) {
    const p1 = partes[1] ?? '';
    if (/[\/\-.]/.test(p1) || /^\d{4}$/.test(p1)) vencimiento = p1;
    else codigo = p1;
  }

  return { numero, mes, anio, vencimiento, codigo };
}

function normalizarTarjeta(tarjeta) {
  const t = typeof tarjeta === 'string' ? parsearTarjeta(tarjeta) : (tarjeta || {});
  return {
    numero: numeroTarjetaFmt(primero(t.cc, t.numero, t.numeroTarjeta, t.pan, t.tarjeta, t.nro, t.cardNumber)),
    vencimiento: vencimientoFmt(
      primero(t.mes, t.mm, t.month),
      primero(t.anio, t.año, t.anioVencimiento, t.yy, t.year),
      primero(t.vencimiento, t.venc, t.exp, t.expiry, t.fechaVencimiento)
    ),
    codigo: codigoFmt(primero(t.codigo, t.cvv, t.cvc, t.cod, t.securityCode, t.codigoSeguridad)),
  };
}

function normalizarTitular(titular) {
  const t = titular && typeof titular === 'object' ? titular : {};
  const dni = dniFmt(primero(t.dni, t.DNI, t.documento, t.nroDni, t.nroDocumento));
  const apellido = primero(t.apellido, t.APELLIDO, t.apellidos);
  const nombre = primero(t.nombre, t.NOMBRE, t.nombres);
  const extra = dni ? generarExtra(dni, { nombre, apellido }) : {};

  const nroTramite = tramiteFmt(primero(t.nroTramite, t.nro_tramite, t.tramite, t.tramiteNro, extra.nroTramite));
  const fechaNac = fechaFmt(primero(t.fechaNac, t.fechaNacimiento, t.nacimiento, extra.fechaNac));
  const mail = primero(t.mail, t.email, t.correo, extra.mail);

  const area = primero(t.area, t.codigoArea, t.areaTelefono);
  const numero = primero(t.numero, t.numeroTelefono, t.telefonoNumero);
  const telBruto = primero(t.telefono, t.TELEFONO, t.celular);
  let telefono = null;
  if (area && numero) telefono = telefonoFmt(area, numero);
  else if (telBruto) telefono = telefonoFmt(null, null, telBruto);
  else if (extra.area && extra.numero) telefono = telefonoFmt(extra.area, extra.numero);
  else if (extra.telefono) telefono = telefonoFmt(null, null, extra.telefono);

  const calle = primero(t.calle, t.calleNombre);
  const altura = primero(t.altura, t.numeroCalle, t.numeroDireccion);
  let direccion = primero(t.direccion, t.domicilio, t.DIRECCION);
  if (!direccion && calle) direccion = [calle, altura].filter(Boolean).join(' ');
  if (!direccion) direccion = extra.direccion;

  return {
    titular: titularFmt(t, apellido, nombre) || DASH,
    dni: dni || DASH,
    nroTramite: nroTramite || DASH,
    fechaNac: fechaNac || DASH,
    mail: mail || DASH,
    telefono: telefono || DASH,
    direccion: direccionFmt(direccion) || DASH,
    ciudad: mayusculas(primero(t.ciudad, t.localidad, t.CIUDAD, extra.ciudad)) || DASH,
    provincia: mayusculas(primero(t.provincia, t.PROVINCIA, t.estado, extra.provincia)) || DASH,
  };
}

/**
 * Arma un bloque. Si `tarjeta` es null/undefined devuelve solo DATOS TITULAR.
 * @param {object} titular
 * @param {object|string|null} tarjeta
 * @param {number|null} n
 * @returns {string}
 */
export function armarBloque(titular, tarjeta, n) {
  const t = normalizarTitular(titular);
  const lineas = [
    'DATOS TITULAR',
    `TITULAR ${t.titular}`,
    `DNI ${t.dni}`,
    `NRO TRAMITE ${t.nroTramite}`,
    `FECHA NAC ${t.fechaNac}`,
    `MAIL ${t.mail}`,
    `TELEFONO ${t.telefono}`,
    `DIRECCION ${t.direccion}`,
    `CIUDAD ${t.ciudad}`,
    `PROVINCIA ${t.provincia}`,
    'PAIS Argentina',
  ];

  if (tarjeta === null || tarjeta === undefined) return lineas.join('\n');

  const c = normalizarTarjeta(tarjeta);
  return [
    `TARJETA #${n ?? DASH}`,
    ...lineas,
    '',
    'DATOS TARJETA',
    `CC ${c.numero}`,
    `VENCIMIENTO ${c.vencimiento}`,
    `CODIGO ${c.codigo}`,
  ].join('\n');
}

/**
 * Convierte el parametro `cards` en una lista de tarjetas.
 * Acepta un string (separadores , o ;) o un array de strings/objetos.
 * Tolera %7C, %2C, %3B, espacios y campos vacios.
 * @returns {Array<object>}
 */
export function parsearCards(entrada) {
  const salida = [];

  const agregar = (valor) => {
    if (valor === null || valor === undefined) return;
    if (Array.isArray(valor)) {
      valor.forEach(agregar);
      return;
    }
    if (typeof valor === 'object') {
      salida.push(valor);
      return;
    }
    const partes = decodificar(String(valor)).split(/[;,\n]/);
    for (const p of partes) {
      const t = p.trim();
      if (t) salida.push(parsearTarjeta(t));
    }
  };

  agregar(entrada);
  return salida;
}

/**
 * Selecciona titulares del padron con orden estable y paginacion.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{cantidad?:number, n?:number, saltar?:number}} [opts]
 * @returns {Array<{dni:string, apellido:string, nombre:string}>}
 */
export function seleccionarTitulares(db, opts = {}) {
  const cantidad = Math.max(0, entero(opts.cantidad ?? opts.n, 10));
  const saltar = Math.max(0, entero(opts.saltar, 0));
  if (!cantidad) return [];

  const base = db || abrirDb();
  return base
    .prepare(SQL_TITULARES)
    .all(cantidad, saltar)
    .map((f) => ({ dni: f.dni, apellido: f.apellido, nombre: f.nombre }));
}

/**
 * Genera el texto completo de un lote. Una tarjeta por bloque.
 * @param {string|Array} cards tarjetas crudas o ya parseadas
 * @param {{desde?:number, saltar?:number, titulares?:Array, db?:DatabaseSync, rutaDb?:string}} [opts]
 * @returns {string}
 */
export function generarLote(cards, opts = {}) {
  const lista = parsearCards(cards);
  if (!lista.length) return '';

  const desde = entero(opts.desde, 1);
  let titulares = Array.isArray(opts.titulares) ? opts.titulares : null;

  if (!titulares) {
    const db = opts.db || abrirDb(opts.rutaDb);
    titulares = seleccionarTitulares(db, {
      cantidad: lista.length,
      saltar: entero(opts.saltar, 0),
    });
  }

  return lista
    .map((tarjeta, i) => armarBloque(titulares[i] || {}, tarjeta, desde + i))
    .join('\n\n');
}
