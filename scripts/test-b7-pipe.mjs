#!/usr/bin/env node
/* test-b7-pipe.mjs — formato 11 campos, DNI como llave y salida de venta. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-b7-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.PUBLICAR_DIRECTO = '1';
process.env.NACIMIENTO_SINTETICO = 'coherente';
process.env.MOSTRAR_TRAMITE_PENDIENTE = '0';

const padron = new DatabaseSync(process.env.RESOLVER_DB);
padron.exec('CREATE TABLE IF NOT EXISTS personas(dni TEXT, apellido TEXT, nombre TEXT, cuit TEXT)');
padron.prepare('INSERT INTO personas VALUES(?,?,?,?)').run('39466006', 'GOMEZ', 'NALE MARINA', '27394660065');
padron.prepare('INSERT INTO personas VALUES(?,?,?,?)').run('30111222', 'PEREZ', 'JUAN', '20301112223');
padron.prepare('INSERT INTO personas VALUES(?,?,?,?)').run('30222333', 'LOPEZ', 'MARIA', '20302223334');
const stock = await import('../lib/stock.js');
const { generarExtra } = await import('../lib/faker-extra.js');
const { armarBloque } = await import('../lib/lote.js');
const base = stock.base();

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }

const n1 = stock.demoNumero('411111', 16);
const pipe = `${n1}|12/28|123|TITULAR INVENTADO|39466006|01/01/1990|inventado@x.com|111|CALLE FALSA 0|CORDOBA|CORDOBA`;
const parsed = stock.parsearEntradaFlexible(pipe)[0];
check('auto-detecta pipes', parsed.formato === 'pipe' && parsed.numero === n1 && parsed.dni === '39466006', JSON.stringify(parsed).slice(0, 160));

const an = stock.cargar(pipe, { flexible: true, fase: 'analizar', nombre: 'b7pipe' });
const fila = an.filas[0];
check('preview avisa titular distinto', fila.titular_derivado === 'GOMEZ NALE MARINA' && fila.titular_coincide === false && /no coincide/.test(fila.aviso || ''), JSON.stringify({ peg: fila.titular, der: fila.titular_derivado, aviso: fila.aviso }));
check('preview no bloquea', fila.estado === 'ok' && an.nuevas === 1);

const co = stock.cargar(pipe, { flexible: true, fase: 'confirmar', nombre: 'b7pipe' });
const row = base.prepare('SELECT numero,mes,anio,cvv,dni,titular,mail,telefono,direccion,ciudad,provincia,precio_num,estado FROM cc WHERE numero=?').get(n1);
check('confirmar carga 1', co.nuevas === 1);
check('solo guarda numero/venc/cvv/dni', row.dni === '39466006' && row.mes === '12' && row.anio === '2028' && row.cvv === '123'
  && row.titular === null && row.mail === null && row.telefono === null && row.direccion === null
  && row.ciudad === null && row.provincia === null && row.precio_num === null, JSON.stringify(row));

const venta = stock.entrega({ refs: [n1], comprador: 'b7', usuario: 'b7', formato: 'bloques' });
check('venta deriva titular y fecha', /^TITULAR GOMEZ NALE MARINA$/m.test(venta.texto) && /^FECHA NAC \d{2}\/\d{2}\/\d{4}$/m.test(venta.texto));
check('mail derivado del mismo nombre', /^MAIL nalemarina142@gmail.com$/m.test(venta.texto), venta.texto.match(/^MAIL .*$/m)?.[0]);
check('venta no imprime trámite pendiente', !/^NRO TRAMITE/m.test(venta.texto));
check('venta coherente y sin 0 colgado', /^CIUDAD VILLA GOBERNADOR GALVEZ$/m.test(venta.texto) && /^PROVINCIA SANTA FE$/m.test(venta.texto) && !/ 0$/m.test(venta.texto));
const t1 = stock.textoEntrega([row], { formato: 'bloques' });
const t2 = stock.textoEntrega([row], { formato: 'bloques' });
check('ficha determinística en el proceso', t1 === t2);

/* 3 DNIs: la ficha de venta debe ser byte a byte igual a la de /lote. */
const extraDnis = [[stock.demoNumero('411111', 16), '30111222', 'PEREZ JUAN'], [stock.demoNumero('411111', 16), '30222333', 'LOPEZ MARIA']];
for (const [num, dni, tit] of extraDnis) {
  stock.cargar(`${num}|12/28|123|${tit}|${dni}|01/01/1990|x@x.com|111|CALLE X 0|CORDOBA|CORDOBA`, { flexible: true, fase: 'confirmar', nombre: 'b7cmp' });
}
const filasCmp = [row, ...extraDnis.map(([num]) => base.prepare('SELECT numero,mes,anio,cvv,dni,titular,mail,telefono,direccion,ciudad,provincia,precio_num,estado FROM cc WHERE numero=?').get(num))];
const padronCmp = [
  { dni: '39466006', apellido: 'GOMEZ', nombre: 'NALE MARINA' },
  { dni: '30111222', apellido: 'PEREZ', nombre: 'JUAN' },
  { dni: '30222333', apellido: 'LOPEZ', nombre: 'MARIA' },
];
let iguales = 0;
for (let i = 0; i < filasCmp.length; i++) {
  const rr = filasCmp[i];
  const porVenta = stock.textoEntrega([rr], { formato: 'bloques' });
  const porLote = armarBloque(padronCmp[i], { numero: rr.numero, mes: rr.mes, anio: rr.anio, cvv: rr.cvv }, 1);
  if (porVenta === porLote) iguales++;
  else console.log('  DIFF ' + rr.dni + '\nVENTA\n' + porVenta + '\nLOTE\n' + porLote);
}
check('ficha venta == /lote byte a byte (3 DNIs)', iguales === 3, iguales + '/3');

const alto1 = generarExtra('92000000');
const alto2 = generarExtra('96000000');
check('franja alta 92M/96M', Number(String(alto1.fechaNac).slice(-4)) >= 2010 && Number(String(alto2.fechaNac).slice(-4)) >= 2010, alto1.fechaNac + ' / ' + alto2.fechaNac);

const n2 = stock.demoNumero('550000', 16);
const viejo = stock.parsearEntradaFlexible(`${n2},12/28,123,Juan Perez,30111222`)[0];
check('comas siguen siendo formato viejo', viejo.formato === 'viejo' && viejo.titular === 'Juan Perez', JSON.stringify(viejo).slice(0, 140));

padron.close();
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(FAIL === 0 ? 0 : 1);
