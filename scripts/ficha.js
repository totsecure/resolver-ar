#!/usr/bin/env node
/* scripts/ficha.js — ficha de 10 lineas.
 *
 *   node scripts/ficha.js <dni> [genero] [--red] [--fuentes]
 *
 * genero: M | F | X (si falta se usa el sexo derivado del CUIT en AFIP; si no
 * esta en AFIP, M). --red habilita salir a RENAPER; sin --red solo cache.
 * --fuentes agrega una linea por campo con su fuente.
 */

import { fichaDetalle } from '../lib/ficha.js';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const pos = argv.filter((a) => !a.startsWith('--'));
const dni = pos[0];
const genero = pos[1];

if (!dni) {
  console.error('uso: node scripts/ficha.js <dni> [genero] [--red] [--fuentes]');
  process.exit(1);
}

try {
  const { texto, fuentes } = await fichaDetalle(dni, {
    red: flags.has('--red'),
    genero,
  });
  console.log(texto);
  if (flags.has('--fuentes')) {
    for (const [campo, fuente] of Object.entries(fuentes)) {
      console.log(`FUENTE ${campo} ${fuente}`);
    }
  }
  process.exit(0);
} catch (e) {
  console.error('ficha: error inesperado: ' + (e?.message || e));
  process.exit(2);
}
