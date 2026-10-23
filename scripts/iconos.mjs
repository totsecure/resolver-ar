#!/usr/bin/env node
/* iconos.mjs — genera panel/vendor/iconos.svg con SOLO los iconos usados.
 * Fuente: scripts/iconos-src/*.svg (copiados de @tabler/icons 3.49.0, MIT).
 *   node scripts/iconos.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = '/Users/bunker/resolver';
const SRC = path.join(RAIZ, 'scripts', 'iconos-src');
const DESTINO = path.join(RAIZ, 'panel', 'vendor', 'iconos.svg');
const nombres = fs.readdirSync(SRC).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort();

const partes = nombres.map((nombre) => {
  const svg = fs.readFileSync(path.join(SRC, nombre + '.svg'), 'utf8');
  const interior = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  return '  <symbol id="tabler-' + nombre + '" viewBox="0 0 24 24">' + interior + '</symbol>';
});

const salida = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n' + partes.join('\n') + '\n</svg>\n';
fs.writeFileSync(DESTINO, salida);
console.log('iconos: ' + nombres.length + ' símbolos -> ' + DESTINO + ' (' + fs.statSync(DESTINO).size + ' bytes)');
