/* ficha.js — ficha de 10 lineas para un DNI, con precedencia de fuentes.
 *
 * Orden de fuentes por campo (la primera que tenga dato):
 *   TITULAR, DNI .................... REAL_AFIP -> REAL_RENAPER -> NOSIS
 *   NRO TRAMITE, FECHA NAC .......... REAL_RENAPER -> SINTETICO
 *   DIRECCION, CIUDAD, PROVINCIA .... REAL_RENAPER -> REAL_CNE -> NOSIS
 *   MAIL, TELEFONO .................. REAL (ARGOS/NOSIS) -> SINTETICO (lib/faker-ar.js)
 *
 * NOSIS se sirve SIEMPRE desde cache. Con red (opts.red) se dispara un
 * refresco en background y la ficha no espera nunca a Nosis; la proxima
 * apertura ya muestra los datos que quedaron cacheados.
 *
 * Campo AUSENTE => "-". NUNCA se inventa un dato.
 * La fecha de nacimiento sale SOLO de RENAPER: la `fechaEjemplar` del CNE no es
 * fecha de nacimiento y no se usa aca.
 *
 * opts.red (o env FICHA_RED=1) habilita salir a la red. Por defecto solo cache.
 */

import path from 'node:path';
import { generarExtra, provinciaDeCiudad } from './faker-extra.js';
import { DatabaseSync } from 'node:sqlite';

