/* argos-informe.js — informe NOSIS servido por ARGOS (extapi), sin login nuestro.
 *
 * ARGOS expone GET /api/v1/nosis/<dni> y devuelve el PDF del informe comercial.
 * Ese PDF trae SCORE, SITUACION BCRA, NSE, ENDEUDAMIENTO y situacion laboral.
 *
 * Se usa como RESPALDO: solo cuando el BCRA oficial no tiene el CUIL del DNI.
 * Verificado 2026-11-07 en 3 DNIs: reproduce el BCRA exacto (situacion y monto).
 *
 * ARGOS TARDA ~40-50s y NO cachea, asi que el informe NUNCA va sincronico:
 *   informeDeDni()  -> devuelve lo que hay en disco YA (o null) y refresca atras
 *   informeFresco() -> espera al resultado (para cuando no hay nada guardado)
 *
 * Nada de esto lanza: ante cualquier problema devuelve null / {}.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BASE } from './argos.js';

const TTL_MS = Number(process.env.ARGOS_INFORME_TTL_MS || 30 * 24 * 3600 * 1000);
const DIR = process.env.ARGOS_INFORME_DIR || path.join(process.env.RESOLVER_DB ? path.dirname(process.env.RESOLVER_DB) : 'datos', 'informes');

const ENVUELTOS = new Map(); // dni -> Promise en vuelo

function archivo(dni) { return path.join(DIR, dni + '.json'); }
function archivoPdf(dni) { return path.join(DIR, dni + '.pdf'); }

export function parsear(texto) {
  const L = String(texto || '').split('\n').map((s) => s.trim());
  const val = (e) => { const i = L.indexOf(e); return i >= 0 && i + 1 < L.length ? L[i + 1] : null; };
  const rx = (re) => { for (const l of L) { const m = l.match(re); if (m) return m; } return null; };
  const o = {
    nombre: null, cuil: null, score: null, situacionBcra: null, nse: null,
    endeudamiento: null, criterio: null, laboral: null, bureau: null, cheques: null,
  };
  const h = rx(/^Informe Individual\s*>\s*([\d-]{11,})\s*\|\s*(.+)$/);
  if (h) { o.cuil = h[1]; o.nombre = h[2].trim(); }
  o.score = val('SCORE');
  o.situacionBcra = val('SITUACIÓN BCRA');
  o.endeudamiento = val('ENDEUDAMIENTO');
  o.criterio = val('CRITERIOS DE ACEPTACIÓN');
  o.laboral = val('Situación laboral');
  const mNse = rx(/^Nivel Socioeconómico \(NSE\):\s*([A-E]\d)\b/);
  if (mNse) o.nse = mNse[1];
  const g = (re) => { const m = rx(re); return m ? m[1] : null; };
  o.bureau = g(/^Bureau de Crédito:\s*(.+)$/);
  o.cheques = g(/^Cheques rechazados:\s*(.+)$/);
  if (o.score != null && /^\d+$/.test(o.score)) o.score = Number(o.score);
  else if (o.score != null) o.score = null;
  if (!o.nombre && !o.situacionBcra) return null;
  return o;
}

function leer(dni) {
  try {
    const j = JSON.parse(fs.readFileSync(archivo(dni), 'utf8'));
    if (!j || !j.cuando) return null;
    return j;
  } catch (_) { return null; }
}

function guardar(dni, dato) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(archivo(dni), JSON.stringify({ cuando: Date.now(), dato }));
  } catch (_) {}
}

function bajarPdfDeDisco(dni) {
  try { return fs.readFileSync(archivoPdf(dni)); } catch (_) { return null; }
}

/* ARGOS tarda ~50s por informe y devuelve 429 ("Servicio Nosis ocupado") o 504
   ("Nosis tardo demasiado") cuando esta cargado. Medido 2026-11-07:
   ~1 pedido cada ~90s pasa limpio; mas seguido da 429. Ademas ARGOS CORTA SOLO
   a los 180s con 504, asi que esperar mas que eso no sirve de nada. */
const TIMEOUT_MS = Number(process.env.ARGOS_INFORME_TIMEOUT_MS || 190000);
const REINTENTOS = Number(process.env.ARGOS_INFORME_REINTENTOS || 2);
const ESPERA_MS = Number(process.env.ARGOS_INFORME_ESPERA_MS || 30000);
/* Si un DNI fallo, no se reintenta por este rato: evita que cada /scoring lo
   vuelva a encolar (y que un DNI que NOSIS no resuelve monopolice la cola). */
