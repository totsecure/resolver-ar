/* ficha.js — ficha de 10 lineas para un DNI, con precedencia de fuentes.
 *
 * Orden de fuentes por campo (la primera que tenga dato):
 *   TITULAR, DNI .................... REAL_AFIP -> REAL_RENAPER
 *   NRO TRAMITE, FECHA NAC .......... REAL_RENAPER
 *   DIRECCION, CIUDAD, PROVINCIA .... REAL_RENAPER -> REAL_CNE (cache)
 *   MAIL, TELEFONO .................. SINTETICO (lib/faker-ar.js)
 *
 * Campo AUSENTE => "-". NUNCA se inventa un dato.
 * La fecha de nacimiento sale SOLO de RENAPER: la `fechaEjemplar` del CNE no es
 * fecha de nacimiento y no se usa aca.
 *
 * opts.red (o env FICHA_RED=1) habilita salir a la red. Por defecto solo cache.
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { generarMail, telefonoDigitos } from './faker-ar.js';
import * as cne from './cne.js';
import * as renaper from './renaper.js';

const RUTA_DB = process.env.RESOLVER_DB || path.join(import.meta.dirname, '..', 'datos', 'padron.db');
const ORDEN = "CASE substr(cuit,1,2) WHEN '20' THEN 0 WHEN '27' THEN 1 WHEN '23' THEN 2 WHEN '24' THEN 3 ELSE 4 END, cuit";

const ETIQUETAS = ['TITULAR', 'DNI', 'NRO TRAMITE', 'FECHA NAC', 'MAIL', 'TELEFONO', 'DIRECCION', 'CIUDAD', 'PROVINCIA', 'PAIS'];

let db = null;

function baseDatos() {
  if (db) return db;
  db = new DatabaseSync(RUTA_DB);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/* Persona del padron AFIP: mismo orden determinista que lib/resolver.js. */
function afipDe(dni) {
  if (!dni) return null;
  try {
    const filas = baseDatos().prepare('SELECT dni, apellido, nombre, cuit FROM personas WHERE dni = ? ORDER BY ' + ORDEN).all(dni);
    if (!filas.length) return null;
    const p = filas[0];
    const prefijo = String(p.cuit).slice(0, 2);
    return {
      apellido: p.apellido || null,
      nombre: p.nombre || null,
      cuit: p.cuit,
      dni: p.dni,
      sexo: prefijo === '27' ? 'F' : (prefijo === '20' || prefijo === '23' || prefijo === '24' ? 'M' : null),
    };
  } catch (_) {
    return null;
  }
}

const guion = (v) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s === '' ? '-' : s;
};

/* DIRECCION: CALLE NUMERO en mayusculas; si no hay numero, 0. */
function direccionFmt(valor) {
  const s = String(valor ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!s) return null;
  return /\d+\s*$/.test(s) ? s : s + ' 0';
}

/* NRO TRAMITE: 11 digitos con ceros a la izquierda. */
function tramiteFmt(valor) {
  const s = String(valor ?? '').replace(/\D/g, '');
  if (!s) return null;
  return s.padStart(11, '0');
}

/* FECHA NAC: solo dd/mm/aaaa. Cualquier otra cosa es AUSENTE. */
function fechaFmt(valor) {
  const s = String(valor ?? '').trim();
  return /^\d{2}\/\d{2}\/\d{4}$/.test(s) ? s : null;
}

function titularDe(apellido, nombres) {
  const a = String(apellido ?? '').trim().toUpperCase();
  const n = String(nombres ?? '').trim();
  const t = [a, n].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return t || null;
}

/**
 * Devuelve la ficha como texto EXACTO de 10 lineas (sin salto final).
 * @param {string|number} dni
 * @param {{red?:boolean, genero?:'M'|'F'|'X', timeoutMs?:number}} [opts]
 * @returns {Promise<string>}
 */
export async function ficha(dni, opts = {}) {
  const { texto } = await fichaDetalle(dni, opts);
  return texto;
}

/**
 * Igual que ficha() pero devuelve {texto, fuentes, datos}.
 * @returns {Promise<{texto:string, fuentes:Object<string,string>, datos:object}>}
 */
