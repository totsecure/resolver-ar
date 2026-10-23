import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const P = '/Users/bunker/resolver/bot/telegram.js';
const A1 = 'const PISTA = [';
const A2 = 'export async function procesarUpdate(update, db) {';

let src = fs.readFileSync(P, 'utf8');
const orig = src;
const notas = [];
const cuenta = (a) => src.split(a).length - 1;
const abortar = (m) => { console.log('ABORTO: ' + m); process.exit(1); };

console.log('--- anclas ---');
console.log('PISTA: ' + cuenta(A1) + ' | procesarUpdate: ' + cuenta(A2) + ' | COMANDOS previo: ' + (src.indexOf('const COMANDOS = [') >= 0 ? 'si' : 'no'));

if (src.indexOf('const COMANDOS = [') < 0) {
  if (cuenta(A1) !== 1) abortar('el ancla PISTA no es unica');
  src = src.replace(A1, [
    'const COMANDOS = [',
    "  '<b>Comandos</b>',",
    "  '',",
    '  ...HELP,',
    "  '',",
    "  '<b>Atajos sin comando</b>',",
    "  'Pegar lineas <code>numero|MM|YY|CVV</code> o mandar un .txt: carga el lote y devuelve el .txt',",
    "  'Mandar un DNI de 7 u 8 digitos: ficha del titular',",
    '];',
    ''
  ].join('\n') + A1);
  notas.push('+ COMANDOS definido (toma el HELP que ya existe, asi no miente)');
} else notas.push('= COMANDOS ya estaba');

if (src.indexOf('/* /comandos */') < 0) {
  if (cuenta(A2) !== 1) abortar('el ancla procesarUpdate no es unica');
  src = src.replace(A2, [
    A2,
    '  /* /comandos */',
    '  {',
    '    const _m = update?.message;',
    "    const _t = String(_m?.text || '').trim().toLowerCase().split('@')[0];",
    "    if (_t === '/comandos' || _t === '/comando' || _t === '/ayuda') {",
    '      const _c = _m?.chat?.id;',
    '      if (_c && permitido(_c)) { await enviar(_c, COMANDOS); return; }',
    '    }',
    '  }',
    ''
  ].join('\n'));
  notas.push('+ intercepcion en procesarUpdate, antes de cualquier despacho');
} else notas.push('= intercepcion ya estaba');

if (src.indexOf('/comandos -') < 0) {
  const i = src.indexOf('const HELP = [');
  const j = src.indexOf('\n];', i);
  if (i < 0 || j < 0) abortar('no encontre el cierre del array HELP');
  src = src.slice(0, j) + "\n  '/comandos - esta lista completa'," + src.slice(j);
  notas.push('+ /comandos mencionado en HELP, para que /start lo muestre');
} else notas.push('= ya estaba en HELP');

if (src === orig) console.log('sin cambios');
else { fs.copyFileSync(P, P + '.bak-comandos'); fs.writeFileSync(P, src); console.log('escrito. backup: bot/telegram.js.bak-comandos'); }
console.log(notas.join('\n'));

try { execFileSync('node', ['--check', P], { stdio: 'inherit' }); console.log('node --check: OK'); }
catch (e) { console.log('node --check: FALLO'); process.exit(1); }

console.log('---- HELP actual, para que veamos que lista ----');
console.log(src.slice(src.indexOf('const HELP = ['), src.indexOf('const COMANDOS = [')));
