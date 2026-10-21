/* renaper.js — fecha de nacimiento y datos de ficha desde un espejo publico
 * del RENAPER (NO oficial, free tier de onrender: puede dormir).
 *
 *   GET {BASE}/renaper/{dni}/{genero}     genero = M | F | X
 *
 * Respuesta JSON: apellido, nombres, fechaNacimiento (YYYY-MM-DD), calle,
 * numeroCalle, ciudad, provincia, cpostal, monoblock, barrio, municipio, cuil,
 * idTramitePrincipal, codigoError (200 = ok), error (bool), descripcionError.
 *
 * Reglas:
 * - Fuente declarada REAL_RENAPER. Si un campo viene vacio/null => AUSENTE.
 * - NUNCA se inventa un dato: lo que no viene queda null y la ficha lo marca "-".
 * - Timeout 60 s (el free tier puede tardar en despertar). Si falla, AUSENTE con
 *   motivo; las funciones NUNCA lanzan.
 * - Cache en tabla `renaper` (TTL 365 dias) + `renaper_intentos` y
 *   datos/renaper.log. Solo se crean esas dos tablas.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const BASE = process.env.RENAPER_BASE || 'https://apirnpr.onrender.com';
export const TTL_DIAS = Number(process.env.RENAPER_TTL_DIAS || 365);

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');
const RUTA_LOG = path.join(RAIZ, 'datos', 'renaper.log');
const TIMEOUT_MS = Number(process.env.RENAPER_TIMEOUT_MS || 60000);

let db = null;

function abrir() {
  if (db) return db;
  fs.mkdirSync(path.dirname(RUTA_DB), { recursive: true });
  db = new DatabaseSync(RUTA_DB);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS renaper (
    dni           TEXT PRIMARY KEY,
    fechaNac      TEXT,
    nroTramite    TEXT,
    direccion     TEXT,
    ciudad        TEXT,
    provincia     TEXT,
    cpostal       TEXT,
    cuilRenaper   TEXT,
    fuente        TEXT,
    capturado     TEXT,
    ttl_dias      INTEGER,
    crudo         TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS renaper_intentos (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    dni     TEXT,
    ts      TEXT,
    http    INTEGER,
    motivo  TEXT
  )`);
  return db;
}

/** Crea (si faltan) las tablas renaper y renaper_intentos. Idempotente. */
export function asegurar() {
  try {
    abrir();
    return true;
  } catch (_) {
    return false;
  }
}

export function normalizarDni(dni) {
  const d = String(dni ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11) return d.slice(2, 10);
  return d.length <= 8 ? d.padStart(8, '0') : d.slice(-8);
}

export function normalizarGenero(genero) {
  const g = String(genero ?? '').trim().toUpperCase();
  if (g === 'M' || g === 'F' || g === 'X') return g;
  if (/^(MASCULINO|MALE|HOMBRE)$/.test(g)) return 'M';
  if (/^(FEMENINO|FEMALE|MUJER)$/.test(g)) return 'F';
  return 'X';
}

function registrarIntento(dni, info = {}) {
  const d = normalizarDni(dni);
  const ts = new Date().toISOString();
  const http = Number.isFinite(Number(info.http)) && Number(info.http) > 0 ? Number(info.http) : null;
  const motivo = info.motivo == null ? null : String(info.motivo).slice(0, 300);
  try {
    fs.appendFileSync(RUTA_LOG, JSON.stringify({ ts, dni: d || null, http, motivo }) + '\n');
  } catch (_) {}
  if (!d) return;
  try {
    abrir().prepare('INSERT INTO renaper_intentos (dni, ts, http, motivo) VALUES (?,?,?,?)').run(d, ts, http, motivo);
  } catch (_) {}
}