export async function fichaDetalle(dni, opts = {}) {
  const d = renaper.normalizarDni(dni);
  const red = opts.red === true || (opts.red === undefined && process.env.FICHA_RED === '1');

  const afip = afipDe(d);
  const genero = renaper.normalizarGenero(opts.genero ?? afip?.sexo ?? 'M');

  let ren = null;
  try {
    ren = await renaper.obtener(d, { red, sinRed: !red, genero, timeoutMs: opts.timeoutMs, forzar: opts.forzar === true });
  } catch (_) {
    ren = null;
  }
  const hayRen = Boolean(ren && ren.fuente === 'REAL_RENAPER');

  let cneFila = null;
  try {
    cneFila = cne.obtenerSync(d, { sinRed: true });
  } catch (_) {
    cneFila = null;
  }
  const hayCne = Boolean(cneFila && cneFila.fuente === 'REAL_CNE');
  const provinciaCne = hayCne && cneFila.distrito != null ? (cne.DISTRITOS[cneFila.distrito] ?? null) : null;

  /* Nombres para TITULAR y para la semilla de mail. */
  const apellidoTitular = afip?.apellido ?? (hayRen ? ren.apellido : null);
  const nombresTitular = afip?.nombre ?? (hayRen ? ren.nombres : null);
  const titular = titularDe(apellidoTitular, nombresTitular);
  const fuenteTitular = titular
    ? ((afip?.apellido || afip?.nombre) ? 'REAL_AFIP' : 'REAL_RENAPER')
    : 'AUSENTE';

  const fechaNac = hayRen ? fechaFmt(ren.fechaNac) : null;
  const nroTramite = hayRen ? tramiteFmt(ren.nroTramite) : null;

  const direccionRen = hayRen ? direccionFmt(ren.direccion) : null;
  const direccionCne = hayCne ? direccionFmt(cneFila.domicilio) : null;
  const direccion = direccionRen || direccionCne || null;
  const fuenteDireccion = direccionRen ? 'REAL_RENAPER' : (direccionCne ? 'REAL_CNE' : 'AUSENTE');

  const ciudadRen = hayRen ? (ren.ciudad ?? null) : null;
  const ciudadCne = hayCne ? (cneFila.localidad ?? null) : null;
  const ciudad = ciudadRen || ciudadCne || null;
  const fuenteCiudad = ciudadRen ? 'REAL_RENAPER' : (ciudadCne ? 'REAL_CNE' : 'AUSENTE');

  const provinciaRen = hayRen ? (ren.provincia ?? null) : null;
  const provincia = provinciaRen || provinciaCne || null;
  const fuenteProvincia = provinciaRen ? 'REAL_RENAPER' : (provinciaCne ? 'REAL_CNE' : 'AUSENTE');

  /* SINTETICOS: deterministas por DNI. */
  let mail = null;
  let telefono = null;
  if (d) {
    /* Mail canonico: solo nombres de AFIP. El telefono tambien es canonico:
     * faker-ar deriva la provincia sintetica del DNI, igual que el lote. */
    mail = generarMail(d, { nombre: afip?.nombre, apellido: afip?.apellido }).valor;
    telefono = telefonoDigitos(d);
  }

  const dni8 = d || null;

  const valores = [
    guion(titular),
    guion(dni8),
    guion(nroTramite),
    guion(fechaNac),
    guion(mail),
    guion(telefono),
    guion(direccion),
    guion(ciudad),
    guion(provincia),
    'Argentina',
  ];

  const fuentes = {
    TITULAR: fuenteTitular,
    DNI: afip ? 'REAL_AFIP' : (hayRen ? 'REAL_RENAPER' : 'AUSENTE'),
    'NRO TRAMITE': nroTramite ? 'REAL_RENAPER' : 'AUSENTE',
    'FECHA NAC': fechaNac ? 'REAL_RENAPER' : 'AUSENTE',
    MAIL: mail ? 'SINTETICO' : 'AUSENTE',
    TELEFONO: telefono ? 'SINTETICO' : 'AUSENTE',
    DIRECCION: fuenteDireccion,
    CIUDAD: fuenteCiudad,
    PROVINCIA: fuenteProvincia,
    PAIS: 'DERIVADO',
  };

  const texto = ETIQUETAS.map((etiqueta, i) => `${etiqueta} ${valores[i]}`).join('\n');

  return {
    texto,
    fuentes,
    datos: { dni: dni8, afip, renaper: ren, cne: cneFila },
  };
}

export { ETIQUETAS };
