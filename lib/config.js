/* config.js — lectura de flags desde process.env o datos/server.env.
 * Los scripts no siempre cargan server.env; el server sí (scripts/server.sh).
 */
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_ENV = path.join(RAIZ, 'datos', 'server.env');
let cache = null;

function env() {
  if (cache) return cache;
  cache = {};
  try {
    const txt = fs.readFileSync(RUTA_ENV, 'utf8');
    for (const linea of txt.split('\n')) {
      const m = linea.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) cache[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return cache;
}

export function config(k, def = null) {
  if (process.env[k] !== undefined && process.env[k] !== '') return process.env[k];
  const v = env()[k];
  return v === undefined ? def : v;
}

/** Modo de nacimiento: '0', '1' o 'coherente'. */
export function modoNacimiento() {
  return String(config('NACIMIENTO_SINTETICO', '1')).trim().toLowerCase();
}

/** true = se permite inventar nacimiento. 0 lo apaga; 1 y coherente lo prenden. */
export function sinteticoNacimiento() {
  return !['0', 'false', 'no', 'off'].includes(modoNacimiento());
}

/** El tramite sintetico solo corresponde al modo legado '1'; en 'coherente' queda pendiente. */
export function sinteticoTramite() {
  return modoNacimiento() === '1';
}

/** 0 = no imprimir la linea NRO TRAMITE cuando esta pendiente (venta). */
export function mostrarTramitePendiente() {
  return String(config('MOSTRAR_TRAMITE_PENDIENTE', '0')).trim() === '1';
}

export const PENDIENTE = '(pendiente)';
