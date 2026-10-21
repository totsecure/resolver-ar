/* cne.js — padron del CNE (Camara Nacional Electoral) con el contrato REAL.
 *
 * Fuente: https://www.padron.gob.ar  (mismo server que www.padron.gov.ar, IP 170.246.76.10)
 *
 *   GET  {BASE}/padron-api/config/web.json
 *   POST {BASE}/padron-api/captcha.jpg   -> cuerpo "token|segundos|base64(jpeg)"
 *        el token viaja como cookie `token=` en el request siguiente.
 *   POST {BASE}/padron-api/consulta      -> form-urlencoded
 *        c=<captcha>  e=""  m=<DNI>  d=<idDistrito>  s=<m|f|x>
 *
 * Respuesta de /consulta (claves de una letra):
 *   e=domicilio  t=localidad  j=fechaEjemplar  f=circuito  g=seccion
 *   h=establecimiento  i=direccionVoto  n=mesa  o=orden  p/q=lat/lng
 *   l=codRef  s=estado
 *
 * OJO: NO devuelve fecha de nacimiento. Devuelve fecha de EJEMPLAR. Por eso el
 * campo se llama `fechaEjemplar` y NUNCA se deriva un anio de nacimiento.
 *
 * Estados del endpoint: 400 validacion | 401 captcha | 403 sesion | 404 no
 * encontrado | 406 version | 409 distrito | 503 servicio no habilitado.
 *
 * HOY (2026-10): HAProxy sin backends => captcha responde 503 en ~0.3s y config
 * y consulta hacen timeout. Todo este modulo funciona SIN RED: devuelve
 * fuente='AUSENTE' con `motivo`, nunca lanza.
 *
 * Cache: tabla `cne` en datos/padron.db, TTL 180 dias. Intentos: `cne_intentos`
 * + datos/cne.log. Solo se crean esas dos tablas; el padron no se toca.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export const BASE = process.env.CNE_BASE || 'https://www.padron.gob.ar';
export const TTL_DIAS = Number(process.env.CNE_TTL_DIAS || 180);

/* Ids de distrito del padron CNE. */
export const DISTRITOS = {
  1: 'Capital Federal',
  2: 'Buenos Aires',
  3: 'Catamarca',
  4: 'Cordoba',
  5: 'Corrientes',
  6: 'Chaco',
  7: 'Chubut',
  8: 'Entre Rios',
  9: 'Formosa',
  10: 'Jujuy',
  11: 'La Pampa',
  12: 'La Rioja',
  13: 'Mendoza',
  14: 'Misiones',
  15: 'Neuquen',
  16: 'Rio Negro',
  17: 'Salta',
  18: 'San Juan',
  19: 'San Luis',
  20: 'Santa Cruz',
  21: 'Santa Fe',
  22: 'Santiago del Estero',
  23: 'Tucuman',
  24: 'Tierra del Fuego',
  25: 'Extranjeros-Buenos Aires',
  28: 'Argentinos en el exterior',
  31: 'Extranjeros-CABA',
};

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');
const RUTA_LOG = path.join(RAIZ, 'datos', 'cne.log');
const RUTA_CAPTCHA = '/tmp/cne-captcha.jpg';
const TIMEOUT_MS = Number(process.env.CNE_TIMEOUT_MS || 1500);

const MOTIVOS = {
  400: 'validacion: parametros invalidos',
  401: 'captcha invalido',
  403: 'sesion invalida o vencida',
  404: 'no encontrado en el padron CNE',
  406: 'version de API no soportada',
  409: 'distrito incorrecto',
  503: 'servicio no habilitado',
};

let db = null;

