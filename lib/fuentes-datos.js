/* fuentes-datos.js — capa de datos publicos por DNI (padrones, AFIP, RENABAP).
 *
 * Tabla fuentes_personas(dni, campo, valor, fuente, fecha_alta, lote_id).
 * Una fila por (dni, campo, fuente); se puede recargar el mismo archivo sin
 * duplicar. La prioridad entre fuentes se resuelve al leer.
 *
 * NO reemplaza a personas/renaper/nosis: es una capa mas que lib/persona.js
 * consulta para completar campos que las fuentes locales no tengan.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as renaper from './renaper.js';

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');

export const CAMPOS = ['dni', 'apellido', 'nombre', 'nombreCompleto', 'fechaNac', 'anioNac', 'domicilio',
  'ciudad', 'provincia', 'cpostal', 'sexo', 'cuit', 'nroTramite', 'telefono', 'mail'];

/* Menor numero = mayor prioridad. Las bases publicas van antes que las APIs
 * pagas/comerciales, pero despues de RENAPER/CNE (que se consultan aparte). */
export const PRIORIDAD = {
  PADRON: 10,
  AFIP_CONSTANCIA: 20,
  RENABAP: 30,
  RENAPER: 40,
  NOSIS: 50,
  API: 60,
};

export function prioridad(fuente) {
  const f = String(fuente || '').toUpperCase();
  if (PRIORIDAD[f] != null) return PRIORIDAD[f];
  if (f.startsWith('PADRON')) return PRIORIDAD.PADRON;
  if (f.startsWith('RENAPER')) return PRIORIDAD.RENAPER;
  if (f.startsWith('NOSIS')) return PRIORIDAD.NOSIS;
  return 100;
}

let db = null;
function abrir() {
  if (db) return db;
  fs.mkdirSync(path.dirname(RUTA_DB), { recursive: true });
  db = new DatabaseSync(RUTA_DB);
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec(`CREATE TABLE IF NOT EXISTS fuentes_personas (
    dni TEXT NOT NULL,
    campo TEXT NOT NULL,
    valor TEXT,
    fuente TEXT NOT NULL,
    fecha_alta TEXT NOT NULL,
    lote_id TEXT,
    precision TEXT,
    PRIMARY KEY (dni, campo, fuente)
  )`);
  try { db.exec('ALTER TABLE fuentes_personas ADD COLUMN precision TEXT'); } catch (_) {}
  db.exec('CREATE INDEX IF NOT EXISTS idx_fp_dni ON fuentes_personas(dni)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_fp_campo ON fuentes_personas(campo)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_fp_fuente ON fuentes_personas(fuente)');
  db.exec(`CREATE TABLE IF NOT EXISTS fuentes_lotes (
    id TEXT PRIMARY KEY, fuente TEXT, archivo TEXT, filas INTEGER, ok INTEGER,
    creado TEXT, meta TEXT
  )`);
  return db;
}

export function asegurar() {
  try { abrir(); return true; } catch (_) { return false; }
}

const limpiar = (v) => {
  const s = v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim();
  return s || null;
};

/** Normaliza valores especiales (DNI, fecha, sexo). */
export function normalizarCampo(campo, valor) {
  const v = limpiar(valor);
  if (!v) return null;
  switch (campo) {
    case 'dni': {
      const digits = v.replace(/\D/g, '');
      if (digits.length < 6) return null;
      return renaper.normalizarDni(digits);
    }
    case 'fechaNac': return renaper.normalizarFecha(v);
    case 'anioNac': {
      const m = v.match(/\b(19\d{2}|20\d{2})\b/);
      return m ? m[1] : null;
    }
    case 'sexo': {
      const s = v.toUpperCase();
      if (s.startsWith('M')) return 'M';
      if (s.startsWith('F')) return 'F';
      if (s === 'X') return 'X';
      return null;
    }
    case 'cuit': return v.replace(/\D/g, '') || null;
    case 'nroTramite': return v.replace(/\D/g, '') || null;
    default: return v;
  }
}

/**
 * Guarda filas normalizadas {dni, campo, valor}. Idempotente.
 * @param {Array<{dni:string, campo:string, valor:string}>} filas
 * @param {{fuente:string, lote?:string, archivo?:string, dry?:boolean, loteTam?:number}} opts
 */
