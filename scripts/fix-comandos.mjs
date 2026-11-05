import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const P = '/Volumes/Boveda/resolver/bot/telegram.js';
let s = fs.readFileSync(P, 'utf8');

if (s.includes('\n  HELP,\n')) { console.log('ya estaba corregido'); process.exit(0); }

const i = s.indexOf('const COMANDOS = [');
if (i < 0) { console.log('ABORTO: no encontre COMANDOS'); process.exit(1); }
const j = s.indexOf('\n];', i);
if (j < 0) { console.log('ABORTO: no encontre el cierre de COMANDOS'); process.exit(1); }

const nuevo = [
  'const COMANDOS = [',
  "  '<b>Comandos</b>',",
  "  '',",
  '  HELP,',
  "  '',",
  "  '<b>Atajos sin comando</b>',",
  "  'Pegar lineas <code>numero|MM|YY|CVV</code> o mandar un .txt: carga el lote y devuelve el .txt',",
  "  'Mandar un DNI de 7 u 8 digitos: ficha del titular',",
  "].join('\\n');",
].join('\n');

s = s.slice(0, i) + nuevo + s.slice(j + 3);
fs.copyFileSync(P, P + '.bak-comandos2');
fs.writeFileSync(P, s);
console.log('COMANDOS corregido: ahora es un string');

try { execFileSync('node', ['--check', P], { stdio: 'inherit' }); console.log('node --check: OK'); }
catch (e) { console.log('node --check: FALLO'); process.exit(1); }
