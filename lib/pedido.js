/* pedido.js — texto de pedido/stock compartido por web y bot.
 *
 * Una sola función produce exactamente el mismo texto en los dos lados.
 * Solo lista tarjetas DISPONIBLES, sin precio.
 */
import { base } from './stock.js';
import { mascarar } from './mascara.js';
import { precioCorto } from './precio-corto.js';

const MAX = 4000;
const listaIds = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((x) => String(x).trim()).filter(Boolean)
  .map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);

function saldoDe(r) {
  const s = r.saldo != null ? r.saldo : r.saldo_disp_num;
  return s == null || s === '' ? null : Number(s);
}

function consultar(f = {}) {
  const d = base();
  const w = ["c.estado = 'DISPONIBLE'"];
  if (!f.incluirBorradas) w.push('COALESCE(c.eliminado,0) = 0');
  const p = [];
  const ids = listaIds(f.ids);
  if (ids.length) {
    w.push('c.id IN (' + ids.map(() => '?').join(',') + ')');
    p.push(...ids);
  } else {
    const filtro = String(f.filtro || '').trim();
    if (/^\d{4,8}$/.test(filtro)) {
      w.push('c.bin = ?');
      p.push(filtro);
    } else if (/^saldeadas$/i.test(filtro)) {
      w.push("UPPER(c.etiqueta) = 'SALDEADAS'");
    }
  }
  return d.prepare(
    'SELECT c.id, c.ref, c.bin, c.numero, c.codigo, c.etiqueta, c.saldo, c.saldo_ref, c.saldo_disp_num, ' +
    'COALESCE(c.precio_num, pr.precio, c.precio) precio, c.precio_cuotas ' +
    'FROM cc c LEFT JOIN precios pr ON pr.bin = c.bin WHERE ' + w.join(' AND ') + ' ORDER BY c.bin, c.ref'
  ).all(...p);
}

/**
 * Devuelve {paginas, texto, n}. texto = paginas.join('\n\n').
 * filtro: bin de 4-8 dígitos, 'saldeadas' o 'base' (todas agrupadas por base).
 */
export function pedidoTexto(f = {}) {
  const filas = consultar(f);
  if (!filas.length) {
    return { paginas: ['Sin stock disponible.'], texto: 'Sin stock disponible.', n: 0 };
  }

  const mascaras = new Map();
  for (const r of filas) {
    const m = mascarar(r.numero);
    mascaras.set(m, (mascaras.get(m) || 0) + 1);
  }

  const filtro = String(f.filtro || '').trim();
  const porBase = /^base$/i.test(filtro) || (!f.ids && !/^\d/.test(filtro) && !/^saldeadas$/i.test(filtro));
  const grupos = new Map();
  for (const r of filas) {
    const clave = porBase ? String(r.etiqueta || 'Saldeadas') : (r.bin + '|' + String(r.etiqueta || 'Saldeadas'));
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(r);
  }

  const lineas = [];
  let n = 0;
  const esSaldeadas = /^saldeadas$/i.test(filtro);
  if (esSaldeadas) {
    /* Saldeadas: un solo encabezado y todas las líneas numeradas seguidas. */
    const todas = filas;
    lineas.push('💰 Saldeadas (' + todas.length + ')', '');
    for (const r of todas) lineas.push(lineaDe(r, ++n, mascaras));
  } else {
    for (const [clave, lista] of grupos) {
      let cab;
      if (porBase) {
        cab = '💰 ' + clave + ' (' + lista.length + ')';
      } else {
        const [bin, etiqueta] = clave.split('|');
        cab = '💰 ' + etiqueta + ' BIN ' + bin + ' (' + lista.length + ')';
      }
      lineas.push(cab, '');
      for (const r of lista) lineas.push(lineaDe(r, ++n, mascaras));
      lineas.push('');
    }
    while (lineas.length && lineas[lineas.length - 1] === '') lineas.pop();
  }

  const completo = lineas.join('\n');
  if (completo.length <= MAX) return { paginas: [completo], texto: completo, n };

  const paginas = [];
  let actual = [];
  for (const linea of lineas) {
    if (actual.length && (actual.join('\n').length + linea.length + 1) > MAX - 20) {
      paginas.push(actual.join('\n'));
      actual = [];
    }
    actual.push(linea);
  }
  if (actual.length) paginas.push(actual.join('\n'));
  const total = paginas.length;
  const numeradas = paginas.map((p, i) => '(página ' + (i + 1) + '/' + total + ')\n' + p);
  return { paginas: numeradas, texto: numeradas.join('\n\n'), n };
}

/* Línea de una tarjeta: "4> 51658500xxxx7595 - 5m856k/5m856k". */
function lineaDe(r, n, mascaras) {
  const mask = mascarar(r.numero);
  const dup = mascaras && mascaras.get(mask) > 1;
  const etiqueta = dup ? ' (' + (r.ref != null ? r.ref : (r.codigo || '-')) + ')' : '';
  const s = saldoDe(r);
  const t = r.saldo_ref != null ? Number(r.saldo_ref) : null;
  const saldo = s == null ? '' : precioCorto(s) + (t != null ? '/' + precioCorto(t) : '');
  return n + '> ' + mask + etiqueta + (saldo ? ' - ' + saldo : '');
}

/**
 * Lista ESTRUCTURADA de saldeadas, con la MISMA numeración que pedidoTexto.
 * Se usa para resolver "/pedir N": devuelve [{n, id, ref, mask, saldo}].
 */
export function saldeadasLista(f = {}) {
  const filas = consultar({ filtro: 'saldeadas', incluirBorradas: f.incluirBorradas });
  const mascaras = new Map();
  for (const r of filas) { const m = mascarar(r.numero); mascaras.set(m, (mascaras.get(m) || 0) + 1); }
  return filas.map((r, i) => {
    const s = saldoDe(r);
    const t = r.saldo_ref != null ? Number(r.saldo_ref) : null;
    return {
      n: i + 1,
      id: Number(r.id),
      ref: r.ref != null ? Number(r.ref) : null,
      numero: r.numero,
      mask: mascarar(r.numero),
      saldo: s == null ? (t == null ? null : precioCorto(t)) : precioCorto(s) + (t != null ? '/' + precioCorto(t) : ''),
      linea: lineaDe(r, i + 1, mascaras),
    };
  });
}

/** Resuelve la N-ésima de saldeadas (numero de position) o un ref exacto. */
export function saldeadaPorNumero(n) {
  const lista = saldeadasLista();
  const pos = Number(n);
  if (!Number.isFinite(pos) || pos < 1) return null;
  return lista.find((x) => x.n === pos) || null;
}