export function guardar(filas, opts = {}) {
  const fuente = String(opts.fuente || '').trim().toUpperCase();
  if (!fuente) throw new Error('falta --fuente');
  const lote = opts.lote || (fuente + '-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
  const res = { fuente, lote, total: filas.length, ok: 0, invalidas: 0, sinDni: 0, dry: opts.dry === true, muestra: [] };
  if (res.dry) {
    for (const f of filas.slice(0, 10)) res.muestra.push(f);
    res.ok = filas.filter((f) => f.dni && f.campo && f.valor != null).length;
    res.invalidas = filas.length - res.ok;
    return res;
  }
  const d = abrir();
  const ins = d.prepare(`INSERT INTO fuentes_personas(dni, campo, valor, fuente, fecha_alta, lote_id, precision)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(dni, campo, fuente) DO UPDATE SET
      valor=excluded.valor, fecha_alta=excluded.fecha_alta, lote_id=excluded.lote_id, precision=excluded.precision`);
  const tam = Math.max(100, Number(opts.loteTam) || 2000);
  const fecha = new Date().toISOString();
  d.exec('BEGIN');
  try {
    for (const f of filas) {
      if (!f.dni || !f.campo || f.valor == null) { if (!f.dni) res.sinDni++; else res.invalidas++; continue; }
      const precision = f.precision || (f.campo === 'anioNac' ? 'anio' : (f.campo === 'fechaNac' ? 'dia' : null));
      ins.run(f.dni, f.campo, String(f.valor), fuente, fecha, lote, precision);
      res.ok++;
    }
    d.prepare('INSERT OR REPLACE INTO fuentes_lotes(id, fuente, archivo, filas, ok, creado, meta) VALUES(?,?,?,?,?,?,?)')
      .run(lote, fuente, opts.archivo || null, res.total, res.ok, fecha, JSON.stringify({ loteTam: tam }));
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
  return res;
}

/**
 * Lee todos los campos de un DNI, resolviendo por prioridad de fuente.
 * @returns {{valores:Object<string,string>, fuentes:Object<string,string>}}
 */
export function leer(dni) {
  const d = renaper.normalizarDni(dni);
  if (!d) return { valores: {}, fuentes: {}, precisiones: {} };
  try {
    const filas = abrir().prepare('SELECT campo, valor, fuente, fecha_alta, precision FROM fuentes_personas WHERE dni = ?').all(d);
    const mejores = {};
    for (const f of filas) {
      const p = prioridad(f.fuente);
      const actual = mejores[f.campo];
      if (!actual || p < actual.p || (p === actual.p && String(f.fecha_alta) > String(actual.fecha_alta))) {
        mejores[f.campo] = { valor: f.valor, fuente: f.fuente, p, fecha: f.fecha_alta, precision: f.precision || null };
      }
    }
    const valores = {};
    const fuentes = {};
    const precisiones = {};
    for (const [campo, m] of Object.entries(mejores)) {
      valores[campo] = m.valor;
      fuentes[campo] = m.fuente;
      if (m.precision) precisiones[campo] = m.precision;
    }
    return { valores, fuentes, precisiones };
  } catch (_) {
    return { valores: {}, fuentes: {}, precisiones: {} };
  }
}

export function stats() {
  try {
    const d = abrir();
    const porFuente = d.prepare('SELECT fuente, COUNT(*) n, COUNT(DISTINCT dni) dnis FROM fuentes_personas GROUP BY fuente ORDER BY n DESC').all();
    const total = d.prepare('SELECT COUNT(*) n FROM fuentes_personas').get().n;
    const dnis = d.prepare('SELECT COUNT(DISTINCT dni) n FROM fuentes_personas').get().n;
    const lotes = d.prepare('SELECT * FROM fuentes_lotes ORDER BY creado DESC LIMIT 20').all();
    return { total, dnis, porFuente, lotes };
  } catch (e) {
    return { total: 0, dnis: 0, porFuente: [], lotes: [], error: String(e?.message || e) };
  }
}

export default { asegurar, guardar, leer, stats, prioridad, normalizarCampo, CAMPOS };