function abrir() {
  if (db) return db;
  fs.mkdirSync(path.dirname(RUTA_DB), { recursive: true });
  db = new DatabaseSync(RUTA_DB);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS cne (
    dni            TEXT PRIMARY KEY,
    domicilio      TEXT,
    localidad      TEXT,
    fechaEjemplar  TEXT,
    circuito       TEXT,
    seccion        TEXT,
    establecimiento TEXT,
    direccionVoto  TEXT,
    mesa           TEXT,
    orden          TEXT,
    lat            REAL,
    lng            REAL,
    codRef         TEXT,
    distrito       INTEGER,
    fuente         TEXT,
    capturado      TEXT,
    ttl_dias       INTEGER,
    crudo          TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS cne_intentos (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    dni     TEXT,
    ts      TEXT,
    http    INTEGER,
    motivo  TEXT
  )`);
  return db;
}

/** Crea (si faltan) las tablas cne y cne_intentos. Idempotente. */
export function asegurar() {
  try {
    abrir();
    return true;
  } catch (_) {
    return false;
  }
}

function normalizarDni(dni) {
  const d = String(dni ?? '').replace(/\D/g, '');
  if (!d || d.length > 11) return null;
  if (d.length === 11) return d.slice(2, 10);
  return d.padStart(8, '0');
}

function normalizarSexo(sexo) {
  const s = String(sexo ?? '').trim().toLowerCase();
  if (s === 'f' || s === 'm' || s === 'x') return s;
  if (s === 'femenino') return 'f';
  if (s === 'masculino') return 'm';
  return 'x';
}

function normalizarDistrito(id) {
  const n = Number(String(id ?? '').replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function registrarIntento(dni, info = {}) {
  const d = normalizarDni(dni);
  const ts = new Date().toISOString();
  const http = Number.isFinite(Number(info.http)) && Number(info.http) > 0 ? Number(info.http) : null;
  const motivo = info.motivo == null ? null : String(info.motivo).slice(0, 300);
  /* El log de archivo guarda todo, incluso intentos sin DNI (p. ej. captcha). */
  try {
    fs.appendFileSync(RUTA_LOG, JSON.stringify({ ts, dni: d || null, http, motivo }) + '\n');
  } catch (_) {}
  /* cne_intentos exige un DNI real: un captcha suelto no ensucia la tabla. */
  if (!d) return;
  try {
    abrir().prepare('INSERT INTO cne_intentos (dni, ts, http, motivo) VALUES (?,?,?,?)').run(d, ts, http, motivo);
  } catch (_) {}
}

/** Lee la cache. Devuelve la fila + {vencido} o null. */
export function leer(dni) {
  const d = normalizarDni(dni);
  if (!d) return null;
  try {
    const fila = abrir().prepare('SELECT * FROM cne WHERE dni = ?').get(d);
    if (!fila) return null;
    const ttl = Number(fila.ttl_dias ?? TTL_DIAS);
    const capturado = Date.parse(fila.capturado);
    const edadDias = Number.isFinite(capturado) ? (Date.now() - capturado) / 86400000 : Infinity;
    return { ...fila, fuente: fila.fuente || 'REAL_CNE', vencido: !(edadDias <= ttl) };
  } catch (_) {
    return null;
  }
}

/** Guarda/actualiza una fila de cache. `datos` es la salida de interpretar(). */
export function guardar(dni, datos = {}, meta = {}) {
  const d = normalizarDni(dni);
  if (!d) return null;
  const reg = {
    domicilio: datos.domicilio ?? null,
    localidad: datos.localidad ?? null,
    fechaEjemplar: datos.fechaEjemplar ?? null,
    circuito: datos.circuito ?? null,
    seccion: datos.seccion ?? null,
    establecimiento: datos.establecimiento ?? null,
    direccionVoto: datos.direccionVoto ?? null,
    mesa: datos.mesa ?? null,
    orden: datos.orden ?? null,
    lat: Number.isFinite(Number(datos.lat)) ? Number(datos.lat) : null,
    lng: Number.isFinite(Number(datos.lng)) ? Number(datos.lng) : null,
    codRef: datos.codRef ?? null,
  };
  const distrito = normalizarDistrito(meta.distrito ?? datos.distrito);
  const crudo = meta.crudo == null ? null : (typeof meta.crudo === 'string' ? meta.crudo : JSON.stringify(meta.crudo)).slice(0, 4000);
  const capturado = new Date().toISOString();
  try {
    abrir().prepare(`INSERT INTO cne
      (dni, domicilio, localidad, fechaEjemplar, circuito, seccion, establecimiento, direccionVoto,
       mesa, orden, lat, lng, codRef, distrito, fuente, capturado, ttl_dias, crudo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(dni) DO UPDATE SET
        domicilio=excluded.domicilio, localidad=excluded.localidad, fechaEjemplar=excluded.fechaEjemplar,
        circuito=excluded.circuito, seccion=excluded.seccion, establecimiento=excluded.establecimiento,
        direccionVoto=excluded.direccionVoto, mesa=excluded.mesa, orden=excluded.orden,
        lat=excluded.lat, lng=excluded.lng, codRef=excluded.codRef, distrito=excluded.distrito,
        fuente=excluded.fuente, capturado=excluded.capturado, ttl_dias=excluded.ttl_dias, crudo=excluded.crudo`)
      .run(d, reg.domicilio, reg.localidad, reg.fechaEjemplar, reg.circuito, reg.seccion,
        reg.establecimiento, reg.direccionVoto, reg.mesa, reg.orden, reg.lat, reg.lng, reg.codRef,
        distrito, 'REAL_CNE', capturado, TTL_DIAS, crudo);
  } catch (_) {
    return null;
  }
  return leer(d);
}

/* ---------------------------------------------------------------------------
 * interpretar(): PURA. Sin red, sin DB, sin estado. Mapea el payload real del
 * CNE (claves de una letra) al contrato interno. Nunca inventa: lo que falta
 * queda en null.
 * ------------------------------------------------------------------------- */
function texto(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function numero(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function interpretar(payload) {
  let j = payload;
  if (typeof j === 'string') {
    try { j = JSON.parse(j); } catch (_) { j = null; }
  }
  if (Array.isArray(j)) j = j[0] ?? null;

  const vacio = {
    fuente: 'AUSENTE', motivo: 'respuesta vacia o invalida',
    dni: null, nombre: null, tipoDocumento: null,
    domicilio: null, localidad: null, fechaEjemplar: null, circuito: null, seccion: null,
    establecimiento: null, direccionVoto: null, mesa: null, orden: null,
    lat: null, lng: null, codRef: null, estado: null,
  };
  if (!j || typeof j !== 'object') return vacio;

  /* La API puede envolver la respuesta en {datos:{...}} o {data:{...}}. */
  const b = (j.datos && typeof j.datos === 'object' && !Array.isArray(j.datos)) ? j.datos
    : (j.data && typeof j.data === 'object' && !Array.isArray(j.data)) ? j.data
    : j;

  const domicilio = texto(b.e);
  const localidad = texto(b.t);
  const fechaEjemplar = texto(b.j);

  const out = {
    fuente: 'REAL_CNE',
    motivo: null,
    dni: normalizarDni(texto(b.b) ?? texto(b.m) ?? '') || null,
    nombre: texto(b.d),
    tipoDocumento: texto(b.c),
    domicilio,
    localidad,
    fechaEjemplar,
    circuito: texto(b.f),
    seccion: texto(b.g),
    establecimiento: texto(b.h),
    direccionVoto: texto(b.i),
    mesa: texto(b.n),
    orden: texto(b.o),
    lat: numero(b.p),
    lng: numero(b.q),
    codRef: texto(b.l),
    estado: texto(b.s),
  };

  /* Marca de error explicita del backend. */
  if (texto(b.error) || texto(b.message) || texto(b.mensaje)) {
    out.fuente = 'AUSENTE';
    out.motivo = texto(b.error) || texto(b.message) || texto(b.mensaje);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Red. Todas las funciones atrapan cualquier error: NUNCA lanzan.
 * ------------------------------------------------------------------------- */
async function traer(url, init = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    let cuerpo = '';
    try { cuerpo = await res.text(); } catch (_) {}
    return { ok: res.ok, http: res.status, cuerpo, headers: res.headers };
  } catch (e) {
    return {
      ok: false, http: 0, cuerpo: '',
      motivo: e?.name === 'AbortError' ? `timeout ${timeoutMs}ms` : String(e?.message || e),
    };
  } finally {
    clearTimeout(t);
  }
}

/** GET config/web.json. Best-effort: devuelve {ok,http,json|motivo}. */
export async function pedirConfig(timeoutMs = TIMEOUT_MS) {
  const r = await traer(`${BASE}/padron-api/config/web.json`, { headers: { accept: 'application/json' } }, timeoutMs);
  let json = null;
  if (r.cuerpo) { try { json = JSON.parse(r.cuerpo); } catch (_) {} }
  if (!r.ok || !json) {
    return { ok: false, http: r.http, motivo: r.motivo || MOTIVOS[r.http] || `HTTP ${r.http}`, crudo: r.cuerpo.slice(0, 300) };
  }
  return { ok: true, http: r.http, json };
}

/**
 * Pide un captcha nuevo. Guarda el jpeg en /tmp/cne-captcha.jpg.
 * @returns {{ok:boolean, token?:string, segundos?:number, ruta?:string, bytes?:number, http?:number, motivo?:string}}
 */
export async function pedirCaptcha(timeoutMs = TIMEOUT_MS) {
  const r = await traer(`${BASE}/padron-api/captcha.jpg`, {
    method: 'POST',
    headers: { accept: 'image/jpeg' },
  }, timeoutMs);

  if (!r.ok) {
    const motivo = r.motivo || MOTIVOS[r.http] || `HTTP ${r.http}`;
    registrarIntento('', { http: r.http, motivo: `captcha: ${motivo}` });
    return { ok: false, http: r.http, motivo, crudo: r.cuerpo.slice(0, 200) };
  }

  const partes = String(r.cuerpo).trim().split('|');
  if (partes.length < 3) {
    registrarIntento('', { http: r.http, motivo: 'captcha: formato inesperado' });
    return { ok: false, http: r.http, motivo: 'formato inesperado (se esperaba token|segundos|base64)', crudo: r.cuerpo.slice(0, 200) };
  }

  const [token, segundos, b64] = partes;
  const jpeg = Buffer.from(b64, 'base64');
  let ruta = null;
  try {
    fs.writeFileSync(RUTA_CAPTCHA, jpeg);
    ruta = RUTA_CAPTCHA;
  } catch (_) {}

  return {
    ok: true,
    http: r.http,
    token: token.trim(),
    segundos: Number(segundos) || null,
    ruta,
    bytes: jpeg.length,
    fuente: 'REAL_CNE',
  };
}

/**
 * Una consulta al endpoint real. Requiere captcha resuelto (codigo) y token.
 * Si faltan, devuelve requiereCaptcha:true (no intenta adivinar).
 */
export async function consultarRemoto(dni, opts = {}) {
  const d = normalizarDni(dni);
  if (!d) return { ok: false, fuente: 'AUSENTE', http: null, motivo: 'dni invalido' };

  const codigo = opts.codigo ?? opts.captcha ?? opts.c ?? '';
  const token = opts.token ?? opts.t ?? '';
  const sexo = normalizarSexo(opts.sexo ?? opts.s);
  const distrito = normalizarDistrito(opts.distrito ?? opts.d) ?? 2;

  if (!codigo || !token) {
    return {
      ok: false, fuente: 'AUSENTE', requiereCaptcha: true, http: null,
      motivo: 'captcha requerido: usar scripts/cne.js captcha y pasar <codigo> <token>',
    };
  }

  const cuerpo = new URLSearchParams({ c: String(codigo), e: '', m: d, d: String(distrito), s: sexo }).toString();

  const r = await traer(`${BASE}/padron-api/consulta`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      cookie: `token=${token}`,
    },
    body: cuerpo,
  }, Number(opts.timeoutMs || TIMEOUT_MS));

  const motivoBase = r.motivo || MOTIVOS[r.http] || `HTTP ${r.http}`;

  let json = null;
  if (r.cuerpo) { try { json = JSON.parse(r.cuerpo); } catch (_) {} }

  if (!r.ok) {
    registrarIntento(d, { http: r.http, motivo: motivoBase });
    return { ok: false, fuente: 'AUSENTE', http: r.http, motivo: motivoBase, distrito, sexo, crudo: r.cuerpo.slice(0, 400) };
  }

  if (!json) {
    registrarIntento(d, { http: r.http, motivo: 'respuesta no-JSON' });
    return { ok: false, fuente: 'AUSENTE', http: r.http, motivo: 'respuesta no-JSON', distrito, sexo, crudo: r.cuerpo.slice(0, 400) };
  }

  const datos = interpretar(json);
  if (datos.fuente === 'AUSENTE') {
    registrarIntento(d, { http: r.http, motivo: datos.motivo || 'sin datos' });
    return { ok: false, fuente: 'AUSENTE', http: r.http, motivo: datos.motivo || 'sin datos', distrito, sexo, crudo: json };
  }

  registrarIntento(d, { http: r.http, motivo: `ok distrito=${distrito} sexo=${sexo}` });
  return { ok: true, fuente: 'REAL_CNE', http: r.http, distrito, sexo, datos, crudo: json };
}

function ausente(motivo, http = null, enCache = null) {
  return {
    fuente: 'AUSENTE',
    origen: 'SIN_DATOS',
    motivo: motivo || 'sin dato',
    http,
    domicilio: enCache?.domicilio ?? null,
    localidad: enCache?.localidad ?? null,
    fechaEjemplar: enCache?.fechaEjemplar ?? null,
    vencido: enCache ? Boolean(enCache.vencido) : null,
  };
}

/** Async: cache -> (si corresponde) red. Nunca lanza. */
export async function obtener(dni, opts = {}) {
  const d = normalizarDni(dni);
  if (!d) return ausente('dni invalido');

  const enCache = leer(d);
  if (enCache && !enCache.vencido) return { ...enCache, fuente: 'REAL_CNE', origen: 'CACHE' };

  const sinRed = opts.sinRed === true || opts.red === false;
  if (sinRed) return ausente(enCache ? 'cache vencido, sin red' : 'sin cache y sin red', null, enCache);

  const r = await consultarRemoto(d, opts);
  if (r.ok) {
    const guardado = guardar(d, r.datos, { distrito: r.distrito, crudo: r.crudo });
    return guardado
      ? { ...guardado, fuente: 'REAL_CNE', origen: 'REMOTO' }
      : { ...r.datos, fuente: 'REAL_CNE', origen: 'REMOTO' };
  }
  return ausente(r.motivo, r.http, enCache);
}

/* Consulta sincrona: SOLO cache por defecto. Con opts.red=true y token+codigo
 * hace un POST sync via curl (macOS). Sin captcha resuelto devuelve AUSENTE. */
export function obtenerSync(dni, opts = {}) {
  const d = normalizarDni(dni);
  if (!d) return ausente('dni invalido');

  let enCache = null;
  try { enCache = leer(d); } catch (_) {}
  if (enCache && !enCache.vencido) return { ...enCache, fuente: 'REAL_CNE', origen: 'CACHE' };

  if (!opts.red) return ausente(enCache ? 'cache vencido, sin red' : 'sin cache, sin red', null, enCache);

  const codigo = opts.codigo ?? opts.captcha ?? opts.c ?? '';
  const token = opts.token ?? opts.t ?? '';
  if (!codigo || !token) return ausente('captcha requerido en modo sync', null, enCache);

  const distrito = normalizarDistrito(opts.distrito ?? opts.d) ?? 2;
  const sexo = normalizarSexo(opts.sexo ?? opts.s);
  const cuerpo = new URLSearchParams({ c: String(codigo), e: '', m: d, d: String(distrito), s: sexo }).toString();

  try {
    const salida = execFileSync('curl', [
      '-sS', '--max-time', String(Math.max(1, Math.ceil(TIMEOUT_MS / 1000))),
      '-X', 'POST', `${BASE}/padron-api/consulta`,
      '-H', 'content-type: application/x-www-form-urlencoded',
      '-H', 'accept: application/json',
      '-H', `cookie: token=${token}`,
      '--data-binary', cuerpo,
      '-w', '\n%{http_code}',
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: TIMEOUT_MS + 2000 });

    const corte = salida.lastIndexOf('\n');
    const http = Number(salida.slice(corte + 1).trim());
    const textoCuerpo = salida.slice(0, corte);
    let json = null;
    try { json = JSON.parse(textoCuerpo); } catch (_) {}

    if (http === 200 && json) {
      const datos = interpretar(json);
      if (datos.fuente === 'REAL_CNE') {
        registrarIntento(d, { http, motivo: 'ok (sync)' });
        const guardado = guardar(d, datos, { distrito, crudo: json });
        if (guardado) return { ...guardado, fuente: 'REAL_CNE', origen: 'REMOTO' };
      }
    }
    const motivo = MOTIVOS[http] || `HTTP ${http || 0}`;
    registrarIntento(d, { http, motivo });
    return ausente(motivo, http || null, enCache);
  } catch (e) {
    const motivo = e?.code === 'ETIMEDOUT' ? 'timeout curl' : String(e?.message || e).slice(0, 120);
    registrarIntento(d, { http: null, motivo });
    return ausente(motivo, null, enCache);
  }
}

/** Estado de la cache y de los intentos. Nunca lanza. */
export function stats() {
  const base = {
    tabla: 'cne',
    cacheados: 0,
    conDomicilio: 0,
    conFechaEjemplar: 0,
    intentos: 0,
    ultimoIntento: null,
    ultimos: [],
    ttlDias: TTL_DIAS,
    base: BASE,
    error: null,
  };
  try {
    const a = abrir();
    base.cacheados = a.prepare('SELECT COUNT(*) n FROM cne').get().n;
    base.conDomicilio = a.prepare('SELECT COUNT(*) n FROM cne WHERE domicilio IS NOT NULL').get().n;
    base.conFechaEjemplar = a.prepare('SELECT COUNT(*) n FROM cne WHERE fechaEjemplar IS NOT NULL').get().n;
    base.intentos = a.prepare('SELECT COUNT(*) n FROM cne_intentos').get().n;
    base.ultimos = a.prepare('SELECT ts, dni, http, motivo FROM cne_intentos ORDER BY id DESC LIMIT 5').all();
    base.ultimoIntento = base.ultimos[0] ?? null;
  } catch (e) {
    base.error = String(e?.message || e);
  }
  return base;
}
