#!/usr/bin/env node
/* test-a1-a5.mjs — máscara, saldo/saldo_ref, pedido y filtros. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-a-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.PUBLICAR_DIRECTO = '1';
process.env.NACIMIENTO_SINTETICO = 'coherente';

const stock = await import('../lib/stock.js');
const { mascarar } = await import('../lib/mascara.js');
const { pedidoTexto } = await import('../lib/pedido.js');
const panel = await import('../lib/panel.js');
const base = stock.base();

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }

function card(bin, numero, saldo, saldoRef, etiqueta, precio, estado = 'DISPONIBLE', precioCuotas = null) {
  const info = base.prepare(
    'INSERT INTO cc(numero,mes,anio,cvv,bin,marca,estado,precio_num,precio_cuotas,creado,ref,etiqueta,saldo,saldo_ref,banco,pais,verif_estado) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(numero, '12', '2028', '123', bin, 'Visa', estado, precio, precioCuotas, new Date().toISOString(),
    (base.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1,
    etiqueta, saldo, saldoRef, 'Banco Test', 'AR', 'sin_verificar');
  return Number(info.lastInsertRowid);
}

check('mascara 16', mascarar('5165850012346095') === '51658500xxxx6095', mascarar('5165850012346095'));
check('mascara 15', mascarar('516585001234609') === '51658500xxx4609', mascarar('516585001234609'));
check('mascara 19', mascarar('5165850012345678901') === '51658500xxxxxxx8901', mascarar('5165850012345678901'));

base.prepare("INSERT INTO bininfo(bin,marca,banco,pais) VALUES('516585','Visa','Banco Test','AR')").run();
base.prepare("INSERT INTO bininfo(bin,marca,banco,pais) VALUES('516586','Visa','Banco Test','AR')").run();
const c1 = card('516585', '5165850012346095', 1500, 2000, 'SALDEADAS', 12000000, 'DISPONIBLE', 23831000);
const c2 = card('516586', '5165860012346005', 500, null, 'OTRA', 2461000);
const c3 = card('516700', '5167000012347001', 2500, 3000, 'SALDEADAS', 100);

const binText = stock.listarBin('516585');
check('saldo/saldo_ref en listado', /1> 51658500xxxx6095 · 1500\/2000/.test(binText), binText.split('\n')[1]);
const binText2 = stock.listarBin('516586');
check('saldo sin ref', /1> 51658600xxxx6005 · 500$/.test(binText2), binText2.split('\n')[1]);

const bus = await panel.consulta({ bins: '516585', saldo_min: '1000', saldo_max: '1600', saldeadas: '1' });
check('filtros saldo/saldeadas', bus.total === 1 && bus.filas[0].saldo === '1500/2000', JSON.stringify(bus.filas[0] && { saldo: bus.filas[0].saldo }));
const rango = await panel.consulta({ bin_desde: '516585', bin_hasta: '516586' });
check('filtro rango BIN', rango.total === 2, 'total=' + rango.total);
const etiqueta = await panel.consulta({ etiquetas: 'SALDEADAS' });
check('filtro etiqueta/base', etiqueta.total === 2, 'total=' + etiqueta.total);

const ped = pedidoTexto({ filtro: '516585' });
check('pedido cabecera/línea', ped.texto.split('\n')[0] === '💰 SALDEADAS BIN 516585 (1)' && /1> 51658500xxxx6095 - 1500\/2000/.test(ped.texto), ped.texto);
check('pedido muestra el saldo disp/ref', /1500\/2000/.test(ped.texto) && !/saldo/i.test(ped.texto));
const cDup1 = card('516588', '5165850011116095', 10, null, 'SALDEADAS', 1);
const cDup2 = card('516588', '5165850022226095', 10, null, 'SALDEADAS', 1);
const pedDup = pedidoTexto({ filtro: '516588' });
check('mascara duplicada agrega ref', /1> 51658500xxxx6095 \(1\)/.test(pedDup.texto) && /2> 51658500xxxx6095 \(2\)/.test(pedDup.texto), pedDup.texto);

const pedBase = pedidoTexto({ filtro: 'base' });
check('pedido base agrupa disponibles', /💰 SALDEADAS \(4\)/.test(pedBase.texto) && /💰 OTRA \(1\)/.test(pedBase.texto), pedBase.texto.split('\n')[0]);

const { manejarVendedor } = await import('../bot/vendedor.js');
const paginasBot = [];
await manejarVendedor(1, 'pedir', ['516585'], [], {
  enviar: async (_chat, html) => { paginasBot.push(html); },
  escapeHtml: (s) => String(s),
});
const textoBot = paginasBot.map((p) => p.replace(/^<pre>|<\/pre>$/g, '')).join('\n\n');
check('bot y web byte a byte', textoBot === ped.texto, 'bot=' + textoBot.length + ' web=' + ped.texto.length);
const pedIds = pedidoTexto({ ids: [c2] });
check('pedido por ids', /51658600xxxx6005 - 500/.test(pedIds.texto) && !pedIds.texto.includes('51658500'), pedIds.texto);

/* paginación >4000 */
for (let i = 0; i < 220; i++) card('519999', '51999900' + String(1000 + i) + '1234', 10, null, 'SALDEADAS', 1);
const pag = pedidoTexto({ filtro: '519999' });
check('pedido pagina >4000', pag.paginas.length > 1 && pag.paginas.every((p) => /^\(página \d+\/\d+\)/.test(p)), 'paginas=' + pag.paginas.length);

const html = fs.readFileSync('panel/index.html', 'utf8');
check('UI botón Pedir y filtros guardables', /btnPedirSel/.test(html) && /btnGuardarFiltro/.test(html) && /f_saldmin/.test(html));

console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(FAIL === 0 ? 0 : 1);
