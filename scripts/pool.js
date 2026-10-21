/* pool.js — pool de DNIs para /random.
 *
 * Tabla: pool_random(dni TEXT PRIMARY KEY, campos INTEGER, visto TEXT)
 *
 * - Sin argumentos: siembra 30123456 y 33456789 (idempotente).
 * - Con N: muestrea N DNIs al azar de personas y se queda con el top 10%
 *   (minimo 10) por cantidad de campos llenos.
 *
 * Uso:
 *   node scripts/pool.js
 *   node scripts/pool.js 500
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');
const SEEDS = ['30123456', '33456789'];

export function asegurarPool(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pool_random (
    dni    TEXT PRIMARY KEY,
    campos INTEGER NOT NULL DEFAULT 0,
    visto  TEXT
  )`);
}

/** Cuenta campos no vacios: 10 de personas + 4 de la cache renaper. */
export function contarCampos(db, dni) {
  let n = 0;
  try {
    const p = db.prepare(`SELECT apellido, nombre, denominacion, sucesion, ganancias, iva,
      monotributo, integrante_soc, empleador, actividad
      FROM personas WHERE dni = ? ORDER BY cuit LIMIT 1`).get(dni);
    if (p) {
      for (const v of Object.values(p)) {
        if (v !== null && v !== undefined && String(v).trim() !== '') n++;
      }
    }
  } catch (_) {}
  try {
    const r = db.prepare('SELECT fechaNac, direccion, ciudad, provincia FROM renaper WHERE dni = ?').get(dni);
    if (r) {
      for (const v of Object.values(r)) {
        if (v !== null && v !== undefined && String(v).trim() !== '') n++;
      }
    }
  } catch (_) {}
  return n;
}

function upsert(db, dni, campos) {
  db.prepare(`INSERT INTO pool_random (dni, campos, visto) VALUES (?,?,?)
    ON CONFLICT(dni) DO UPDATE SET campos = excluded.campos, visto = excluded.visto`)
    .run(dni, campos, new Date().toISOString());
}

/** Siembra los dos DNIs del simulador. Idempotente. */
export function sembrarPool(db, dnis = SEEDS) {
  asegurarPool(db);
  for (const dni of dnis) upsert(db, dni, contarCampos(db, dni));
  return dnis.length;
}

/** Muestrea N DNIs y guarda el top 10% (minimo 10) por campos. */
export function muestrear(db, n) {
  asegurarPool(db);
  const total = Number(n);
  if (!Number.isFinite(total) || total <= 0) return 0;

  const filas = db.prepare('SELECT dni FROM personas ORDER BY RANDOM() LIMIT ?').all(total);
  const puntuados = filas
    .map((f) => ({ dni: f.dni, campos: contarCampos(db, f.dni) }))
    .sort((a, b) => b.campos - a.campos);

  const corte = Math.max(10, Math.ceil(puntuados.length * 0.1));
  const elegidos = puntuados.slice(0, corte);
  for (const x of elegidos) upsert(db, x.dni, x.campos);
  return elegidos.length;
}

/** Elige al azar entre los del pool con mas campos. null si el pool esta vacio. */
export function elegirDelPool(db) {
  try {
    asegurarPool(db);
    const max = db.prepare('SELECT MAX(campos) m FROM pool_random').get().m;
    if (max === null || max === undefined) return null;
    const fila = db.prepare('SELECT dni FROM pool_random WHERE campos = ? ORDER BY RANDOM() LIMIT 1').get(max);
    return fila?.dni ?? null;
  } catch (_) {
    return null;
  }
}

/** DNI al azar de la tabla personas. */
export function randomAfip(db) {
  try {
    const fila = db.prepare('SELECT dni FROM personas ORDER BY RANDOM() LIMIT 1').get();
    return fila?.dni ?? null;
  } catch (_) {
    return null;
  }
}

/* ------------------------------ CLI ------------------------------ */
const esMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (esMain) {
  const db = new DatabaseSync(RUTA_DB);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    asegurarPool(db);
    const n = Number(process.argv[2] || 0);
    const seeds = sembrarPool(db);
    let extra = 0;
    if (n > 0) extra = muestrear(db, n);
    const total = db.prepare('SELECT COUNT(*) n FROM pool_random').get().n;
    console.log(`pool_random: ${seeds} seeds${n > 0 ? ` + ${extra} de ${n} muestreados` : ''} | filas=${total}`);
  } finally {
    db.close();
  }
}
