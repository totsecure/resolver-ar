/* precio-corto.js — formato corto de precios para bot y web.
 * Millones con m, miles con k, sin decimales. Menor a 1.000.000 tal cual.
 */
export function precioCorto(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') return '';
  const n = Math.trunc(Number(String(valor).replace(/[^0-9.-]/g, '')));
  if (!Number.isFinite(n) || n === 0) return n === 0 ? '0' : '';
  const signo = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1000000) return signo + String(abs);
  const m = Math.floor(abs / 1000000);
  const resto = abs % 1000000;
  const k = Math.floor(resto / 1000);
  return signo + m + 'm' + (k ? k + 'k' : '');
}
