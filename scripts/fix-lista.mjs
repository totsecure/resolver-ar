import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const P = '/Users/bunker/resolver/bot/telegram.js';
let s = fs.readFileSync(P, 'utf8');

if (s.includes('/random [afip]')) { console.log('ya estaba'); process.exit(0); }

const antes = s;

s = s.replace(
  "  '/random - DNI del pool',\n  '/random afip - DNI al azar del padrón',",
  "  '/random [afip] - DNI del pool; con afip, al azar del padrón',"
);

const i = s.indexOf('const COMANDOS = [');
if (i < 0) { console.log('ABORTO: no encontre COMANDOS'); process.exit(1); }
const k = s.indexOf('].join(', i);
if (k < 0) { console.log('ABORTO: no encontre el cierre'); process.exit(1); }
const fin = s.indexOf(';', k) + 1;

const nuevo = [
  'const COMANDOS = [',
  '  HELP,',
  "  '',",
  "  '<b>atajos sin comando</b>',",
  "  'Pegar lineas <code>numero|MM|YY|CVV</code> o mandar un .txt: carga el lote y devuelve el .txt',",
  "  'Mandar un DNI de 7 u 8 digitos: ficha del titular',",
  "  '',",
  "  '/comandos - esta lista completa',",
  "].join('\\n');",
].join('\n');

s = s.slice(0, i) + nuevo + s.slice(fin);

if (s === antes) { console.log('sin cambios'); process.exit(0); }
fs.copyFileSync(P, P + '.bak-lista');
fs.writeFileSync(P, s);
console.log('lista acomodada');

try { execFileSync('node', ['--check', P], { stdio: 'inherit' }); console.log('node --check: OK'); }
catch (e) { console.log('node --check: FALLO'); process.exit(1); }
