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
 *   VENCIMIENTO <MM>/<AAAA>
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
import { generarExtra, provinciaDeCiudad } from './faker-extra.js';
import { formatearTelefono } from './faker-ar.js';
import { sinteticoNacimiento, mostrarTramitePendiente, PENDIENTE } from './config.js';
import * as persona from './persona.js';
import { parsearTarjetas } from './parse-tarjetas.js';

const DASH = '-';
export const SEPARADOR = String.fromCharCode(10, 10) + '='.repeat(50) + String.fromCharCode(10, 10);
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

/* CUIL real del padron (columna cuit). Local y con cache en memoria. */
const cuits = new Map();
let stCuit = null;
function cuitDePadron(dni) {
  if (!dni) return null;
  if (cuits.has(dni)) return cuits.get(dni);
  let v = null;
  try {
    if (!stCuit) stCuit = abrirDb().prepare("SELECT cuit FROM personas WHERE dni = ? LIMIT 1");
    const f = stCuit.get(dni);
    v = f && f.cuit ? String(f.cuit) : null;
  } catch (_) { v = null; }
  cuits.set(dni, v);
  return v;
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
  /* Vencimiento siempre en MM/AAAA. */
  const par = (mm, yy) => {
    const m = Number(String(mm).replace(/\D/g, ""));
    let a = String(yy ?? "").replace(/\D/g, "");
    if (a.length === 2) a = "20" + a;
    if (!(m >= 1 && m <= 12) || a.length !== 4) return null;
    return dosDigitos(m) + "/" + a;
  };

  const v = texto(vencimiento);
  if (v) {
    let m = v.match(/^(\d{1,2})\s*[\/\-.]\s*(\d{2,4})$/);
    if (m) { const r = par(m[1], m[2]); if (r) return r; }
    m = v.match(/^(\d{1,2})(\d{2,4})$/);
    if (m) { const r = par(m[1], m[2]); if (r) return r; }
  }

  const mm = texto(mes);
  const yy = texto(anio);
  if (mm && yy) { const r = par(mm, yy); if (r) return r; }
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

  return formatearTelefono(texto(bruto));
}

