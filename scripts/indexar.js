/* indexar.js — agrega y llena apellido_norm / nombre_norm en personas.
 *
 * Idempotente: si las columnas ya existen y estan llenas, no reescribe nada.
 * Crea indices compuestos que empiezan por apellido_norm y nombre_norm para
 * que la busqueda por prefijo (LIKE 'X%') sea rapida sobre 5,6M filas.
 *
 * Uso: node scripts/indexar.js
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizarTexto } from '../lib/padron.js';

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');
const LOTE = 50000;

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
  if (!cols.includes('apellido_norm')) {
    db.exec('ALTER TABLE personas ADD COLUMN apellido_norm TEXT');
    console.log('+ columna apellido_norm');
  }
  if (!cols.includes('nombre_norm')) {
    db.exec('ALTER TABLE personas ADD COLUMN nombre_norm TEXT');
    console.log('+ columna nombre_norm');
  }

  const total = db.prepare('SELECT COUNT(*) n FROM personas').get().n;
  const pendientes = db.prepare(
    'SELECT COUNT(*) n FROM personas WHERE apellido_norm IS NULL OR nombre_norm IS NULL'
  ).get().n;

  console.log(`personas=${total} pendientes=${pendientes}`);
  if (pendientes > 0) {
    const sel = db.prepare(
      'SELECT rowid AS rid, apellido, nombre FROM personas WHERE apellido_norm IS NULL OR nombre_norm IS NULL ORDER BY rowid LIMIT ?'
    );
    const upd = db.prepare('UPDATE personas SET apellido_norm = ?, nombre_norm = ? WHERE rowid = ?');
    let hechas = 0;
    while (true) {
      const filas = sel.all(LOTE);
      if (!filas.length) break;
      db.exec('BEGIN');
      try {
        for (const f of filas) {
          upd.run(normalizarTexto(f.apellido), normalizarTexto(f.nombre), f.rid);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      hechas += filas.length;
      if (hechas % 500000 === 0 || hechas === pendientes) {
        console.log(`  ${hechas}/${pendientes}`);
      }
    }
  }

  console.log('creando indices...');
  db.exec('CREATE INDEX IF NOT EXISTS idx_apellido_norm ON personas(apellido_norm, nombre_norm, cuit)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_nombre_norm ON personas(nombre_norm, apellido_norm, cuit)');

  const conApellido = db.prepare('SELECT COUNT(*) n FROM personas WHERE apellido_norm IS NOT NULL').get().n;
  const conNombre = db.prepare('SELECT COUNT(*) n FROM personas WHERE nombre_norm IS NOT NULL').get().n;
  console.log(`LISTO: personas=${total} apellido_norm=${conApellido} nombre_norm=${conNombre}`);
  console.log('indices:', indices(db, 'personas').filter((n) => n.includes('_norm')).join(', ') || 'ninguno');
} finally {
  db.close();
}
