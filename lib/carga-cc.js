/* carga-cc.js — carga masiva de tarjetas desde el panel.
 *
 * Fases: analizar (dry-run, no escribe) -> confirmar (inserta).
 * Toda la insercion pasa por lib/stock.js::cargar() con {flexible:true}.
 * Nunca aborta el lote por una fila mala: las invalidas/duplicadas se informan.
 * Despues de confirmar, completa BINs desconocidos con lib/bininfo.js (cache).
 */
import { base, cargar } from './stock.js';
import { lookup as binLookup } from './bininfo.js';

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function analizar(texto, opts = {}) {
  return cargar(texto, { ...opts, fase: 'analizar', flexible: true });
}

export async function confirmar(texto, opts = {}) {
  const r = cargar(texto, { ...opts, fase: 'confirmar', flexible: true });
  if (opts.sinBin !== true && r.lote_id && r.binsNuevos && r.binsNuevos.length) {
    const max = Math.max(0, num(opts.maxBins, 20));
    await Promise.allSettled(r.binsNuevos.slice(0, max).map((bin) => binLookup(bin))); {
      
    }
    aplicarBin(r.lote_id);
    r.binsEnriquecidos = Math.min(max, r.binsNuevos.length);
  }
  return r;
}

function aplicarBin(loteId) {
  try {
    const d = base();
    const filas = d.prepare('SELECT DISTINCT bin FROM cc WHERE lote_id = ?').all(loteId);
    for (const { bin } of filas) {
      const b = d.prepare('SELECT * FROM bininfo WHERE bin = ?').get(bin);
      if (!b) continue;
      d.prepare(`UPDATE cc SET
        marca = COALESCE(marca, ?), banco = COALESCE(banco, ?), pais = COALESCE(pais, ?),
        pais2 = COALESCE(pais2, ?), tipo = COALESCE(tipo, ?), nivel = COALESCE(nivel, ?)
        WHERE lote_id = ? AND bin = ?`)
        .run(b.marca, b.banco, b.pais, b.pais2, b.tipo, b.nivel, loteId, bin);
    }
  } catch (_) {}
}

export function lote(id) {
  const d = base();
  const l = d.prepare('SELECT * FROM lotes_cc WHERE id = ?').get(Number(id));
  if (!l) return null;
  const filas = d.prepare(`SELECT id, ref, codigo, numero_mask, bin, marca, banco, mes, anio,
      venc_mm, venc_yy, vencida, dias_para_vencer, titular, dni, estado, precio_sugerido, precio_cuotas, creado
    FROM cc WHERE lote_id = ? ORDER BY id LIMIT 1000`).all(l.id);
  return { lote: l, filas };
}

const celda = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function exportar(id) {
  const d = base();
  const l = d.prepare('SELECT * FROM lotes_cc WHERE id = ?').get(Number(id));
  if (!l) return null;
  const filas = d.prepare(`SELECT ref, codigo, numero_mask, bin, marca, banco, mes, anio,
      venc_mm, venc_yy, vencida, titular, dni, estado, precio_sugerido, precio_cuotas, creado
    FROM cc WHERE lote_id = ? ORDER BY id`).all(l.id);
  const cols = ['ref', 'codigo', 'numero_mask', 'bin', 'marca', 'banco', 'mes', 'anio',
    'venc_mm', 'venc_yy', 'vencida', 'titular', 'dni', 'estado', 'precio_sugerido', 'precio_cuotas', 'creado'];
  const lineas = [cols.join(',')];
  for (const f of filas) lineas.push(cols.map((c) => celda(f[c])).join(','));
  return { nombre: 'lote_' + l.id + '.csv', texto: lineas.join('\n') + '\n' };
}