/** Lee la cache. Devuelve la fila + {vencido} o null. */
export function leer(dni) {
  const d = normalizarDni(dni);
  if (!d) return null;
  try {
    const fila = abrir().prepare('SELECT * FROM renaper WHERE dni = ?').get(d);
    if (!fila) return null;
    const ttl = Number(fila.ttl_dias ?? TTL_DIAS);
    const capturado = Date.parse(fila.capturado);
    const edadDias = Number.isFinite(capturado) ? (Date.now() - capturado) / 86400000 : Infinity;
    /* La tabla no tiene columnas de nombre: se recuperan del crudo para que
     * TITULAR pueda salir de RENAPER tambien en cache. */
    let apellido = null;
    let nombres = null;
    if (fila.crudo) {
      try {
        const j = JSON.parse(fila.crudo);
        apellido = texto(j.apellido);
        nombres = texto(j.nombres ?? j.nombre);
      } catch (_) {}
    }
    return { ...fila, apellido, nombres, fuente: fila.fuente || 'REAL_RENAPER', vencido: !(edadDias <= ttl) };
  } catch (_) {
    return null;
  }
}

/** Guarda/actualiza una fila de cache. `datos` es la salida de interpretar(). */
export function guardar(dni, datos = {}, meta = {}) {
  const d = normalizarDni(dni);
  if (!d) return null;
  const crudo = meta.crudo == null
    ? null
    : (typeof meta.crudo === 'string' ? meta.crudo : JSON.stringify(meta.crudo)).slice(0, 8000);
  try {
    abrir().prepare(`INSERT INTO renaper
      (dni, fechaNac, nroTramite, direccion, ciudad, provincia, cpostal, cuilRenaper,
       fuente, capturado, ttl_dias, crudo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(dni) DO UPDATE SET
        fechaNac=excluded.fechaNac, nroTramite=excluded.nroTramite, direccion=excluded.direccion,
        ciudad=excluded.ciudad, provincia=excluded.provincia, cpostal=excluded.cpostal,
        cuilRenaper=excluded.cuilRenaper, fuente=excluded.fuente,
        capturado=excluded.capturado, ttl_dias=excluded.ttl_dias, crudo=excluded.crudo`)
      .run(d, datos.fechaNac ?? null, datos.nroTramite ?? null, datos.direccion ?? null,
        datos.ciudad ?? null, datos.provincia ?? null, datos.cpostal ?? null,
        datos.cuilRenaper ?? null, 'REAL_RENAPER', new Date().toISOString(), TTL_DIAS, crudo);
  } catch (_) {
    return null;
  }
  return leer(d);
}

/* ---------------------------------------------------------------------------
 * interpretar(): PURA. Sin red, sin DB. Mapea el payload del espejo RENAPER.
 * ------------------------------------------------------------------------- */
