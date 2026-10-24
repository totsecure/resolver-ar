/* bininfo.js — identifica un BIN: primero datos locales (datos/bins.db),
 * después cache (tabla bininfo de stock.db) y recién al final APIs públicas.
 * Si no hay datos devuelve solo lo deducible por prefijo y NO cachea el fallo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { base, binDe, marcaDe, soloDigitos } from './stock.js';
import { marca as nMarca, tipo as nTipo, nivel as nNivel, pais as nPais, pais2 as nPais2, moneda as nMoneda } from './normalizar-bin.js';

const TTL_DIAS = 30;
const RUTA_BINS = process.env.RESOLVER_BINS_DB || path.join(import.meta.dirname, '..', 'datos', 'bins.db');
const FUENTES = [
  { nombre: 'handyapi', url: (b) => 'https://data.handyapi.com/bin/' + b, normalizar: (j) => ({ marca: j.Scheme, tipo: j.Type, banco: j.Bank, pais: j?.Country?.Name, pais2: j?.Country?.A2, moneda: j?.Country?.Currency?.Code }) },
  { nombre: 'antipublic', url: (b) => 'https://bins.antipublic.cc/bin/' + b, normalizar: (j) => ({ marca: j.brand, tipo: j.type, nivel: j.level, banco: j.bank, pais: j.country, pais2: j.countrycode, moneda: j.currency }) },
  /* binlist queda último: límite público de 5 req/hora. */
  { nombre: 'binlist', url: (b) => 'https://lookup.binlist.net/' + b, normalizar: (j) => ({ marca: j.scheme, tipo: j.type, nivel: j.brand, banco: j?.bank?.name, pais: j?.country?.name, pais2: j?.country?.alpha2, moneda: j?.country?.currency }) },
];

let lista = false;
let binsDb = null;
function tabla() {
  if (lista) return;
  base().exec('CREATE TABLE IF NOT EXISTS bininfo(bin TEXT PRIMARY KEY, marca TEXT, tipo TEXT, nivel TEXT, banco TEXT, pais TEXT, pais2 TEXT, moneda TEXT, json TEXT, fuente TEXT, actualizado TEXT)');
  lista = true;
}
function abrirBins() {
  if (binsDb) return binsDb;
  if (!fs.existsSync(RUTA_BINS)) return null;
  try { binsDb = new DatabaseSync(RUTA_BINS, { readOnly: true }); } catch (_) { binsDb = null; }
  return binsDb;
}
function local(bin) {
  const d = abrirBins(); if (!d) return null;
  try {
    return d.prepare('SELECT bin, marca, tipo, nivel, banco, pais, pais2, moneda, fuente, actualizado FROM bins WHERE bin=?').get(bin) || null;
  } catch (_) { return null; }
}
function limpio(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' || s === 'undefined' ? null : s;
}
function fusionar(...objetos) {
  const out = {};
  for (const o of objetos) for (const k of Object.keys(o || {})) {
    const v = limpio(o[k]); if (v !== null) out[k] = v;
  }
  return out;
}
function completa(d) {
  return Boolean(d && d.marca && d.tipo && d.banco && d.pais);
}
async function pedir(url, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch (_) { return null; } finally { clearTimeout(t); }
}
function normalizar(out) {
  return {
    ...out,
    marca: nMarca(out.marca) || null,
    tipo: nTipo(out.tipo) || null,
    nivel: nNivel(out.nivel) || null,
    pais: nPais(out.pais) || null,
    pais2: nPais2(out.pais2) || null,
    moneda: nMoneda(out.moneda) || null,
  };
}
function cachear(bin, out) {
  const d = normalizar(out);
  base().prepare('INSERT INTO bininfo(bin, marca, tipo, nivel, banco, pais, pais2, moneda, json, fuente, actualizado) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bin) DO UPDATE SET marca=excluded.marca, tipo=excluded.tipo, nivel=excluded.nivel, banco=excluded.banco, pais=excluded.pais, pais2=excluded.pais2, moneda=excluded.moneda, json=excluded.json, fuente=excluded.fuente, actualizado=excluded.actualizado')
    .run(bin, d.marca, d.tipo, d.nivel, d.banco || null, d.pais, d.pais2, d.moneda, d.json || null, d.fuente || null, d.actualizado || new Date().toISOString());
}
export async function lookup(binBruto, opts = {}) {
  const bin = binDe(binBruto) || soloDigitos(binBruto).slice(0, 6);
  if (bin.length < 6) return null;
  tabla();
  const prefijo = { bin: bin, marca: marcaDe(bin + '0000000000') };

  /* 1) dataset local */
  const l = local(bin);
  if (l) {
    const out = normalizar({ ...prefijo, ...l, fuente: 'dataset', actualizado: l.actualizado || new Date().toISOString(), local: true });
    if (!opts.sinCache) cachear(bin, out);
    return out;
  }

  /* 2) cache de stock.db */
  const cache = base().prepare('SELECT * FROM bininfo WHERE bin = ?').get(bin);
  const fresco = cache && cache.actualizado && (Date.now() - Date.parse(cache.actualizado)) < TTL_DIAS * 86400000;
  if (fresco && !opts.forzar) return { ...cache, cache: true };

  /* 3) red: fusionar todas las fuentes hasta completar banco+tipo+país+marca */
  let datos = null, fuente = null, bruto = null;
  for (const f of FUENTES) {
    const j = await pedir(f.url(bin));
    if (!j) continue;
    bruto = j;
    datos = fusionar(datos, f.normalizar(j));
    fuente = fuente || f.nombre;
    if (completa(datos)) break;
  }

  if (!datos || !(datos.marca || datos.banco || datos.pais || datos.tipo)) {
    return { ...prefijo, fuente: 'sin_datos', sin_datos: true, actualizado: new Date().toISOString() };
  }
  const out = normalizar({ ...prefijo, ...datos, fuente, json: bruto ? JSON.stringify(bruto) : null, actualizado: new Date().toISOString() });
  cachear(bin, out);
  return out;
}
