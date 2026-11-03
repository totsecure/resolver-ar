/* argos.js - fuente real ARGOS (RENAPER   base local). Solo HTTP, por IP whitelisteada.
 * Nunca lanza: devuelve {fuente:'AUSENTE', motivo}.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as gordo from './gordo.js';

export const BASE = process.env.ARGOS_BASE || 'http://104.234.7.128:5100';
export const TTL_DIAS = Number(process.env.ARGOS_TTL_DIAS || 30);
const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');
const RUTA_PDF = path.join(RAIZ, 'datos', 'argos');
const RUTA_LOG = path.join(RAIZ, 'datos', 'argos.log');
let db = null;

function abrir() {
  if (db) return db;
  fs.mkdirSync(path.dirname(RUTA_DB), { recursive: true });
  db = new DatabaseSync(RUTA_DB);
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec('CREATE TABLE IF NOT EXISTS argos(dni TEXT PRIMARY KEY, fuente TEXT, json TEXT, capturado TEXT, ttl_dias INTEGER)');
  db.exec('CREATE TABLE IF NOT EXISTS argos_intentos(dni TEXT PRIMARY KEY, intentos INTEGER, ultimo TEXT, motivo TEXT)');
  return db;
}

function log(msg) {
  try { fs.appendFileSync(RUTA_LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch (_) {}
}

export function normalizarDni(v) {
  const s = String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
  return s.length >= 7 && s.length <= 9 ? s : null;
}

const marca = new Map();
const LIMITE = { local: 30, renaper: 30, nosis: 3 };
let nosisActivo = 0;

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function turno(tipo) {
  const max = LIMITE[tipo] || 30;
  for (;;) {
    const ahora = Date.now();
    const m = (marca.get(tipo) || []).filter((t) => ahora - t < 60000);
    marca.set(tipo, m);
    if (m.length < max) { m.push(ahora); return; }
    await esperar(1000);
  }
}

async function turnoNosis() {
  const desde = Date.now();
  while (nosisActivo >= 1) {
    if (Date.now() - desde > 45000) throw new Error('cola nosis 45s');
    await esperar(500);
  }
  nosisActivo += 1;
  await turno('nosis');
}

async function pedir(ruta, opts) {
  opts = opts || {};
  const timeout = Number(opts.timeout || 30000);
  const esperas = [5000, 15000];
  let ultimo = 'sin respuesta';
  for (let i = 1; i <= 3; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(BASE + ruta, { signal: ctrl.signal });
      if (r.status === 200) return { ok: true, r: r };
      if (r.status === 403) return { ok: false, motivo: 'IP no autorizada' };
      if (r.status === 404) return { ok: false, motivo: 'sin datos' };
      if (r.status === 400) return { ok: false, motivo: 'dni invalido' };
      if (r.status === 429 || r.status === 504) {
        ultimo = r.status === 429 ? 'rate limit' : 'timeout';
        if (i < 3) { await esperar(esperas[i - 1]); continue; }
        return { ok: false, motivo: ultimo };
      }
      return { ok: false, motivo: 'http ' + r.status };
    } catch (e) {
      ultimo = e && e.name === 'AbortError' ? 'timeout' : String(e && e.message ? e.message : e);
      if (i < 3) await esperar(esperas[i - 1]);
    } finally {
      clearTimeout(t);
    }
  }
  return { ok: false, motivo: ultimo };
}

export async function health() {
  const gh = await gordo.health();
  if (gh && gh.ok) return gh.json || { ok: true };
  if (process.env.ARGOS_OFICIAL !== '1') return { ok: false, motivo: gh && gh.motivo };
  const r = await pedir('/api/v1/health', { timeout: 10000 });
  if (!r.ok) return { ok: false, motivo: r.motivo };
  try { return await r.r.json(); } catch (_) { return { ok: true }; }
}
export function cacheDeDni(dniBruto) {
  const d = normalizarDni(dniBruto);
  if (!d) return null;
  try {
    const f = abrir().prepare('SELECT * FROM argos WHERE dni =?').get(d);
    if (!f) return null;
    const edad = (Date.now() - Date.parse(f.capturado)) / 86400000;
    if (!(edad <= (f.ttl_dias || TTL_DIAS))) return null;
    const j = JSON.parse(f.json || '{}');
    return Object.assign({ fuente: f.fuente }, j);
  } catch (_) { return null; }
}

function guardar(dni, tipo, data) {
  try {
    abrir().prepare('INSERT INTO argos(dni,fuente,json,capturado,ttl_dias) VALUES(?,?,?,?,?) ON CONFLICT(dni) DO UPDATE SET fuente=excluded.fuente, json=excluded.json, capturado=excluded.capturado, ttl_dias=excluded.ttl_dias').run(dni, tipo, JSON.stringify(data), new Date().toISOString(), TTL_DIAS);
    abrir().prepare('DELETE FROM argos_intentos WHERE dni =?').run(dni);
  } catch (_) {}
}

function anotar(dni, motivo) {
  try {
    abrir().prepare('INSERT INTO argos_intentos(dni,intentos,ultimo,motivo) VALUES(?,1,?,?) ON CONFLICT(dni) DO UPDATE SET intentos=intentos+1, ultimo=excluded.ultimo, motivo=excluded.motivo').run(dni, new Date().toISOString(), motivo);
  } catch (_) {}
  log(dni + ' ' + motivo);
}

const titulo = (s) => String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

function fechaBr(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : null;
}

function interpretar(tipo, d, dni) {
  const out = { fuente: tipo === 'renaper' ? 'ARGOS_RENAPER' : 'ARGOS_LOCAL', dni: dni };
  const nd = String(d.nombre_db || d.nombre_completo || '').trim();
  if (nd) {
    const partes = nd.split(/\s+/);
    if (partes.length > 1) { out.apellido = partes[0]; out.nombre = partes.slice(1).join(' '); }
    out.nombreCompleto = nd;
  }
  if (d.sexo) out.sexo = String(d.sexo).toUpperCase();
  out.fechaNac = fechaBr(d.fecha_nacimiento);
  if (d.cuil) out.cuit = String(d.cuil).replace(/\D/g, '');
  let dir = titulo(d.calle || d.direccion || d.direccion_actual);
  const num = String(d.numero || '').trim();
  if (num && dir && dir.indexOf(num) === -1) dir = dir + ' ' + num;
  if (d.piso) dir = (dir || '') + ' PISO ' + d.piso;
  if (d.departamento) dir = (dir || '') + ' DEPTO ' + d.departamento;
  out.direccion = dir ? dir.replace(/\s+/g, ' ').trim() : null;
  out.ciudad = titulo(d.localidad || d.ciudad);
  out.provincia = titulo(d.provincia);
  out.cpostal = d.codigo_postal ? String(d.codigo_postal).trim() : null;
  out.nroTramite = d.tramite_principal ? String(d.tramite_principal).trim() : null;
  out.fallecido = d.fallecido === true || String(d.fallecido) === 'true' || Number(d.fallecido) === 1;
  const tel = Array.isArray(d.telefonos_asociados) ? d.telefonos_asociados[0] : null;
  out.telefono = tel ? String(tel).trim() : null;
  out.mail = d.correo_electronico ? String(d.correo_electronico).trim().toLowerCase() : null;
  return out;
}
export async function datos(tipo, dniBruto, opts) {
  opts = opts || {};
  const d = normalizarDni(dniBruto);
  if (!d) return { fuente: 'AUSENTE', motivo: 'dni invalido' };
  if (!opts.forzar) {
    const c = cacheDeDni(d);
    if (c && c.fuente === (tipo === 'renaper' ? 'ARGOS_RENAPER' : 'ARGOS_LOCAL')) return c;
  }
  await turno(tipo);
  const r = await pedir('/api/v1/'+tipo+'/'+d, { timeout: 30000 });
  if (!r.ok) { anotar(d, r.motivo); return { fuente: 'AUSENTE', motivo: r.motivo }; }
  let j = null;
  try { j = await r.r.json(); } catch (_) {}
  if (!j || !j.ok) return { fuente: 'AUSENTE', motivo: 'respuesta invalida' };
  const data = interpretar(tipo, j.data || {}, d);
  guardar(d, data.fuente, data);
  return data;
}

export async function datosDeDni(dniBruto, opts) {
  opts = opts || {};
  const d = normalizarDni(dniBruto);
  if (!d) return {};
  if (opts.sinRed) return cacheDeDni(d) || {};
  const g = await gordo.datos(d);
  if (g && g.fuente && g.fuente !== 'AUSENTE') { guardar(d, g.fuente, g); return g; }
  if (process.env.ARGOS_OFICIAL !== '1') return { fuente: 'AUSENTE', motivo: (g && g.motivo) || 'sin datos' };
  const ren = await datos('renaper', d, opts);
  const loc = await datos('local', d, opts);
  const out = {};
  if (loc && loc.fuente !== 'AUSENTE') Object.assign(out, loc);
  if (ren && ren.fuente !== 'AUSENTE') Object.assign(out, ren);
  if (!Object.keys(out).length) return { fuente: 'AUSENTE', motivo: (ren.motivo || loc.motivo || 'sin datos') };
  return out;
}

export async function nosisPdf(dniBruto) {
  const d = normalizarDni(dniBruto);
  if (!d) return { fuente: 'AUSENTE', motivo: 'dni invalido' };
  try { await turnoNosis(); } catch (e) { return { fuente: 'AUSENTE', motivo: String(e.message) }; }
  try {
    const r = await pedir('/api/v1/nosis/'+d, { timeout: 190000 });
    if (!r.ok) { anotar(d, r.motivo); return { fuente: 'AUSENTE', motivo: r.motivo }; }
    const buf = Buffer.from(await r.r.arrayBuffer());
    fs.mkdirSync(RUTA_PDF, { recursive: true });
    const archivo = path.join(RUTA_PDF, d + '.pdf');
    fs.writeFileSync(archivo, buf);
    log(d + ' nosis pdf ' + buf.length);
    return { fuente: 'ARGOS_NOSIS', dni: d, archivo: archivo, bytes: buf.length };
  } catch (e) {
    return { fuente: 'AUSENTE', motivo: String(e && e.message ? e.message : e) };
  } finally {
    nosisActivo = Math.max(0, nosisActivo - 1);
  }
}

/* Limites declarados por ARGOS (seccion 2 de la doc):
 * /local y /renaper 30 por minuto por IP; /nosis 3 por minuto y UNA a la vez
 * (las demas esperan en cola hasta 45s). Al exceder: 429.
 * Esta funcion expone el estado real de los contadores en memoria.
 */
export function limites() {
  const ahora = Date.now();
  const uso = (t) => (marca.get(t) || []).filter((x) => ahora - x < 60000).length;
  return {
    local: { usados: uso('local'), max: LIMITE.local, ventana: '60s' },
    renaper: { usados: uso('renaper'), max: LIMITE.renaper, ventana: '60s' },
    nosis: { usados: uso('nosis'), max: LIMITE.nosis, ventana: '60s', enCurso: nosisActivo, concurrencia: 1 },
    ttlDias: TTL_DIAS,
   };
}

export function stats() {
  try {
    const d = abrir();
    return { cacheados: d.prepare('SELECT COUNT(*) n FROM argos').get().n, fallos: d.prepare('SELECT COUNT(*) n FROM argos_intentos').get().n };
  } catch (_) { return { cacheados: 0, fallos: 0 }; }
}

export default { BASE, normalizarDni, health, datos, datosDeDni, nosisPdf, cacheDeDni, stats, limites };
