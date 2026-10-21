/* cobertura.js — cobertura poblacional del padron y DNIs ambiguos.
 *
 * Declaracion obligatoria: el padron AFIP tiene personas fisicas reales, pero NO
 * es el padron electoral completo. "No encontrado" es el caso NORMAL.
 *
 * - calcular(): detecta la tabla del padron (columnas cuit + dni, la de mas
 *   filas) y devuelve {tabla, personas, ambiguos, electores, coberturaPct,
 *   calculado}. El resultado se cachea 7 dias en datos/cobertura.json.
 * - lineaCobertura(): texto listo para pegar en un informe, declara cobertura,
 *   caso normal y ambiguos.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');
const RUTA_CACHE = path.join(RAIZ, 'datos', 'cobertura.json');
const ELECTORES = Number(process.env.ELECTORES || 35000000);
const TTL_MS = 7 * 86400000;

let memo = null;

function abrir() {
  const db = new DatabaseSync(RUTA_DB);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function tablas(db) {
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  } catch (_) {
    return [];
  }
}

/* El padron es la tabla con cuit + dni y mas filas. Nunca cne_* ni sqlite_*. */
function tablaPadron(db) {
  let mejor = null;
  for (const t of tablas(db)) {
    if (/^(cne|cne_intentos|sqlite_)/i.test(t)) continue;
    let cols;
    try {
      cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t).map((c) => c.name.toLowerCase());
    } catch (_) {
      continue;
    }
    if (!cols.includes('cuit') || !cols.includes('dni')) continue;
    let n = 0;
    try {
      n = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
    } catch (_) {
      continue;
    }
    if (!mejor || n > mejor.personas) mejor = { tabla: t, personas: n };
  }
  return mejor;
}

function ambiguosDe(db, tabla) {
  try {
    return db.prepare(`SELECT COUNT(*) n FROM (SELECT dni FROM "${tabla}" GROUP BY dni HAVING COUNT(*) > 1)`).get().n;
  } catch (_) {
    return 0;
  }
}

function leerCache() {
  try {
    const c = JSON.parse(fs.readFileSync(RUTA_CACHE, 'utf8'));
    if (!c || typeof c !== 'object') return null;
    if (!Number.isFinite(Date.parse(c.calculado))) return null;
    if (Date.now() - Date.parse(c.calculado) >= TTL_MS) return null;
    if (!Number.isFinite(c.personas) || c.personas <= 0) return null;
    return c;
  } catch (_) {
    return null;
  }
}

/**
 * Calcula (o lee de cache) la cobertura. Nunca lanza: si la DB falla devuelve
 * personas:0 y coberturaPct:0.
 * @param {boolean} [forzar]
 */
export function calcular(forzar = false) {
  if (memo && !forzar) return memo;
  if (!forzar) {
    const c = leerCache();
    if (c) { memo = c; return memo; }
  }

  let res = {
    tabla: null,
    personas: 0,
    ambiguos: 0,
    electores: ELECTORES,
    coberturaPct: 0,
    calculado: new Date().toISOString(),
  };

  let db = null;
  try {
    db = abrir();
    const info = tablaPadron(db);
    if (info) {
      res.tabla = info.tabla;
      res.personas = info.personas;
      res.ambiguos = ambiguosDe(db, info.tabla);
      res.coberturaPct = Number(((100 * info.personas) / ELECTORES).toFixed(2));
    }
  } catch (_) {
    /* DB no disponible: se declara 0, no se inventa nada. */
  } finally {
    try { db?.close(); } catch (_) {}
  }

  try {
    fs.mkdirSync(path.dirname(RUTA_CACHE), { recursive: true });
    fs.writeFileSync(RUTA_CACHE, JSON.stringify(res, null, 2));
  } catch (_) {}

  memo = res;
  return res;
}

const miles = (n) => Number(n || 0).toLocaleString('es-AR');

/** Texto de declaracion de cobertura. */
export function lineaCobertura() {
  const c = calcular();
  const millones = (c.electores / 1e6).toFixed(0);
  return [
    'COBERTURA POBLACIONAL DEL PADRON (declaracion obligatoria)',
    `- Personas fisicas reales en el padron${c.tabla ? ' (' + c.tabla + ')' : ''}: ${miles(c.personas)} sobre ~${millones}M electores => ${c.coberturaPct}%.`,
    '- No encontrado es el CASO NORMAL, no un error del resolver.',
    `- DNIs ambiguos (mismo DNI, mas de un CUIT): ${miles(c.ambiguos)}. El CUIT/CUIL se toma del padron, nunca se recalcula.`,
    '- Fuentes por campo: REAL_AFIP | REAL_CNE | DERIVADO | SINTETICO | AUSENTE.',
  ].join('\n');
}

export { ELECTORES, RUTA_DB, RUTA_CACHE };
