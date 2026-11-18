/* vehiculos.js - ficha de un dominio (patente) contra ARGOS/DNRPA.
 *
 * Endpoint de ARGOS: /api/v1/patente/<DOMINIO>. Devuelve titularidad registral,
 * transferencias 2024-2025, porcentajes de titularidad, domicilios declarados y
 * permisos notariales de conduccion (los DNI autorizados a manejar el auto).
 *
 * Dominio: 5 a 9 caracteres alfanumericos, sin espacios ni guiones. Formato
 * viejo (ABC123) y Mercosur (AB123CD) entran los dos.
 *
 * Nunca lanza: devuelve {fuente:'AUSENTE', motivo}.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pedirPatente } from './argos.js';

const TTL_DIAS = Number(process.env.VEHICULOS_TTL_DIAS || 20);
const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');
let db = null;

function abrir() {
  if (db) return db;
  fs.mkdirSync(path.dirname(RUTA_DB), { recursive: true });
  db = new DatabaseSync(RUTA_DB);
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec('CREATE TABLE IF NOT EXISTS vehiculos(dominio TEXT PRIMARY KEY, json TEXT, capturado TEXT)');
  return db;
}

/* Deja el dominio en mayusculas y solo A-Z0-9. Devuelve null si no es valido. */
export function normalizarDominio(v) {
  const s = String(v === null || v === undefined ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length < 5 || s.length > 9) return null;
  /* El formato valido es 3 letras + 3 digitos (viejo) o 2 letras 3 digitos 2
   * letras (Mercosur), o motos/maquinaria con 3 letras + 3 digitos + letra. */
  if (!/^[A-Z]{2,3}\d{3}[A-Z]{0,3}$/.test(s)) return null;
  return s;
}

function cacheDe(dom) {
  try {
    const f = abrir().prepare('SELECT * FROM vehiculos WHERE dominio =?').get(dom);
    if (!f) return null;
    if ((Date.now() - Date.parse(f.capturado)) / 86400000 > TTL_DIAS) return null;
    return JSON.parse(f.json || '{}');
  } catch (_) { return null; }
}

function guardar(dom, data) {
  try {
    abrir().prepare('INSERT INTO vehiculos(dominio,json,capturado) VALUES(?,?,?) ON CONFLICT(dominio) DO UPDATE SET json=excluded.json, capturado=excluded.capturado')
      .run(dom, JSON.stringify(data), new Date().toISOString());
  } catch (_) {}
}

/* Cuantas consultas vencieron y se guardaron, para /estado. */
export function stats() {
  try {
    const d = abrir();
    return { cacheados: d.prepare('SELECT COUNT(*) n FROM vehiculos').get().n };
  } catch (_) { return { cacheados: 0 }; }
}

export async function datosDeDominio(dominioBruto, opts) {
  opts = opts || {};
  const dom = normalizarDominio(dominioBruto);
  if (!dom) return { fuente: 'AUSENTE', motivo: 'dominio invalido' };

  if (!opts.forzar) {
    const c = cacheDe(dom);
    if (c) return c;
  }

  const r = await pedirPatente(dom);
  if (!r.ok) return { fuente: 'AUSENTE', motivo: r.motivo, dominio: dom };

  const j = r.data || {};
  /* ARGOS marca ok:false con el motivo cuando el dominio no esta en el registro
   * o cuando nos tiene en rate limit: hay que distinguirlo para no mentir. */
  if (j.ok === false) return { fuente: 'AUSENTE', motivo: j.error || 'sin datos', dominio: dom };

  const out = Object.assign({ fuente: 'ARGOS/DNRPA' }, j, { dominio: j.dominio || dom });
  guardar(dom, out);
  return out;
}

export default { datosDeDominio, normalizarDominio, stats };