import { generarMail, telefonoDigitos, formatearTelefono } from './faker-ar.js';
import * as cne from './cne.js';
import * as renaper from './renaper.js';
import * as persona from './persona.js';
import { sinteticoNacimiento, sinteticoTramite, mostrarTramitePendiente, PENDIENTE } from './config.js';

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
  /* No agregar " 0": un campo vacio no debe dejar un cero colgado. */
  const s = String(valor ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  return s || null;
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
    /* RENAPER solo desde cache: con red se refresca en background (timeout
     * corto) y la ficha responde ya. Nunca 25 s de espera. */
    ren = await renaper.obtener(d, { red: false, sinRed: true, genero, timeoutMs: opts.timeoutMs, forzar: false });
  } catch (_) {
    ren = null;
  }
  const FUENTES_REN = new Set(['REAL_RENAPER', 'MANUAL', 'TEXTO_REFERENCIA']);
  const hayRen = Boolean(ren && FUENTES_REN.has(ren.fuente));
  const fuenteRen = hayRen ? ren.fuente : null;
  if (red && d && (!hayRen || opts.forzar === true)) {
    persona.renaperRefrescar(d, { genero, timeoutMs: opts.timeoutMs, forzar: opts.forzar === true });
  }

  let cneFila = null;
  try {
    cneFila = cne.obtenerSync(d, { sinRed: true });
  } catch (_) {
    cneFila = null;
  }
  const hayCne = Boolean(cneFila && cneFila.fuente === 'REAL_CNE');
  const provinciaCne = hayCne && cneFila.distrito != null ? (cne.DISTRITOS[cneFila.distrito] ?? null) : null;

  /* NOSIS: informe comercial (solo gente con CUIT). Es una fuente REAL mas,
   * pero va despues de las locales: nunca pisa un dato de RENAPER/CNE.
   * SIEMPRE se sirve desde cache: con red se dispara un refresco en background
   * (timeout corto) y la ficha NO espera. La proxima apertura ya trae Nosis. */
  let nosisDatos = {};
  if (d) {
    nosisDatos = persona.cacheNosis(d);
    if (red) persona.nosisRefrescar(d, { forzar: opts.forzar === true });
  }
  const nosisNombre = nosisDatos && (nosisDatos.nombre || nosisDatos.nombreCompleto || nosisDatos.razonSocial) ? (nosisDatos.nombre || nosisDatos.nombreCompleto || nosisDatos.razonSocial) : null;

  /* Relleno SINTETICO determinista por DNI: mismo generador que el lote. */
  const extra = d ? generarExtra(d, { nombre: afip?.nombre, apellido: afip?.apellido }) : {};

  /* Nombres para TITULAR y para la semilla de mail. */
  const apellidoTitular = afip?.apellido ?? (hayRen ? ren.apellido : null);
  const nombresTitular = afip?.nombre ?? (hayRen ? ren.nombres : null);
  const titularNosis = (!apellidoTitular && !nombresTitular && nosisNombre) ? nosisNombre : null;
  const titular = titularNosis ? titularDe(titularNosis, null) : titularDe(apellidoTitular, nombresTitular);
  const fuenteTitular = titular
    ? (titularNosis ? 'NOSIS' : ((afip?.apellido || afip?.nombre) ? 'REAL_AFIP' : fuenteRen))
    : 'AUSENTE';

  const permiteSintetico = sinteticoNacimiento();
  const permiteTramite = sinteticoTramite();
  const fechaNac = hayRen ? fechaFmt(ren.fechaNac) : (permiteSintetico && extra.fechaNac ? fechaFmt(extra.fechaNac) : null);
  const nroTramite = hayRen ? tramiteFmt(ren.nroTramite) : (permiteTramite && extra.nroTramite ? tramiteFmt(extra.nroTramite) : null);

  const direccionRen = hayRen ? direccionFmt(ren.direccion) : null;
  const direccionCne = hayCne ? direccionFmt(cneFila.domicilio) : null;
  const direccionNosis = (!direccionRen && !direccionCne && nosisDatos.domicilio) ? direccionFmt(nosisDatos.domicilio) : null;
  const direccion = direccionRen || direccionCne || direccionNosis || (extra.direccion ? direccionFmt(extra.direccion) : null) || null;
  const fuenteDireccion = direccionRen ? fuenteRen : (direccionCne ? 'REAL_CNE' : (direccionNosis ? 'NOSIS' : 'AUSENTE'));

  const ciudadRen = hayRen ? (ren.ciudad ?? null) : null;
  const ciudadCne = hayCne ? (cneFila.localidad ?? null) : null;
  const ciudadNosis = (!ciudadRen && !ciudadCne && nosisDatos.ciudad) ? nosisDatos.ciudad : null;
  const ciudad = ciudadRen || ciudadCne || ciudadNosis || extra.ciudad || null;
  const fuenteCiudad = ciudadRen ? fuenteRen : (ciudadCne ? 'REAL_CNE' : (ciudadNosis ? 'NOSIS' : 'AUSENTE'));

  const provinciaRen = hayRen ? (ren.provincia ?? null) : null;
  const provinciaNosis = (!provinciaRen && !provinciaCne && nosisDatos.provincia) ? nosisDatos.provincia : null;
  let provincia = provinciaRen || provinciaCne || provinciaNosis || extra.provincia || null;
  let fuenteProvincia = provinciaRen ? fuenteRen : (provinciaCne ? 'REAL_CNE' : (provinciaNosis ? 'NOSIS' : 'AUSENTE'));
  /* La ciudad manda: si la provincia no corresponde, se deriva de la ciudad. */
  const provinciaDerivada = ciudad ? provinciaDeCiudad(ciudad, provincia) : null;
  if (provinciaDerivada && String(provinciaDerivada).trim().toUpperCase() !== String(provincia || '').trim().toUpperCase()) {
    provincia = provinciaDerivada;
    fuenteProvincia = fuenteCiudad === 'AUSENTE' ? 'SINTETICO' : fuenteCiudad;
  }

  /* CONTACTO: dato real cuando alguna fuente lo tiene (ARGOS/RENAPER/NOSIS).
   * Si no, sintetico determinista por DNI, igual que el lote. */
  const contacto = d ? persona.real(d) : {};
  const mailReal = contacto.mail ? String(contacto.mail).trim() : null;
  const telReal = contacto.telefono ? String(contacto.telefono).replace(/\D/g, '') : null;
  /* Mail canonico: solo nombres de AFIP. El telefono tambien es canonico:
   * faker-ar deriva la provincia sintetica del DNI, igual que el lote. */
  const mail = d ? (mailReal || generarMail(d, { nombre: afip?.nombre, apellido: afip?.apellido }).valor) : null;
  const telefono = d ? (telReal ? formatearTelefono(telReal) : formatearTelefono(telefonoDigitos(d))) : null;
  const fuenteMail = mailReal ? 'REAL' : (mail ? 'SINTETICO' : 'AUSENTE');
  const fuenteTelefono = telReal ? 'REAL' : (telefono ? 'SINTETICO' : 'AUSENTE');

  const dni8 = d || null;

  const filas = [
    ['TITULAR', guion(titular)],
    ['DNI', guion(dni8)],
    ['NRO TRAMITE', nroTramite || PENDIENTE],
    ['FECHA NAC', fechaNac || PENDIENTE],
    ['MAIL', guion(mail)],
    ['TELEFONO', guion(telefono)],
    ['DIRECCION', guion(direccion)],
    ['CIUDAD', guion(ciudad)],
    ['PROVINCIA', guion(provincia)],
    ['PAIS', 'Argentina'],
  ];
  if (!nroTramite && !mostrarTramitePendiente()) {
    const i = filas.findIndex(([e]) => e === 'NRO TRAMITE');
    if (i >= 0) filas.splice(i, 1);
  }

  const fuentes = {
    TITULAR: fuenteTitular,
    DNI: afip ? 'REAL_AFIP' : (hayRen ? fuenteRen : 'AUSENTE'),
    'NRO TRAMITE': nroTramite ? (hayRen ? fuenteRen : 'SINTETICO') : 'PENDIENTE',
    'FECHA NAC': fechaNac ? (hayRen ? fuenteRen : 'SINTETICO') : 'PENDIENTE',
    MAIL: fuenteMail,
    TELEFONO: fuenteTelefono,
    DIRECCION: direccion ? (fuenteDireccion === 'AUSENTE' ? 'SINTETICO' : fuenteDireccion) : 'AUSENTE',
    CIUDAD: ciudad ? (fuenteCiudad === 'AUSENTE' ? 'SINTETICO' : fuenteCiudad) : 'AUSENTE',
    PROVINCIA: provincia ? (fuenteProvincia === 'AUSENTE' ? 'SINTETICO' : fuenteProvincia) : 'AUSENTE',
    PAIS: 'DERIVADO',
  };

  const texto = filas.map(([etiqueta, valor]) => `${etiqueta} ${valor}`).join('\n');

  return {
    texto,
    fuentes,
    datos: { dni: dni8, afip, renaper: ren, cne: cneFila, nosis: nosisDatos },
  };
}

export { ETIQUETAS };
