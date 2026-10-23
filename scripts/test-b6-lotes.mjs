#!/usr/bin/env node
/* test-b6-lotes.mjs — 3 tandas de 5, coherencia ciudad/provincia, sin " 0",
 * nacimiento sintético coherente y trámite pendiente. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NACIMIENTO_SINTETICO = 'coherente';
process.env.MOSTRAR_TRAMITE_PENDIENTE = '0';
const { generarLote } = await import('../lib/lote.js');
const { provinciaDeCiudad, generarExtra } = await import('../lib/faker-extra.js');

const CARDS = [
  '4111111111111111|12|28|123',
  '5555555555554444|12|28|123',
  '4012888888881881|12|28|123',
  '5105105105105100|12|28|123',
  '4242424242424242|12|28|123',
].join('\n');

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }

const partes = (texto) => texto.split(/\n\n(?=TARJETA #\d+\n)/);
const campo = (bloque, etiqueta) => {
  const m = bloque.match(new RegExp('^' + etiqueta + ' (.+)$', 'm'));
  return m ? m[1].trim() : null;
};

const tanda1 = partes(generarLote(CARDS, { desde: 1, saltar: 0 }));
const tanda2 = partes(generarLote(CARDS, { desde: 1, saltar: 5 }));
const tanda3 = partes(generarLote(CARDS, { desde: 1, saltar: 0 }));
const todas = [...tanda1, ...tanda2, ...tanda3];

console.log('B6 — 3 tandas de 5 — ' + new Date().toISOString());
for (const [i, bloque] of todas.entries()) {
  const n = i + 1;
  console.log('TANDA ' + (n <= 5 ? 1 : n <= 10 ? 2 : 3) + ' #' + ((n - 1) % 5 + 1) +
    ' :: ' + [
      'DNI ' + campo(bloque, 'DNI'),
      'CIUDAD ' + campo(bloque, 'CIUDAD'),
      'PROVINCIA ' + campo(bloque, 'PROVINCIA'),
      'FECHA ' + campo(bloque, 'FECHA NAC'),
      'TRAMITE ' + (campo(bloque, 'NRO TRAMITE') || '(omitido)'),
      'DIR ' + campo(bloque, 'DIRECCION'),
    ].join(' | '));
}

const dnis = todas.slice(0, 10).map((b) => campo(b, 'DNI'));
check('10 DNIs distintos', new Set(dnis).size === 10, dnis.join(','));
check('tanda 3 repite tanda 1 idéntica', tanda3.length === 5 && tanda3.every((b, i) => b === tanda1[i]), 'bloques=' + tanda3.length);

const incoherentes = [];
const pendientes = [];
const direcciones0 = [];
for (const bloque of todas) {
  const ciudad = campo(bloque, 'CIUDAD');
  const provincia = campo(bloque, 'PROVINCIA');
  const derivada = provinciaDeCiudad(ciudad, provincia);
  if (derivada && derivada.toUpperCase() !== provincia.toUpperCase()) {
    incoherentes.push(ciudad + '/' + provincia + ' -> ' + derivada);
  }
  const fecha = campo(bloque, 'FECHA NAC');
  if (fecha === '(pendiente)') pendientes.push(campo(bloque, 'DNI'));
  const dir = campo(bloque, 'DIRECCION');
  if (/\s[A-Z] 0$/.test(dir)) direcciones0.push(dir);
}
check('sin ciudad/provincia incoherente', incoherentes.length === 0, incoherentes.join(' | '));
check('nacimiento no pendiente', pendientes.length === 0, pendientes.join(','));
check('sin cero colgado en dirección', direcciones0.length === 0, direcciones0.join(' | '));

const tramites = todas.map((b) => campo(b, 'NRO TRAMITE'));
const pendientesSint = todas.filter((b) => campo(b, 'DNI') !== '30756789').map((b) => campo(b, 'NRO TRAMITE'));
check('trámite sintético no se imprime (flag 0)', pendientesSint.every((t) => t === null), JSON.stringify([...new Set(pendientesSint)]));
check('trámite real cacheado se conserva', campo(tanda1[0], 'NRO TRAMITE') === '00744230016', campo(tanda1[0], 'NRO TRAMITE'));
check('ningún pendiente impreso', todas.every((b) => !/^NRO TRAMITE \(pendiente\)$/m.test(b)));
for (const d of ['92000000', '96000000']) {
  const f = generarExtra(d);
  const anio = Number(String(f.fechaNac).slice(-4));
  check('franja alta ' + d + ' -> ' + anio, anio >= 2010 && anio <= 2024, f.fechaNac);
}
const fechas = todas.map((b) => campo(b, 'FECHA NAC'));
check('fechas dd/mm/aaaa', fechas.every((f) => /^\d{2}\/\d{2}\/\d{4}$/.test(f)), JSON.stringify([...new Set(fechas)]));

const { fichaDetalle } = await import('../lib/ficha.js');
const ficha = (await fichaDetalle('39466006', { red: false })).texto;
check('ficha coherente ciudad/provincia', /CIUDAD VILLA GOBERNADOR GALVEZ/.test(ficha) && /PROVINCIA SANTA FE/.test(ficha), ficha.split('\n').slice(6, 9).join(' | '));
check('ficha sin cero colgado', !/ 0$/m.test(ficha));

console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
