/* nosis.js — fuente real NOSIS (informe comercial).
 *
 * El Mac no alcanza *.nosis.com (UND_ERR_CONNECT_TIMEOUT): TODO el trafico sale
 * por el Worker de Cloudflare (ruta /nosis).
 *
 * Superficie:
 *   pedir(url, {metodo, cuerpo, ct, cookie, manual}) -> {status, headers, texto}
 *   sesion()                       -> cookie (login automatico y cache de sesion)
 *   consultar(texto)               -> JSON de /Home/Buscar (cache 90d / vacio 7d)
 *   informe(cuit11)                -> HTML de /InformacionDisponible (cache 180d)
 *   interpretarNosis(json)         -> {cuit, dni, razonSocial, actividad, provincia}
 *   extraerDni(documento)          -> 8 digitos del medio del CUIT
 *
 * Nunca lanza por red: devuelve null / {} / status 0. El unico throw posible es
 * de programacion (URL invalida).
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_ENV = path.join(RAIZ, 'datos', 'server.env');
const RUTA_SESION = process.env.NOSIS_SESSION || path.join(RAIZ, 'datos', 'nosis-session.json');
const RUTA_COOLDOWN = process.env.NOSIS_COOLDOWN || path.join(RAIZ, 'datos', 'nosis-cooldown.json');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');

const WORKER = 'https://resolver-api.correonube.workers.dev/nosis';
const AUTH = 'https://auth.nosis.com';
const INFORMES = 'https://informes.nosis.com';
const URL_INFORME_BASE = INFORMES + '/InformacionDisponible?source=SITIONOSIS&documento=';

const TTL_BUSQUEDA_DIAS = Number(process.env.NOSIS_TTL_BUSQUEDA_DIAS || 90);
const TTL_VACIO_DIAS = Number(process.env.NOSIS_TTL_VACIO_DIAS || 7);
const TTL_INFORME_DIAS = Number(process.env.NOSIS_TTL_INFORME_DIAS || 180);
const TTL_SESION_DIAS = Number(process.env.NOSIS_TTL_SESION_DIAS || 20);
const TIMEOUT_MS = Number(process.env.NOSIS_TIMEOUT_MS || 30000);

/* ------------------------------- entorno -------------------------------- */
function leerEnv() {
  const out = {};
  try {
    const txt = fs.readFileSync(RUTA_ENV, 'utf8');
    for (const linea of txt.split('\n')) {
      const m = linea.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return out;
}
const ENV = leerEnv();
const valor = (k) => (process.env[k] || ENV[k] || '').trim();

function tokenWorker() {
  const t = valor('RESOLVER_TOKEN');
  if (!t) throw new Error('falta RESOLVER_TOKEN (datos/server.env)');
  return t;
}

/* --------------------------------- DB ----------------------------------- */
let db = null;
function abrir() {
  if (db) return db;
  fs.mkdirSync(path.dirname(RUTA_DB), { recursive: true });
  db = new DatabaseSync(RUTA_DB);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS nosis_busqueda (
    texto TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    creado TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS nosis_informe (
    documento TEXT PRIMARY KEY,
    html TEXT NOT NULL,
    creado TEXT NOT NULL
  )`);
  /* Columna dni para lookup directo por DNI (evita pasar por personas). */
  try { db.exec('ALTER TABLE nosis_informe ADD COLUMN dni TEXT'); } catch (_) {}
  db.exec('CREATE INDEX IF NOT EXISTS idx_nosis_informe_dni ON nosis_informe(dni)');
  try { db.exec("UPDATE nosis_informe SET dni = substr(documento,3,8) WHERE dni IS NULL AND length(documento) = 11"); } catch (_) {}
  /* Acelera el lookup por DNI (documento = CUIT sin guiones). */
  db.exec('CREATE INDEX IF NOT EXISTS idx_nosis_busqueda_creado ON nosis_busqueda(creado)');
  return db;
}

export function asegurar() {
  try { abrir(); return true; } catch (_) { return false; }
}

const ahora = () => new Date().toISOString();
function edadDias(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 86400000 : Infinity;
}

/* ------------------------------ transporte ------------------------------- */
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* Throttle global: al menos NOSIS_MIN_MS entre requests (no alcanza con dormir
 * solo en los reintentos; el bot puede pedir muchas fichas en rafaga). */
let ultimoPedido = 0;
let captchaHasta = 0;
const MIN_MS = Number(process.env.NOSIS_MIN_MS || 350);

async function esperarTurno() {
  const falta = MIN_MS - (Date.now() - ultimoPedido);
  if (falta > 0) await dormir(falta);
  ultimoPedido = Date.now();
}

/** ExigirCaptcha / HayError no se cachean y no rompen la ficha. */
export function enCaptcha() {
  return Date.now() < captchaHasta;
}

export function resetCaptcha() { captchaHasta = 0; }

export function captchaRestanteMs() {
  return Math.max(0, captchaHasta - Date.now());
}

function urlWorker(url, o = {}) {
  const q = new URLSearchParams({ u: String(url) });
  if (o.metodo) q.set('m', String(o.metodo).toUpperCase());
  if (o.cuerpo !== undefined && o.cuerpo !== null) q.set('b', String(o.cuerpo));
  if (o.ct) q.set('ct', o.ct);
  if (o.cookie) q.set('cookie', o.cookie);
  if (o.manual) q.set('r', 'manual');
  if (o.headers && Object.keys(o.headers).length) q.set('h', JSON.stringify(o.headers));
  q.set('token', tokenWorker());
  return WORKER + '?' + q.toString();
}

/**
 * Una llamada al Worker (con 1 reintento ante 0/5xx). Nunca lanza por red.
 * @returns {Promise<{status:number, headers:Object<string,string>, texto:string}>}
 */
export async function pedir(url, o = {}) {
  const destino = urlWorker(url, o);
  const ms = Number(o.timeoutMs || TIMEOUT_MS);
  let ultimo = { status: 0, headers: {}, texto: 'ERR sin intento' };
  for (let intento = 1; intento <= 2; intento++) {
    try {
      await esperarTurno();
      const r = await fetch(destino, { signal: AbortSignal.timeout(ms) });
      const headers = {};
      r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      ultimo = { status: r.status, headers, texto: await r.text() };
    } catch (e) {
      ultimo = {
        status: 0,
        headers: {},
        texto: 'ERR ' + ((e && e.cause && e.cause.code) || (e && e.message) || String(e)),
      };
    }
    const reintentable = ultimo.status === 0 || ultimo.status === 408 || ultimo.status === 429 || ultimo.status >= 500;
    if (!reintentable || intento === 2) break;
    await dormir(300 + Math.floor(Math.random() * 200));
  }
  return ultimo;
}

/* -------------------------------- cookies -------------------------------- */
/** Cookies de una respuesta del Worker.
 *  Prioriza x-set-cookie-json (array exacto); si no esta, parte x-set-cookie.
 *  El split viejo es seguro con "Expires=Wed, 22 Oct...", pero el array es
 *  la unica forma de no perder cookies cuando hay varias. */
export function cookiesDe(headers = {}) {
  const raw = headers['x-set-cookie-json'];
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter(Boolean);
    } catch (_) {}
  }
  const una = headers['x-set-cookie'] || '';
  return una ? una.split(/,(?=[^;,]+=)/).map((s) => s.trim()).filter(Boolean) : [];
}

function juntarCookies(...partes) {
  const lista = [];
  for (const p of partes) {
    if (!p) continue;
    if (Array.isArray(p)) lista.push(...p);
    else if (typeof p === 'string') lista.push(...p.split(/,(?=[^;]+=)/));
  }
  const m = new Map();
  for (const par of lista) {
    const kv = String(par).split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) m.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  return [...m.entries()].map(([k, v]) => k + '=' + v).join('; ');
}

const tituloHtml = (s) => (((String(s).match(/<title>([^<]*)<\/title>/i) || [, ''])[1] || '').trim());
const esLogin = (r) => {
  if (!r) return false;
  if (r.status === 302 && /auth\.nosis\.com/i.test(r.headers['x-location'] || '')) return true;
  if (/auth\.nosis\.com/i.test(r.headers['x-final'] || '')) return true;
  return /Acceso a tu cuenta/i.test(tituloHtml(r.texto));
};

/* -------------------------------- sesion --------------------------------- */
export function leerSesion() {
  try {
    const j = JSON.parse(fs.readFileSync(RUTA_SESION, 'utf8'));
    if (!j || !j.cookie) return null;
    return j;
  } catch (_) {
    return null;
  }
}

export function guardarSesion(cookie, extra = {}) {
  const j = {
    cookie,
    cuando: ahora(),
    urlRetorno: extra.urlRetorno || INFORMES + '/',
    ...(extra.redirect ? { redirect: extra.redirect } : {}),
    ...(extra.usuario ? { usuario: extra.usuario } : {}),
  };
  fs.mkdirSync(path.dirname(RUTA_SESION), { recursive: true });
  fs.writeFileSync(RUTA_SESION, JSON.stringify(j, null, 2), { mode: 0o600 });
  return j;
}

/* Cooldown de login persistido en archivo (no un sleep bloqueante): sobrevive
 * reinicios y el usuario puede ver exactamente hasta cuando no se reintenta. */
export function leerCooldown() {
  try {
    const j = JSON.parse(fs.readFileSync(RUTA_COOLDOWN, 'utf8'));
    if (!j || !j.hasta) return null;
    return j;
  } catch (_) {
    return null;
  }
}

function guardarCooldown(motivo, ms) {
  const hasta = new Date(Date.now() + ms).toISOString();
  try {
    fs.mkdirSync(path.dirname(RUTA_COOLDOWN), { recursive: true });
    fs.writeFileSync(RUTA_COOLDOWN, JSON.stringify({ motivo: String(motivo), hasta, creado: ahora() }, null, 2), { mode: 0o600 });
  } catch (_) {}
}

function borrarCooldown() {
  try { fs.unlinkSync(RUTA_COOLDOWN); } catch (_) {}
}

export function cooldown() {
  const c = leerCooldown();
  if (!c) return null;
  return { ...c, activo: Date.parse(c.hasta) > Date.now(), restanteMs: Math.max(0, Date.parse(c.hasta) - Date.now()) };
}

/**
 * Login automatico. Flujo real de la SPA de auth.nosis.com:
 *   POST /ui/login      {usuario, urlRetorno} -> {state, redirect}
 *   POST /ui/login-pwd  {state, clave}        -> {redirect}
 * Luego siguen el redirect para asentar la sesion y se arrastran los set-cookie.
 */
export async function login(opts = {}) {
  const usuario = opts.usuario || valor('NOSIS_USER');
  const clave = opts.clave || valor('NOSIS_PASS');
  const urlRetorno = opts.urlRetorno || INFORMES + '/';
  if (!usuario || !clave) throw new Error('faltan NOSIS_USER/NOSIS_PASS en datos/server.env');

  try {
    const extra = {
      origin: AUTH,
      referer: AUTH + '/login',
      accept: 'application/json, text/plain, */*',
    };

    const r1 = await pedir(AUTH + '/ui/login', {
      metodo: 'POST',
      ct: 'application/json',
      cuerpo: JSON.stringify({ usuario, urlRetorno }),
      manual: true,
      headers: extra,
      timeoutMs: opts.timeoutMs,
    });
    let cookie = juntarCookies(cookiesDe(r1.headers));
    let datos = {};
    try { datos = JSON.parse(r1.texto) || {}; } catch (_) {}
    if (r1.status !== 200 || (!datos.state && !datos.redirect)) {
      const detalle = (datos && (datos.detail || datos.title)) || r1.texto.replace(/\s+/g, ' ').slice(0, 200);
      throw new Error('login paso 1 fallo: http=' + r1.status + ' ' + detalle);
    }

    let redirect = datos.redirect || '';
    if (datos.state) {
      const r2 = await pedir(AUTH + '/ui/login-pwd', {
        metodo: 'POST',
        ct: 'application/json',
        cuerpo: JSON.stringify({ state: datos.state, clave }),
        cookie,
        manual: true,
        headers: { ...extra, referer: AUTH + '/login-pwd' },
        timeoutMs: opts.timeoutMs,
      });
      cookie = juntarCookies(cookie, cookiesDe(r2.headers));
      let d2 = {};
      try { d2 = JSON.parse(r2.texto) || {}; } catch (_) {}
      if (r2.status !== 200) {
        const detalle = (d2 && (d2.detail || d2.title)) || r2.texto.replace(/\s+/g, ' ').slice(0, 200);
        throw new Error('login paso 2 fallo: http=' + r2.status + ' ' + detalle);
      }
      redirect = d2.redirect || redirect;
    }

    /* Asentar la sesion en el destino (informes) y arrastrar sus cookies. */
    const destino = redirect || urlRetorno;
    const r3 = await pedir(destino, { cookie, manual: true, timeoutMs: opts.timeoutMs });
    cookie = juntarCookies(cookie, cookiesDe(r3.headers));

    guardarSesion(cookie, { urlRetorno, redirect, usuario });
    borrarCooldown();
    return cookie;
  } catch (e) {
    guardarCooldown(String(e?.message || e), ESPERA_FALLO_MS);
    throw e;
  }
}

/** Cookie de sesion; hace login si el archivo falta o vencio.
 *  Si el login falla, no se reintenta hasta que pase el cooldown EN ARCHIVO
 *  (datos/nosis-cooldown.json), para no bloquear la cuenta por martilleo. */
const ESPERA_FALLO_MS = Number(process.env.NOSIS_ESPERA_FALLO_MS || 5 * 60 * 1000);

export async function sesion(opts = {}) {
  const s = leerSesion();
  if (s && !opts.forzar && edadDias(s.cuando) <= TTL_SESION_DIAS) return s.cookie;
  if (!opts.ignorarCooldown) {
    const c = leerCooldown();
    if (c && Date.parse(c.hasta) > Date.now()) {
      throw new Error((c.motivo || 'login fallido') + ' (cooldown hasta ' + c.hasta + '; borrar datos/nosis-cooldown.json para reintentar)');
    }
  }
  return login({ urlRetorno: s?.urlRetorno, ...opts });
}

/* -------------------------------- busqueda ------------------------------- */
function esVacia(json) {
  const e = json && Array.isArray(json.EntidadesEncontradas) ? json.EntidadesEncontradas : null;
  return !e || e.length === 0;
}

export function leerBusqueda(texto) {
  try {
    const fila = abrir().prepare('SELECT json, creado FROM nosis_busqueda WHERE texto = ?').get(String(texto));
    if (!fila) return null;
    let json = null;
    try { json = JSON.parse(fila.json); } catch (_) { return null; }
    const ttl = esVacia(json) ? TTL_VACIO_DIAS : TTL_BUSQUEDA_DIAS;
    if (edadDias(fila.creado) > ttl) return null;
    return json;
  } catch (_) {
    return null;
  }
}

export function guardarBusqueda(texto, json) {
  try {
    abrir().prepare(`INSERT INTO nosis_busqueda (texto, json, creado) VALUES (?,?,?)
      ON CONFLICT(texto) DO UPDATE SET json=excluded.json, creado=excluded.creado`)
      .run(String(texto), JSON.stringify(json), ahora());
  } catch (_) {}
}

/**
 * POST /Home/Buscar. Acepta DNI pelado, apellido o CUIT.
 * Cachea tambien los resultados vacios (TTL corto). Nunca lanza.
 */
export async function consultar(texto, opts = {}) {
  const clave = String(texto ?? '').trim();
  if (!clave) return { HayError: true, EntidadesEncontradas: [], motivo: 'texto vacio' };
  const cache = opts.forzar ? null : leerBusqueda(clave);
  if (cache) return cache;
  if (opts.sinRed) return { HayError: true, EntidadesEncontradas: [], motivo: 'sin red' };

  /* Nosis pidio captcha hace poco: no insistir, la ficha sigue con cache. */
  if (enCaptcha()) {
    return { HayError: false, ExigirCaptcha: true, EntidadesEncontradas: [], motivo: 'captcha en espera' };
  }

  const r = await pedir(INFORMES + '/Home/Buscar', {
    metodo: 'POST',
    ct: 'application/x-www-form-urlencoded; charset=UTF-8',
    cuerpo: new URLSearchParams({ 'Busqueda.Texto': clave }).toString(),
    headers: {
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json, text/plain, */*',
      referer: INFORMES + '/',
    },
    timeoutMs: opts.timeoutMs,
  });
  let json = null;
  try { json = JSON.parse(r.texto); } catch (_) {}
  if (!json || typeof json !== 'object') {
    return { HayError: true, EntidadesEncontradas: [], motivo: 'http=' + r.status + ' respuesta no-JSON' };
  }

  /* Captcha o error del sitio: NO se cachea como si fuera "sin resultados"
   * (eso envenenaria la cache 7 dias). Se devuelve tal cual y la ficha sigue. */
  if (json.ExigirCaptcha === true) {
    captchaHasta = Date.now() + Number(process.env.NOSIS_CAPTCHA_ESPERA_MS ?? 15 * 60 * 1000);
    return { ...json, EntidadesEncontradas: [], motivo: 'captcha' };
  }
  if (json.HayError === true) return json;

  guardarBusqueda(clave, json);
  return json;
}

/* -------------------------------- informe -------------------------------- */
export function leerInforme(cuit11) {
  try {
    const fila = abrir().prepare('SELECT html, creado FROM nosis_informe WHERE documento = ?').get(String(cuit11).replace(/\D/g, ''));
    if (!fila) return null;
    if (edadDias(fila.creado) > TTL_INFORME_DIAS) return null;
    return fila.html;
  } catch (_) {
    return null;
  }
}

export function guardarInforme(cuit11, html) {
  try {
    const doc = String(cuit11).replace(/\D/g, '');
    abrir().prepare(`INSERT INTO nosis_informe (documento, html, creado, dni) VALUES (?,?,?,?)
      ON CONFLICT(documento) DO UPDATE SET html=excluded.html, creado=excluded.creado, dni=excluded.dni`)
      .run(doc, String(html), ahora(), doc.length === 11 ? doc.slice(2, 10) : null);
  } catch (_) {}
}

/**
 * GET del informe con sesion. Si Nosis devuelve el login, re-loguea una vez.
 * Devuelve el HTML o null. Nunca lanza.
 */
export async function informe(cuit11, opts = {}) {
  const doc = String(cuit11 ?? '').replace(/\D/g, '');
  if (!doc) return null;
  if (!opts.forzar) {
    const cache = leerInforme(doc);
    if (cache) return cache;
  }
  if (enCaptcha()) return null;

  const url = URL_INFORME_BASE + doc;
  let cookie = '';
  try { cookie = await sesion(); } catch (_) { return null; }

  let r = await pedir(url, { cookie, manual: true, timeoutMs: opts.timeoutMs });

  if (esLogin(r)) {
    try {
      cookie = await sesion({ forzar: true });
      r = await pedir(url, { cookie, manual: true, timeoutMs: opts.timeoutMs });
    } catch (_) {
      return null;
    }
  }

  /* Un 302 propio de informes se sigue a mano una vez. */
  if (r.status === 302 && r.headers['x-location']) {
    const loc = new URL(r.headers['x-location'], INFORMES).toString();
    cookie = juntarCookies(cookie, cookiesDe(r.headers));
    r = await pedir(loc, { cookie, manual: true, timeoutMs: opts.timeoutMs });
  }

  if (r.status !== 200 || esLogin(r)) return null;
  if (!/DOMICILIO|NACIMIENTO|APELLIDO|DENOMINACION|CUIT|DOCUMENTO|LOCALIDAD|PROVINCIA/i.test(r.texto)) return null;

  guardarInforme(doc, r.texto);
  return r.texto;
}

/* ------------------------------ interpretacion ---------------------------- */
/** 8 digitos del medio de un CUIT (nunca usar Documento crudo como DNI). */
export function extraerDni(documento) {
  const d = String(documento ?? '').replace(/\D/g, '');
  if (d.length === 11) return d.slice(2, 10);
  if (d.length === 8) return d;
  if (d.length > 10) return d.slice(2, 10);
  return d ? d.padStart(8, '0') : null;
}

/** Primera entidad de la busqueda. Devuelve null si no hay. */
export function interpretarNosis(json) {
  let j = json;
  if (typeof j === 'string') {
    try { j = JSON.parse(j); } catch (_) { return null; }
  }
  const e = j && Array.isArray(j.EntidadesEncontradas) ? j.EntidadesEncontradas[0] : null;
  if (!e) return null;
  const cuit = String(e.Documento ?? '').replace(/\D/g, '') || null;
  return {
    cuit,
    dni: cuit ? extraerDni(cuit) : null,
    razonSocial: limpiar(e.RazonSocial),
    /* Nombre para mostrar: string COMPLETO, sin partir apellido/nombre. */
    nombreCompleto: limpiar(e.RazonSocial),
    actividad: limpiar(e.Actividad),
    provincia: limpiar(e.Provincia),
    urlInforme: limpiar(e.UrlInforme),
  };
}

function limpiar(v) {
  const s = v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim();
  return s || null;
}

/* ------------------------- lectura del HTML del informe ------------------- */
const RE_ETIQUETA = /(DOMICILIO|DOMICILIOS?|LOCALIDAD|CIUDAD|PROVINCIA|FECHA DE NACIMIENTO|NACIMIENTO|APELLIDO Y NOMBRE|APELLIDO|NOMBRES?|DENOMINACION|RAZON SOCIAL|CUIT|DOCUMENTO|ACTIVIDAD)/i;

/** Pasa HTML a lineas de texto plano (sin scripts/styles). */
export function lineasDe(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(tr|div|p|li|h[1-6]|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').replace(/\s*\|\s*/g, ' | ').trim())
    .filter(Boolean);
}

/** valor que sigue a una etiqueta en la misma linea o en la siguiente. */
function trasEtiqueta(lineas, etiqueta) {
  const re = new RegExp('^\\s*' + etiqueta + '\\s*[:|]?\\s*(.*)$', 'i');
  for (let i = 0; i < lineas.length; i++) {
    const m = lineas[i].match(re);
    if (!m) continue;
    const resto = (m[1] || '').replace(/^[|\-:\s]+/, '').trim();
    if (resto) return resto;
    for (let j = i + 1; j < Math.min(i + 4, lineas.length); j++) {
      const sig = lineas[j].replace(/^[|\-:\s]+/, '').trim();
      if (sig && !RE_ETIQUETA.test(sig)) return sig;
    }
  }
  return null;
}

const CODIGOS_POSTALES = /\b([A-Z]?\d{4}[A-Z]{0,3})\b/;

/**
 * Extrae los datos utiles del HTML del informe comercial.
 * Devuelve {nombre, domicilio, ciudad, provincia, cpostal, fechaNac, actividad}
 * con null en lo que no aparezca. Best-effort: el HTML de Nosis cambia.
 */
export function parsearInforme(html) {
  const lineas = lineasDe(html);
  const out = {
    nombre: null,
    domicilio: null,
    ciudad: null,
    provincia: null,
    cpostal: null,
    fechaNac: null,
    actividad: null,
  };
  if (!lineas.length) return out;

  out.nombre = trasEtiqueta(lineas, 'APELLIDO Y NOMBRE') || trasEtiqueta(lineas, 'DENOMINACION') ||
    trasEtiqueta(lineas, 'RAZON SOCIAL');
  if (!out.nombre) {
    const ap = trasEtiqueta(lineas, 'APELLIDO');
    const nom = trasEtiqueta(lineas, 'NOMBRES?');
    out.nombre = [ap, nom].filter(Boolean).join(' ') || null;
  }

  let dom = trasEtiqueta(lineas, 'DOMICILIO');
  if (dom) {
    /* Quitar CP pegado al final: "Av. X 123 (C1425ABC)" o "Av. X 123 C1425ABC" */
    const m = dom.match(/^(.*?)[\s,]*\(?([A-Z]?\d{4}[A-Z]{0,3})\)?\s*$/i);
    if (m && m[1]) {
      out.domicilio = m[1].replace(/[\s,]+$/, '');
      out.cpostal = m[2];
    } else {
      out.domicilio = dom;
      out.cpostal = (dom.match(CODIGOS_POSTALES) || [null])[0];
    }
  }
  out.ciudad = trasEtiqueta(lineas, 'LOCALIDAD') || trasEtiqueta(lineas, 'CIUDAD');
  out.provincia = trasEtiqueta(lineas, 'PROVINCIA');
  out.actividad = trasEtiqueta(lineas, 'ACTIVIDAD');

  const nac = trasEtiqueta(lineas, 'FECHA DE NACIMIENTO') || trasEtiqueta(lineas, 'NACIMIENTO');
  if (nac) {
    const m = nac.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
    if (m) out.fechaNac = `${String(m[1]).padStart(2, '0')}/${String(m[2]).padStart(2, '0')}/${m[3]}`;
  }

  return out;
}

/* ---------------------- datos Nosis para una persona ---------------------- */
/** CUITs del padron para un DNI (para encontrar un informe cacheado). */
function cuitsDeDni(dni) {
  const d = String(dni ?? '').replace(/\D/g, '');
  if (!d) return [];
  try {
    return abrir().prepare('SELECT cuit FROM personas WHERE dni = ? ORDER BY cuit LIMIT 5').all(d).map((r) => r.cuit).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Datos Nosis SOLO desde cache (sin red). Pensado para lib/persona.js::real(),
 * que es sincronica. Devuelve {} si no hay nada cacheado.
 */
export function cacheDeDni(dni) {
  const d = String(dni ?? '').replace(/\D/g, '');
  if (!d) return {};
  /* Camino directo: indice por dni (no depende de personas). */
  try {
    const fila = abrir().prepare('SELECT documento, html, creado FROM nosis_informe WHERE dni = ? ORDER BY creado DESC LIMIT 1').get(d);
    if (fila && edadDias(fila.creado) <= TTL_INFORME_DIAS) {
      const p = parsearInforme(fila.html);
      if (p.nombre || p.domicilio || p.ciudad || p.provincia) {
        return { ...p, cuit: fila.documento, fuente: 'NOSIS', origen: 'CACHE' };
      }
    }
  } catch (_) {}
  for (const cuit of cuitsDeDni(d)) {
    const html = leerInforme(cuit);
    if (!html) continue;
    const p = parsearInforme(html);
    if (p.nombre || p.domicilio || p.ciudad || p.provincia) {
      return { ...p, cuit, fuente: 'NOSIS', origen: 'CACHE' };
    }
  }
  /* Sin informe (sin sesion) igual sirve la busqueda: nombre y provincia
   * salen publicos. Asi la ficha puede mostrar NOSIS sin esperar login. */
  const busqueda = leerBusqueda(d);
  const ent = interpretarNosis(busqueda);
  if (ent && ent.cuit) {
    return {
      nombre: null,
      nombreCompleto: ent.razonSocial,
      razonSocial: ent.razonSocial,
      actividad: ent.actividad,
      provincia: ent.provincia,
      cuit: ent.cuit,
      fuente: 'NOSIS',
      origen: 'BUSQUEDA',
    };
  }
  return {};
}

/**
 * Consulta Nosis para un DNI: busqueda -> informe -> parseo.
 * {red:false} solo mira cache. {red:true} sale por el Worker.
 * Nunca lanza.
 */
export async function datosDeDni(dni, opts = {}) {
  const d = String(dni ?? '').replace(/\D/g, '');
  if (!d) return {};
  if (!opts.red) return cacheDeDni(d);
  if (enCaptcha()) return cacheDeDni(d);

  const json = await consultar(d, { timeoutMs: opts.timeoutMs, forzar: opts.forzar === true });
  const ent = interpretarNosis(json);
  if (!ent || !ent.cuit) return cacheDeDni(d);

  let p = {};
  const html = await informe(ent.cuit, { forzar: opts.forzar === true, timeoutMs: opts.timeoutMs });
  if (html) p = parsearInforme(html);

  const out = {
    ...p,
    cuit: ent.cuit,
    razonSocial: ent.razonSocial,
    /* RazonSocial se conserva completa: no se parte por espacios porque
     * "De la Cruz" / "Fernandez Garcia" rompen cualquier split ingenuo. */
    nombreCompleto: p.nombre || ent.razonSocial,
    actividad: p.actividad || ent.actividad,
    provincia: p.provincia || ent.provincia,
    fuente: 'NOSIS',
    origen: html ? 'REMOTO' : 'BUSQUEDA',
  };
  const util = ['nombre', 'razonSocial', 'nombreCompleto', 'domicilio', 'ciudad', 'provincia'];
  if (!util.some((k) => out[k])) return cacheDeDni(d);
  return out;
}

export const TTL = {
  busqueda: TTL_BUSQUEDA_DIAS,
  vacio: TTL_VACIO_DIAS,
  informe: TTL_INFORME_DIAS,
  sesion: TTL_SESION_DIAS,
};

/* Crear las tablas al cargar el modulo: si alguien levanta el proyecto desde
 * cero y abre una ficha, no puede explotar por "no such table". */
try { abrir(); } catch (_) {}
