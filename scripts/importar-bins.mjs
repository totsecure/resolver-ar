#!/usr/bin/env node
/* importar-bins.mjs — normaliza el dataset binlist-data (CC BY 4.0) a datos/bins.db.
 *
 *   node scripts/importar-bins.mjs [ruta/bin.csv]
 *
 * Idempotente: reconstruye la tabla bins en una transacción. No toca stock.db.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = '/Users/bunker/resolver';
const CSV = process.argv[2] || process.env.BINS_CSV || path.join(RAIZ, 'refs', 'binlist-data-tech', 'bins.csv');
const DB = process.env.RESOLVER_BINS_DB || path.join(RAIZ, 'datos', 'bins.db');
const SUMMARY = path.join(path.dirname(CSV), 'summary.json');

if (!fs.existsSync(CSV)) {
  console.error('ERROR: no existe ' + CSV);
  process.exit(1);
}
fs.mkdirSync(path.dirname(DB), { recursive: true });

const marca = (v) => {
  const s = String(v || '').trim().toUpperCase();
  if (!s) return null;
  if (s === 'VISA') return 'Visa';
  if (s === 'MASTERCARD') return 'Master';
  if (s === 'AMERICAN EXPRESS' || s === 'AMEX') return 'Amex';
  if (s === 'DISCOVER') return 'Discover';
  if (s.startsWith('DINERS')) return 'Diners';
  if (s === 'JCB') return 'JCB';
  if (s === 'UNIONPAY') return 'UnionPay';
  return s.charAt(0) + s.slice(1).toLowerCase();
};
const tipo = (v) => {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'CREDIT' || s === 'CHARGE CARD') return 'CREDIT';
  if (s === 'DEBIT') return 'DEBIT';
  return null;
};
const nulo = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s ? s : null;
};

let datasetFecha = null;
try { datasetFecha = JSON.parse(fs.readFileSync(SUMMARY, 'utf8')).generated || null; } catch (_) {}

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout=8000');
db.exec('PRAGMA journal_mode=WAL');
db.exec('CREATE TABLE IF NOT EXISTS bins(bin TEXT PRIMARY KEY, marca TEXT, tipo TEXT, nivel TEXT, banco TEXT, pais TEXT, pais2 TEXT, moneda TEXT, fuente TEXT, actualizado TEXT)');
db.exec('CREATE INDEX IF NOT EXISTS idx_bins_marca ON bins(marca)');

let importadas = 0, descartadas = 0, sinBanco = 0, sinPais = 0;
const ins = db.prepare('INSERT INTO bins(bin,marca,tipo,nivel,banco,pais,pais2,moneda,fuente,actualizado) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bin) DO UPDATE SET marca=excluded.marca,tipo=excluded.tipo,nivel=excluded.nivel,banco=excluded.banco,pais=excluded.pais,pais2=excluded.pais2,moneda=excluded.moneda,fuente=excluded.fuente,actualizado=excluded.actualizado');

const rl = readline.createInterface({ input: fs.createReadStream(CSV), crlfDelay: Infinity });
let cabecera = null;
db.exec('BEGIN IMMEDIATE');
try {
  for await (const linea of rl) {
    if (!linea.trim()) continue;
    if (!cabecera) { cabecera = linea.split(','); continue; }
    // CSV simple con comillas: se parsea respetando comillas dobles.
    const c = []; let actual = '', entre = false;
    for (let i = 0; i < linea.length; i++) {
      const ch = linea[i];
      if (ch === '"') {
        if (entre && linea[i + 1] === '"') { actual += '"'; i++; } else entre = !entre;
      } else if (ch === ',' && !entre) { c.push(actual); actual = ''; } else actual += ch;
    }
    c.push(actual);
    const bin = String(c[0] || '').replace(/\D/g, '');
    if (bin.length !== 6) { descartadas++; continue; }
    const banco = nulo(c[4]);
    if (!banco) sinBanco++;
    const pais2 = nulo(c[8]);
    if (!pais2) sinPais++;
    ins.run(bin, marca(c[1]), tipo(c[2]), nulo(c[3]), banco, nulo(c[9]), pais2, null,
      'binlist-data-tech' + (nulo(c[10]) ? ':' + nulo(c[10]) : ''), nulo(c[11]) || datasetFecha || new Date().toISOString().slice(0, 10));
    importadas++;
  }
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch (_) {}
  throw e;
}
db.exec('CREATE TABLE IF NOT EXISTS meta(clave TEXT PRIMARY KEY, valor TEXT)');
db.prepare('INSERT INTO meta(clave,valor) VALUES(?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor')
  .run('dataset_fecha', datasetFecha || new Date().toISOString().slice(0, 10));
db.prepare('INSERT INTO meta(clave,valor) VALUES(?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor')
  .run('importado_en', new Date().toISOString());
db.prepare('INSERT INTO meta(clave,valor) VALUES(?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor')
  .run('filas', String(importadas));
db.close();

console.log('bins.db:', DB);
console.log('dataset:', datasetFecha || 'sin summary.json');
console.log('importadas:', importadas, '| descartadas (no 6 dígitos):', descartadas);
console.log('sin banco:', sinBanco, '| sin país:', sinPais);