function texto(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function dosDigitos(n) {
  return String(n).padStart(2, '0');
}

/** Normaliza fecha de nacimiento a dd/mm/aaaa. No inventa formatos. */
export function normalizarFecha(v) {
  const s = texto(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return `${dosDigitos(m[1])}/${dosDigitos(m[2])}/${m[3]}`;
  return s;
}

function componerDireccion(calle, numeroCalle) {
  const c = texto(calle);
  const n = texto(numeroCalle);
  if (c && n) return `${c} ${n}`;
  return c || n || null;
}

export function interpretar(payload) {
  let j = payload;
  if (typeof j === 'string') {
    try { j = JSON.parse(j); } catch (_) { j = null; }
  }
  if (Array.isArray(j)) j = j[0] ?? null;

  const vacio = {
    fuente: 'AUSENTE',
    motivo: 'respuesta vacia o invalida',
    apellido: null,
    nombres: null,
    fechaNac: null,
    nroTramite: null,
    direccion: null,
    calle: null,
    numeroCalle: null,
    ciudad: null,
    provincia: null,
    cpostal: null,
    cuilRenaper: null,
    barrio: null,
    municipio: null,
    monoblock: null,
    codigoError: null,
  };
  if (!j || typeof j !== 'object') return vacio;

  const codigoError = j.codigoError === null || j.codigoError === undefined ? null : Number(j.codigoError);
  const error = j.error === true || (codigoError !== null && codigoError !== 200);

  if (error) {
    return {
      ...vacio,
      fuente: 'AUSENTE',
      motivo: texto(j.descripcionError) || texto(j.mensaje) || texto(j.message) || `codigoError ${codigoError ?? 'desconocido'}`,
      apellido: texto(j.apellido),
      nombres: texto(j.nombres),
      codigoError,
    };
  }

  const out = {
    fuente: 'REAL_RENAPER',
    motivo: null,
    apellido: texto(j.apellido),
    nombres: texto(j.nombres),
    fechaNac: normalizarFecha(j.fechaNacimiento),
    nroTramite: texto(j.idTramitePrincipal),
    direccion: componerDireccion(j.calle, j.numeroCalle),
    calle: texto(j.calle),
    numeroCalle: texto(j.numeroCalle),
    ciudad: texto(j.ciudad),
    provincia: texto(j.provincia),
    cpostal: texto(j.cpostal),
    cuilRenaper: texto(j.cuil),
    barrio: texto(j.barrio),
    municipio: texto(j.municipio),
    monoblock: texto(j.monoblock),
    codigoError,
  };

  /* Sin ningun dato util no es una respuesta valida. */
  const util = ['apellido', 'nombres', 'fechaNac', 'nroTramite', 'direccion', 'ciudad', 'provincia', 'cpostal', 'cuilRenaper'];
  if (!util.some((k) => out[k] !== null)) {
    return { ...vacio, motivo: 'respuesta sin datos utiles', codigoError };
  }
  return out;
}

/* --------------------------------------------------------------------------- */
async function traer(url, init = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    let cuerpo = '';
    try { cuerpo = await res.text(); } catch (_) {}
    return { ok: res.ok, http: res.status, cuerpo };
  } catch (e) {
    return {
      ok: false, http: 0, cuerpo: '',
      motivo: e?.name === 'AbortError' ? `timeout ${timeoutMs}ms` : String(e?.message || e),
    };
  } finally {
    clearTimeout(t);
  }
}

/** GET al espejo. Nunca lanza. */
export async function consultarRemoto(dni, opts = {}) {
  const d = normalizarDni(dni);
  if (!d) return { ok: false, fuente: 'AUSENTE', http: null, motivo: 'dni invalido' };

  const genero = normalizarGenero(opts.genero ?? opts.g);
  const url = `${BASE}/renaper/${d}/${genero}`;

  /* Provider por env: RENAPER_BASE + basic auth opcional (RENAPER_USER/RENAPER_PASS). */
  const headers = { accept: 'application/json' };
  const usuario = process.env.RENAPER_USER;
  const clave = process.env.RENAPER_PASS;
  if (usuario && clave) {
    headers.authorization = 'Basic ' + Buffer.from(`${usuario}:${clave}`).toString('base64');
  }

  const r = await traer(url, { headers }, Number(opts.timeoutMs || TIMEOUT_MS));

  if (!r.ok) {
    const motivo = r.motivo || `HTTP ${r.http}`;
    registrarIntento(d, { http: r.http, motivo });
    return { ok: false, fuente: 'AUSENTE', http: r.http, motivo, genero, crudo: r.cuerpo.slice(0, 400) };
  }

  let json = null;
  if (r.cuerpo) { try { json = JSON.parse(r.cuerpo); } catch (_) {} }
  if (!json) {
    registrarIntento(d, { http: r.http, motivo: 'respuesta no-JSON' });
    return { ok: false, fuente: 'AUSENTE', http: r.http, motivo: 'respuesta no-JSON', genero, crudo: r.cuerpo.slice(0, 400) };
  }

  const datos = interpretar(json);
  if (datos.fuente !== 'REAL_RENAPER') {
    registrarIntento(d, { http: r.http, motivo: datos.motivo || 'sin datos' });
    return { ok: false, fuente: 'AUSENTE', http: r.http, motivo: datos.motivo || 'sin datos', genero, crudo: json };
  }

  registrarIntento(d, { http: r.http, motivo: `ok genero=${genero}` });
  return { ok: true, fuente: 'REAL_RENAPER', http: r.http, genero, datos, crudo: json };
}

function ausente(motivo, http = null, enCache = null) {
  return {
    fuente: 'AUSENTE',
    origen: 'SIN_DATOS',
    motivo: motivo || 'sin dato',
    http,
    fechaNac: enCache?.fechaNac ?? null,
    nroTramite: enCache?.nroTramite ?? null,
    direccion: enCache?.direccion ?? null,
    ciudad: enCache?.ciudad ?? null,
    provincia: enCache?.provincia ?? null,
    cpostal: enCache?.cpostal ?? null,
    vencido: enCache ? Boolean(enCache.vencido) : null,
  };
}

/**
 * Cache -> red. Por defecto SOLO cache: la red se habilita con opts.red === true
 * (o opts.sinRed === false). Nunca lanza.
 */
export async function obtener(dni, opts = {}) {
  const d = normalizarDni(dni);
  if (!d) return ausente('dni invalido');

  const enCache = leer(d);
  if (enCache && !enCache.vencido) return { ...enCache, fuente: 'REAL_RENAPER', origen: 'CACHE' };

  const red = opts.red === true || opts.sinRed === false;
  if (!red) return ausente(enCache ? 'cache vencido, sin red' : 'sin cache y sin red', null, enCache);

  const r = await consultarRemoto(d, opts);
  if (r.ok) {
    const guardado = guardar(d, r.datos, { crudo: r.crudo });
    return guardado
      ? { ...guardado, ...r.datos, origen: 'REMOTO' }
      : { ...r.datos, fuente: 'REAL_RENAPER', origen: 'REMOTO' };
  }
  return ausente(r.motivo, r.http, enCache);
}

/** Sync: SOLO cache (el free tier puede tardar 60 s; para red usar obtener()). */
export function obtenerSync(dni, opts = {}) {
  const d = normalizarDni(dni);
  if (!d) return ausente('dni invalido');
  let enCache = null;
  try { enCache = leer(d); } catch (_) {}
  if (enCache && !enCache.vencido) return { ...enCache, fuente: 'REAL_RENAPER', origen: 'CACHE' };
  return ausente(
    opts.red ? 'modo sync: solo cache; usar obtener() para consultar la red' : (enCache ? 'cache vencido, sin red' : 'sin cache, sin red'),
    null,
    enCache
  );
}

/** Estado de la cache y de los intentos. Nunca lanza. */
export function stats() {
  const base = {
    tabla: 'renaper',
    cacheados: 0,
    conFechaNac: 0,
    conTramite: 0,
    conDireccion: 0,
    intentos: 0,
    ultimoIntento: null,
    ultimos: [],
    ttlDias: TTL_DIAS,
    base: BASE,
    error: null,
  };
  try {
    const a = abrir();
    base.cacheados = a.prepare('SELECT COUNT(*) n FROM renaper').get().n;
    base.conFechaNac = a.prepare('SELECT COUNT(*) n FROM renaper WHERE fechaNac IS NOT NULL').get().n;
    base.conTramite = a.prepare('SELECT COUNT(*) n FROM renaper WHERE nroTramite IS NOT NULL').get().n;
    base.conDireccion = a.prepare('SELECT COUNT(*) n FROM renaper WHERE direccion IS NOT NULL').get().n;
    base.intentos = a.prepare('SELECT COUNT(*) n FROM renaper_intentos').get().n;
    base.ultimos = a.prepare('SELECT ts, dni, http, motivo FROM renaper_intentos ORDER BY id DESC LIMIT 5').all();
    base.ultimoIntento = base.ultimos[0] ?? null;
  } catch (e) {
    base.error = String(e?.message || e);
  }
  return base;
}
