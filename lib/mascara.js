/* mascara.js — unica funcion de enmascarado de tarjetas.
 * Primeros 8 digitos visibles, xxxx, ultimos 4. Agunta 15-19 digitos.
 * Ejemplo: 5165850012346095 -> 51658500xxxx6095
 */
export function mascarar(numero) {
  const s = String(numero == null ? '' : numero).replace(/\D/g, '');
  if (s.length < 12) return s;
  /* La máscara conserva exactamente el largo del PAN: 15 -> 3 x, 19 -> 7 x. */
  return s.slice(0, 8) + 'x'.repeat(s.length - 12) + s.slice(-4);
}

export const mascara = mascarar;
export const mascaraBonita = mascarar;