const PENALIDAD_MS = Number(process.env.ARGOS_INFORME_PENALIDAD_MS || 15 * 60 * 1000);

const fallidos = new Map(); // dni -> timestamp del ultimo fallo
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function traer(dni) {
  const url = BASE + '/api/v1/nosis/' + encodeURIComponent(dni);
  for (let i = 0; i < REINTENTOS; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const buf = Buffer.from(await r.arrayBuffer());
      log(dni, 'fetch', r.status, buf.length + 'B', buf.slice(0, 4).toString('latin1'));
      if (r.ok && buf.slice(0, 4).toString() === '%PDF') return buf;
      /* 429 y 504 se reintentan; un 400 (DNI invalido) no. */
      if (r.status !== 429 && r.status !== 504) return null;
    } catch (e) { log(dni, 'red', e && e.message); }
    if (i < REINTENTOS - 1) await dormir(ESPERA_MS);
  }
  return null;
}

async function extraerTexto(buf) {
  const { PDFParse } = await import('pdf-parse');
  const p = new PDFParse({ data: buf });
  try { return (await p.getText()).text; } finally { if (p.destroy) await p.destroy().catch(() => {}); }
}

/* ARGOS devuelve 429 si se le piden dos informes a la vez: el endpoint de NOSIS
   tarda ~50s y solo atiende uno. Por eso hay UNA cola global, de a un pedido. */
let cola = Promise.resolve();
function enFila(fn) {
  const p = cola.then(fn, fn);
  cola = p.then(() => {}, () => {});
  return p;
}

function log(...a) { if (process.env.ARGOS_INFORME_DEBUG === '1') console.log("[informe]", ...a); }

function refrescar(dni) {
  if (ENVUELTOS.has(dni)) return ENVUELTOS.get(dni);
  const p = enFila(async () => {
    try {
      /* Si fallo hace poco, ni lo intenta: un DNI que NOSIS no resuelve se
       * lleva 180s por vuelta y frena a todos los de atras. */
      const f = fallidos.get(dni);
      if (f && Date.now() - f < PENALIDAD_MS) { log(dni, 'penalado, salteo'); return null; }
      const buf = await traer(dni);
      log(dni, 'traer ->', buf ? buf.length + ' bytes' : 'null');
      if (!buf) { fallidos.set(dni, Date.now()); return null; }
      const dato = parsear(await extraerTexto(buf));
      log(dni, 'parsear ->', dato ? dato.nombre : 'null');
      if (!dato) { fallidos.set(dni, Date.now()); return null; }
      try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(archivoPdf(dni), buf); } catch (e) { log(dni, 'pdf err', e.message); }
      guardar(dni, dato);
      fallidos.delete(dni);
      log(dni, 'guardado');
      return dato;
    } catch (e) { log(dni, 'ERROR', e && e.message); fallidos.set(dni, Date.now()); return null; }
    finally { ENVUELTOS.delete(dni); }
  });
  ENVUELTOS.set(dni, p);
  return p;
}

/* Lo que ya se sabe, sin esperar. Si esta vencido, refresca atras. */
export function informeDeDni(dni) {
  const d = String(dni || '').replace(/\D/g, '');
  if (!d) return null;
  const j = leer(d);
  if (!j) return null;
  if (Date.now() - j.cuando > TTL_MS) refrescar(d).catch(() => {});
  return j.dato;
}

/* Espera al resultado (para el comando /informe, o si no hay nada cacheado). */
export async function informeFresco(dni) {
  const d = String(dni || '').replace(/\D/g, '');
  if (!d) return null;
  const j = leer(d);
  if (j && Date.now() - j.cuando < TTL_MS) return j.dato;
  return refrescar(d);
}

/* Dispara el pedido sin bloquear (para encolar desde /scoring). */
export function precalentar(dni) {
  const d = String(dni || '').replace(/\D/g, '');
  if (!d) return;
  const j = leer(d);
  if (j && Date.now() - j.cuando < TTL_MS) return;
  const f = fallidos.get(d);
  if (f && Date.now() - f < PENALIDAD_MS) { log(d, 'en penalidad, salteo'); return; }
  refrescar(d).catch(() => {});
}

export function pdfDeDni(dni) {
  const d = String(dni || '').replace(/\D/g, '');
  return d ? bajarPdfDeDisco(d) : null;
}

export default { informeDeDni, informeFresco, precalentar, pdfDeDni, parsear };
