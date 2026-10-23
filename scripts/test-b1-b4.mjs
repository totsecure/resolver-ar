#!/usr/bin/env node
/* test-b1-b4.mjs — Grupo B: bloque /lote, saldo masivo, búsqueda global. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-b14-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.PUBLICAR_DIRECTO = '1';
process.env.MOSTRAR_TRAMITE_PENDIENTE = '0';

const { analizar, confirmar } = await import('../lib/carga-cc.js');
const { base } = await import('../lib/stock.js');
const stock = await import('../lib/stock.js');
const panel = await import('../lib/panel.js');

let OK = 0, FAIL = 0;
function check(n, c, d) { if (c) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); } else { FAIL++; console.log('  FAIL  ' + n + ' :: ' + (d || 'sin detalle')); } }

const bloque = [
  'TARJETA #1',
  'DATOS TITULAR',
  'TITULAR GOMEZ NALE MARINA',
  'DNI 39466006',
  'FECHA NAC 30/12/1994',
  'MAIL nalemarina142@gmail.com',
  'TELEFONO 3400 8558941',
  'DIRECCION MAIPU 987',
  'CIUDAD VILLA GOBERNADOR GALVEZ',
  'PROVINCIA SANTA FE',
  'PAIS Argentina',
  'DATOS TARJETA',
  'CC 4111111111111111',
  'VENCIMIENTO 12/28',
  'CODIGO 123',
  '',
  'ruido que debe ignorarse',
].join('\n');

const a = analizar(bloque);
check('B1 bloque: una tarjeta', a.total === 1 && a.nuevas === 1, 'total=' + a.total + ' nuevas=' + a.nuevas + ' invalidas=' + a.invalidas.length);
check('B1 bloque: numero/venc/cvv/dni', a.filas[0] && a.filas[0].numero_mask === '41111111xxxx1111' && a.filas[0].formato === 'bloque');
const r1 = await confirmar(bloque, { sinBin: true, usuario: 'test' });
const c1 = base().prepare("SELECT * FROM cc WHERE numero='4111111111111111'").get();
check('B1 bloque: confirmado', r1.nuevas === 1 && c1 && c1.mes === '12' && c1.anio === '2028' && c1.cvv === '123' && c1.dni === '39466006');

const cabecera = [
  'numero,venc,cvv,titular,dni,saldo,saldo_ref',
  '5555555555554444,09/29,456,Maria Gomez,27876543,1500,2500',
].join('\n');
const b = analizar(cabecera);
check('B3 cabecera saldo/saldo_ref', b.total === 1 && b.filas[0] && b.filas[0].estado === 'ok', JSON.stringify(b.filas[0] || {}));
const r2 = await confirmar(cabecera, { sinBin: true });
const c2 = base().prepare("SELECT * FROM cc WHERE numero='5555555555554444'").get();
check('B3 saldo guardado', r2.nuevas === 1 && c2 && c2.saldo === 1500 && c2.saldo_ref === 2500);

base().prepare("UPDATE cc SET ref=9999 WHERE numero='5555555555554444'").run();
const c2r = 9999;
stock.setSaldo(c2r, '3000', '4000', 'test');
const c2s = base().prepare("SELECT saldo, saldo_ref FROM cc WHERE numero='5555555555554444'").get();
check('B3 saldo masivo (setSaldo)', c2s.saldo === 3000 && c2s.saldo_ref === 4000);

base().prepare("UPDATE cc SET etiqueta='BUSQUEDA-X' WHERE numero='5555555555554444'").run();
base().prepare("INSERT OR IGNORE INTO bininfo(bin,marca,banco,pais,tipo,nivel) VALUES('411111','Visa','Banco Test','Argentina','credito','clasica')").run();
base().prepare("INSERT OR IGNORE INTO bininfo(bin,marca,banco,pais,tipo,nivel) VALUES('555555','Master','Banco Dos','Argentina','credito','gold')").run();
const q = async (v) => (await panel.consulta({ q: v })).total;
check('B4 busca últimos 4', await q('4444') === 1);
check('B4 busca DNI', await q('27876543') === 1);
check('B4 busca titular', await q('Maria Gomez') === 1);
check('B4 busca etiqueta', await q('BUSQUEDA-X') === 1);
check('B4 busca ref', await q('9999') === 1);
const codigo = base().prepare("SELECT codigo FROM cc WHERE numero='5555555555554444'").get().codigo;
check('B4 busca código', await q(codigo) === 1);

console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(FAIL === 0 ? 0 : 1);
