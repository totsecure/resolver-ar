#!/usr/bin/env node
/* enriquecer-bins.mjs — completa banco/pais/tipo/nivel de los BINs de cc usando
 * el dataset local (datos/bins.db), sin red. Idempotente.
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { lookup } from '../lib/bininfo.js';

const RAIZ = '/Users/bunker/resolver';
const STOCK = process.env.RESOLVER_STOCK_DB || path.join(RAIZ, 'datos', 'stock.db');
const db = new DatabaseSync(STOCK);
db.exec('PRAGMA busy_timeout=8000');
const bins = db.prepare('SELECT bin FROM cc WHERE bin IS NOT NULL AND length(bin)>0 UNION SELECT bin FROM bininfo WHERE bin IS NOT NULL AND length(bin)>0 ORDER BY bin').all().map((r) => r.bin);
let cacheados = 0, sinDatos = 0;
/* NO escribe cc.banco/pais/tipo/nivel: la fuente de verdad es bins/bininfo.
 * cc.* queda reservado para overrides manuales. */
for (const bin of bins) {
  const d = await lookup(bin);
  if (!d || d.sin_datos) { sinDatos++; console.log('  sin datos:', bin, 'marca=' + (d && d.marca || '-')); continue; }
  cacheados++;
  console.log('  ' + bin + ' -> ' + [d.marca, d.nivel, d.tipo, d.banco, d.pais].filter(Boolean).join(' · '));
}
db.close();
console.log('');
console.log('BINs distintos:', bins.length, '| cacheados en bininfo:', cacheados, '| sin datos:', sinDatos);
