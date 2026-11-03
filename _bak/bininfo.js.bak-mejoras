/* bininfo.js — identifica un BIN contra fuentes publicas gratis y cachea el
 * resultado en la tabla bininfo de datos/stock.db (30 dias por BIN). Si ninguna
 * fuente responde devuelve solo lo deducible por prefijo y no cachea el fallo.
 */
import { base, binDe, marcaDe, soloDigitos } from './stock.js';

const TTL_DIAS = 30;
const FUENTES = [
  { nombre: 'handyapi', url: (b) => 'https://data.handyapi.com/bin/' + b, normalizar: (j) => ({ marca: j.Scheme, tipo: j.Type, banco: j.Bank, pais: j?.Country?.Name, pais2: j?.Country?.A2, moneda: j?.Country?.Currency?.Code }) },
  { nombre: 'antipublic', url: (b) => 'https://bins.antipublic.cc/bin/' + b, normalizar: (j) => ({ marca: j.brand, tipo: j.type, nivel: j.level, banco: j.bank, pais: j.country, pais2: j.countrycode, moneda: j.currency }) },
  { nombre: 'binlist', url: (b) => 'https://lookup.binlist.net/' + b, normalizar: (j) => ({ marca: j.scheme, tipo: j.type, nivel: j.brand, banco: j?.bank?.name, pais: j?.country?.name, pais2: j?.country?.alpha2, moneda: j?.country?.currency }) },
];

let lista = false;
function tabla() {
  if (lista) return;
  base().exec('CREATE TABLE IF NOT EXISTS bininfo(bin TEXT PRIMARY KEY, marca TEXT, tipo TEXT, nivel TEXT, banco TEXT, pais TEXT, pais2 TEXT, moneda TEXT, json TEXT, fuente TEXT, actualizado TEXT)');
  lista = true;
}

function limpio(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' || s === 'undefined' ? null : s;
}

function fusionar(...objetos) {
  const out = {};
  for (const o of objetos) {
    for (const k of Object.keys(o || {})) {
      const v = limpio(o[k]);
      if (v !== null) out[k] = v;
    }
  }
  return out;
}

async function pedir(url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch (_) { return null; } finally { clearTimeout(t); }
}
export async function lookup(binBruto, opts = {}) {
  const bin = binDe(binBruto) || soloDigitos(binBruto).slice(0, 6);
  if (bin.length < 6) return null;
  tabla();
  const cache = base().prepare('SELECT * FROM bininfo WHERE bin = ?').get(bin);
  const fresco = cache && cache.actualizado && (Date.now() - Date.parse(cache.actualizado)) < TTL_DIAS * 86400000;
  if (fresco && !opts.forzar) return { ...cache, cache: true };

  const local = { bin: bin, marca: marcaDe(bin + '0000000000') };
  let datos = null;
  let fuente = null;
  let bruto = null;
  for (const f of FUENTES) {
    bruto = await pedir(f.url(bin));
    if (!bruto) continue;
    datos = fusionar(datos, f.normalizar(bruto));
    fuente = fuente || f.nombre;
    if (datos.marca) break;
  }
  const out = { ...local, ...(datos || {}), fuente: fuente, json: bruto ? JSON.stringify(bruto) : null, actualizado: new Date().toISOString() };
  if (datos && (datos.marca || datos.banco || datos.pais)) {
    base().prepare('INSERT INTO bininfo(bin, marca, tipo, nivel, banco, pais, pais2, moneda, json, fuente, actualizado) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bin) DO UPDATE SET marca=excluded.marca, tipo=excluded.tipo, nivel=excluded.nivel, banco=excluded.banco, pais=excluded.pais, pais2=excluded.pais2, moneda=excluded.moneda, json=excluded.json, fuente=excluded.fuente, actualizado=excluded.actualizado')
      .run(bin, out.marca || null, out.tipo || null, out.nivel || null, out.banco || null, out.pais || null, out.pais2 || null, out.moneda || null, out.json, out.fuente, out.actualizado);
  }
  return out;
}
