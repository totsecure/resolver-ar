/* ordenar.js — agrega y llena personas.orden con el hash estable de los lotes.
 *
 * Idempotente: si la columna ya existe y no quedan NULL, no recalcula nada.
 * El hash es EXACTAMENTE el que usaba /lote antes de este script, para que el
 * orden de los titulares no cambie. Despues crea idx_personas_orden para que
 * ORDER BY orden LIMIT/OFFSET responda en milisegundos.
 *
 * Uso: node scripts/ordenar.js
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HASH_DNI } from '../lib/lote.js';

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');
const LOTE = 500000;

function columnas(db, tabla) {
  try {
    return db.prepare(`SELECT name FROM pragma_table_info('${tabla}')`).all().map((c) => c.name);
  } catch (_) {
    return [];
  }
}

function indices(db, tabla) {
  try {
    return db.prepare(`SELECT name FROM pragma_index_list('${tabla}')`).all().map((i) => i.name);
  } catch (_) {
    return [];
  }
}

const db = new DatabaseSync(RUTA_DB);
try {
  db.exec('PRAGMA busy_timeout = 5000');

  const cols = columnas(db, 'personas');
  if (!cols.includes('orden')) {
    db.exec('ALTER TABLE personas ADD COLUMN orden INTEGER');
    console.log('+ columna orden');
  }

  const total = db.prepare('SELECT COUNT(*) n FROM personas').get().n;
  const pendientes = db.prepare('SELECT COUNT(*) n FROM personas WHERE orden IS NULL').get().n;
  const maxRowid = db.prepare('SELECT COALESCE(MAX(rowid), 0) n FROM personas').get().n;

  console.log(`personas=${total} pendientes=${pendientes}`);
  if (pendientes > 0) {
    const upd = db.prepare(
      `UPDATE personas SET orden = ${HASH_DNI} WHERE rowid > ? AND rowid <= ? AND orden IS NULL`
    );
    let hechas = 0;
    let desde = 0;
    while (desde < maxRowid) {
      const hasta = Math.min(desde + LOTE, maxRowid);
      db.exec('BEGIN');
      try {
        const r = upd.run(desde, hasta);
        db.exec('COMMIT');
        hechas += Number(r.changes || 0);
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      desde = hasta;
      if (hechas > 0 && (hechas % 500000 === 0 || hechas === pendientes)) {
        console.log(`  ${hechas}/${pendientes}`);
      }
    }
  }

  console.log('creando indice...');
  db.exec('CREATE INDEX IF NOT EXISTS idx_personas_orden ON personas(orden)');

  const conOrden = db.prepare('SELECT COUNT(*) n FROM personas WHERE orden IS NOT NULL').get().n;
  const nulos = db.prepare('SELECT COUNT(*) n FROM personas WHERE orden IS NULL').get().n;
  console.log(`LISTO: personas=${total} orden=${conOrden} nulos=${nulos}`);
  console.log('indices:', indices(db, 'personas').filter((n) => n.includes('orden')).join(', ') || 'ninguno');
} finally {
  db.close();
}
