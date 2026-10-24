#!/usr/bin/env node
/* test-precio-par.mjs — formateador corto y par 1 pago/cuotas. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-precio-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.PUBLICAR_DIRECTO = '1';

const { precioCorto } = await import('../lib/precio-corto.js');
const { pedidoTexto } = await import('../lib/pedido.js');
const stock = await import('../lib/stock.js');
const { base } = stock;

let OK = 0, FAIL = 0;
const ok = (n, d) => { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); };
const fail = (n, d) => { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); };
const check = (n, c, d) => c ? ok(n, d) : fail(n, d || 'sin detalle');

function card(numero, precio, cuotas, etiqueta = 'SALDEADAS') {
  const d = base();
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get('516585').m || 0) + 1;
  return Number(d.prepare(
    'INSERT INTO cc(numero,mes,anio,cvv,bin,marca,estado,precio_num,precio_cuotas,saldo,saldo_ref,saldo_disp_num,creado,ref,etiqueta,es_test) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)'
  ).run(numero, '12', '2028', '321', '516585', 'Visa', 'DISPONIBLE', precio, cuotas, precio, cuotas, precio, new Date().toISOString(), ref, etiqueta).lastInsertRowid);
}

console.log('TEST PRECIO-PAR — ' + new Date().toISOString());
base();
try {
  check('corto 12m', precioCorto(12000000) === '12m', precioCorto(12000000));
  check('corto 23m831k', precioCorto(23831000) === '23m831k', precioCorto(23831000));
  check('corto 2m461k', precioCorto(2461000) === '2m461k', precioCorto(2461000));
  check('corto 0', precioCorto(0) === '0', precioCorto(0));
  check('corto vacío', precioCorto('') === '' && precioCorto(null) === '', JSON.stringify([precioCorto(''), precioCorto(null)]));

  card('5165850000000001', 12000000, 23831000);
  card('5165850000000002', 2461000, null);
  card('5165850000000003', null, null);
  const txt = pedidoTexto({ filtro: '516585' }).texto;
  check('pedido par formateado', /- 12m\/23m831k/.test(txt) && /- 2m461k/.test(txt) && txt.includes('51658500xxxx0003'), txt);
  check('sin saldo en la línea', !/saldo/i.test(txt) && !/- 1500/.test(txt));

  const numCarga = stock.demoNumero('516585', 16);
  const carga = stock.cargar(numCarga + ',12/28,321,Titular Test,30111222,Banco,12000000,23831000', { flexible: true, fase: 'confirmar', lote: 'TEST' });
  const row = base().prepare('SELECT precio_num, precio_cuotas FROM cc WHERE numero=?').get(numCarga);
  check('carga masiva 1 pago/cuotas', carga.nuevas === 1 && row.precio_num === 12000000 && row.precio_cuotas === 23831000, JSON.stringify(row));
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