function direccionFmt(valor) {
  /* No agregar " 0": un campo vacio no debe dejar un cero colgado. */
  const s = String(valor ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  return s || null;
}

function mayusculas(valor) {
  const s = texto(valor);
  return s ? s.replace(/\s+/g, ' ').toUpperCase() : null;
}

/* Particulas que no se capitalizan dentro de un nombre. */
const PART = new Set(["de","del","la","las","los","y","da","das","do","dos","van","von","san","santa","di","du","le"]);

/* Devuelve el nombre capitalizado (HERNAN CESAR -> Hernan Cesar). */
function cap(valor) {
  const x = texto(valor);
  if (!x) return null;
  return x.toLowerCase().replace(/\s /g, " ").split(" ").map((w, i) => (w && !(i > 0 && PART.has(w)) ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}
function titularFmt(t, apellido, nombre) {
  const bruto = primero(t.titular, t.TITULAR);
  if (bruto) {
    const limpio = bruto.replace(/,/g, " ").replace(/\s /g, " ").trim();
    if (limpio && limpio === limpio.toUpperCase()) {
      const partes = limpio.split(" ");
      const ape = [partes.shift()];
      while (partes.length > 1 && PART.has(partes[0].toLowerCase())) ape.push(partes.shift());
      const nom = cap(partes.join(" "));
      return (ape.join(" ") + (nom ? " " + nom : "")).trim();
    }
    return limpio;
  }

  const a = texto(apellido);
  const n = cap(nombre);
  if (!a && !n) return null;
  return [a ? a.toUpperCase() : "", n || ""].filter(Boolean).join(" ").replace(/\s /g, " ").trim();
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

function saldosDe(b){var s=String(b==null?"":b);var tk=s.split(/[|;,\t\s/-:=#]+/).filter(Boolean);var out=[];for(var i=0;i<tk.length;i++){var x=tk[i];if(!/^\d+$/.test(x))continue;if(x.length<4)continue;if(/^(?:19|20)\d{2}$/.test(x))continue;out.push(Number(x));}return out;}
function normalizarTarjeta(tarjeta) {
  const t = typeof tarjeta === 'string' ? parsearTarjeta(tarjeta) : (tarjeta || {});
  const esTexto = typeof tarjeta === 'string';
  const saldoTxt = esTexto ? saldosDe(tarjeta)[0] : primero(t.saldo, t.saldoDisp, t.disponible);
  const saldoRefTxt = esTexto ? saldosDe(tarjeta)[1] : primero(t.saldoRef, t.saldoRefTxt, t.saldoTotal, t.total);
  return {
    numero: numeroTarjetaFmt(primero(t.cc, t.numero, t.numeroTarjeta, t.pan, t.tarjeta, t.nro, t.cardNumber)),
    vencimiento: vencimientoFmt(
      primero(t.mes, t.mm, t.month),
      primero(t.anio, t.año, t.anioVencimiento, t.yy, t.year),
      primero(t.vencimiento, t.venc, t.exp, t.expiry, t.fechaVencimiento)
    ),
    codigo: codigoFmt(primero(t.codigo, t.cvv, t.cvc, t.cod, t.securityCode, t.codigoSeguridad)),
    saldo: saldoTxt || null,
    saldoRef: saldoRefTxt || null,
  };
}

export function normalizarTitular(titular) {
  const t0 = titular && typeof titular === 'object' ? titular : {};
  const dni = dniFmt(primero(t0.dni, t0.DNI, t0.documento, t0.nroDni, t0.nroDocumento));
  /* Completar con datos reales cacheados (RENAPER/CNE/publicas) sin pisar
   * lo que venga provisto. Asi el lote no inventa nacimiento/tramite. */
  let t = t0;
  if (dni && dni !== DASH) {
    try {
      const real = persona.real(dni);
      if (!t0.nombre && !real.nombre && real.nombres) real.nombre = real.nombres;
      t = { ...real, ...t0 };
    } catch (_) {}
  }
  const apellido = primero(t.apellido, t.APELLIDO, t.apellidos);
  const nombre = primero(t.nombre, t.NOMBRE, t.nombres);
  
  // Si hay un área telefónica en los datos crudos, pasársela a generarExtra
  const extraOpts = { nombre, apellido };
  const area = primero(t.area, t.codigoArea, t.areaTelefono);
  if (area) {
    extraOpts.area = area;
  }
  const extra = dni ? generarExtra(dni, extraOpts) : {};

  const permiteSintetico = sinteticoNacimiento();
  /* El tramite del padron/RENAPER manda. Si no esta (o el lote lo trae como
   * "(pendiente)"), se deriva del DNI: determinista, mismo DNI = mismo tramite.
   * Asi la entrega sale con el NRO TRAMITE siempre, como la referencia. */
  const nroTramite = tramiteFmt(primero(t.nroTramite, t.nro_tramite, t.tramite, t.tramiteNro)) || tramiteFmt(extra.nroTramite);
  const fechaNac = fechaFmt(primero(t.fechaNac, t.fechaNacimiento, t.nacimiento, permiteSintetico ? extra.fechaNac : null));
  const mail = primero(t.mail, t.email, t.correo, extra.mail);

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

  /* Coherencia: la provincia se deriva de la ciudad cuando la ciudad es
   * conocida. Asi no se mezcla una ciudad sintetica con una provincia real
   * distinta (CORDOBA + ESCOBAR, CORDOBA + VILLA GOBERNADOR GALVEZ). */
  const ciudadFinal = mayusculas(primero(t.ciudad, t.localidad, t.CIUDAD, extra.ciudad)) || null;
  let provinciaFinal = mayusculas(primero(t.provincia, t.PROVINCIA, t.estado)) || null;
  const provinciaDerivada = ciudadFinal ? provinciaDeCiudad(ciudadFinal, provinciaFinal) : null;
  if (provinciaDerivada) provinciaFinal = mayusculas(provinciaDerivada);
  else if (!provinciaFinal) provinciaFinal = mayusculas(extra.provincia) || null;

  return {
    titular: titularFmt(t, apellido, nombre) || DASH,
    dni: dni || DASH,
    nroTramite: nroTramite || PENDIENTE,
    fechaNac: fechaNac || PENDIENTE,
    mail: mail || DASH,
    telefono: telefono || DASH,
    direccion: direccionFmt(direccion) || DASH,
    ciudad: ciudadFinal || DASH,
    provincia: provinciaFinal || DASH,
    cuit: String(primero(t.cuit, t.cuil, t.CUIT, t.CUIL, cuitDePadron(dni)) || '').replace(/\D/g, '') || null,
    cpostal: primero(t.cpostal, t.cp, t.codigoPostal, t.CPOSTAL, extra.cpostal) || null,
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
  ];
  /* En venta no se imprime el tramite pendiente si el flag esta en 0. */
  if (t.nroTramite !== PENDIENTE || mostrarTramitePendiente()) {
    lineas.push(`NRO TRAMITE ${t.nroTramite}`);
  }
  lineas.push(
    `FECHA NAC ${t.fechaNac}`,
    `MAIL ${t.mail}`,
    `TELEFONO ${t.telefono}`,
    `DIRECCION ${t.direccion}`,
    `CIUDAD ${t.ciudad}`,
    `PROVINCIA ${t.provincia}`
  );
  if (t.cpostal) lineas.push(`CP ${t.cpostal}`);
  /* CUIL real del padron: local, gratis y al instante. */
  if (t.cuit) lineas.push(`CUIL ${t.cuit}`);
  lineas.push('PAIS Argentina');

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
    ...(c.saldo == null ? [] : [`SALDO ${c.saldo}${c.saldoRef == null ? "" : "/" + c.saldoRef}`]),
  ].join('\n');
}

/**
 * Convierte el parametro `cards` en una lista de tarjetas.
 * Acepta un string (separadores , o ;) o un array de strings/objetos.
 * Tolera %7C, %2C, %3B, espacios y campos vacios.
 * @returns {Array<object>}
 */
export function parsearCards(entrada) {
  return parsearTarjetas(entrada).tarjetas;
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
    .join(SEPARADOR);
}

/**
 * Genera un lote grande por paginas de 100 titulares. Cada pagina llama a
 * generarLote con `saltar` incremental (0, 100, 200, ...) y `desde` corrido,
 * de modo que no se repiten titulares y la numeracion sigue siendo continua.
 * @param {string|Array} cards
 * @param {{desde?:number, saltar?:number, pagina?:number, db?:DatabaseSync, rutaDb?:string, titulares?:Array}} [opts]
 * @returns {string}
 */
export function generarLotePaginado(cards, opts = {}) {
  const lista = parsearCards(cards);
  if (!lista.length) return '';

  const pagina = Math.max(1, entero(opts.pagina, 100));
  const desde = entero(opts.desde, 1);
  const saltar = Math.max(0, entero(opts.saltar, 0));
  const partes = [];

  for (let i = 0; i < lista.length; i += pagina) {
    partes.push(generarLote(lista.slice(i, i + pagina), {
      desde: desde + i,
      saltar: saltar + i,
      db: opts.db,
      rutaDb: opts.rutaDb,
      titulares: Array.isArray(opts.titulares)
        ? opts.titulares.slice(i, i + pagina)
        : undefined,
    }));
  }

  return partes.join(SEPARADOR);
}
