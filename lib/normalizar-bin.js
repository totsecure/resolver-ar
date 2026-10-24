/* normalizar-bin.js — una sola convención para datos de BIN.
 * país: Title Case · país2: ISO-2 mayúsculas · marca: Visa/Master/Amex/Discover
 * tipo: CREDIT/DEBIT · nivel: MAYÚSCULAS
 */
export const MARCAS = ['Visa', 'Master', 'Amex', 'Discover'];
const MARCAS_MAP = {
  VISA: 'Visa', MASTERCARD: 'Master', 'AMERICAN EXPRESS': 'Amex', AMEX: 'Amex',
  DISCOVER: 'Discover', DINERS: 'Diners', 'DINERS CLUB': 'Diners', JCB: 'JCB',
  UNIONPAY: 'UnionPay', 'UNION PAY': 'UnionPay', ELO: 'Elo', HIPERCARD: 'Hipercard',
};
export function marca(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (!s) return null;
  return MARCAS_MAP[s] || s.charAt(0) + s.slice(1).toLowerCase();
}
export function tipo(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (s === 'CREDIT' || s === 'CHARGE CARD' || s === 'CHARGE') return 'CREDIT';
  if (s === 'DEBIT') return 'DEBIT';
  return null;
}
export function nivel(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return s || null;
}
const MENORES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'and', 'of', 'the', 'da', 'do']);
export function pais(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  return s.toLowerCase().split(/(\s+|-)/).map((p) => {
    if (!p.trim() || p === '-' || MENORES.has(p)) return p;
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join('');
}
export function pais2(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}
export function moneda(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : null;
}
