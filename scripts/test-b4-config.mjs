#!/usr/bin/env node
/* test-b4-config.mjs — decisiones del dueño leídas de entorno, sin hardcode. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-b4-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');

const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const catalogo = await import('../lib/catalogo.js');
const precios = await import('../lib/precios.js');
const stock = await import('../lib/stock.js');
const base = stock.base();

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }

function vendor(usuario, saldo = 0) {
  const u = auth.crearUsuario({ usuario, nombre: usuario, rol: 'vendedor', clave: 'clave12345' });
  base.prepare("INSERT INTO vendedores(usuario_id,dni,telefono,alias_cbu,estado,creado) VALUES(?,?,?,?, 'activo', ?)")
    .run(u.id, '30' + String(u.id).padStart(6, '0'), '11555', usuario, new Date().toISOString());
  if (saldo) wallet.acreditar(u.id, saldo, 'test');
  return u.id;
}
function card(bin, precio, codigo) {
  const d = base;
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  const info = d.prepare(
    'INSERT INTO cc(numero,mes,anio,cvv,bin,marca,estado,precio_num,creado,ref,codigo,titular,dni,verif_estado) ' +
    "VALUES(?,?,?,?,?,?, 'DISPONIBLE',?,?,?,?, 'Titular', '30111222', 'sin_verificar')"
  ).run(stock.demoNumero(bin, 16), '12', '2028', '123', bin, 'Visa', precio, new Date().toISOString(), ref, codigo);
  return Number(info.lastInsertRowid);
}

console.log('TEST B4 — ' + new Date().toISOString());
auth.migrar(); wallet.migrar(); vendedores.migrar(); catalogo.migrar(); precios.migrar();
const u1 = vendor('b4vend1', 1000);
const u2 = vendor('b4vend2', 0);
const u3 = vendor('b4vend3', 0);
const u4 = vendor('b4vend4', 1000);

try {
  /* PUBLICAR_DIRECTO */
  process.env.PUBLICAR_DIRECTO = '0';
  const carga = stock.cargar('numero,venc,cvv,titular,dni,banco,precio\n4111111111111111,12/28,123,Revision,30111222,Banco,100\n', { flexible: true, fase: 'confirmar', nombre: 'b4', usuario: 'test' });
  const ccRev = base.prepare('SELECT id,ref,estado FROM cc WHERE lote_id=?').get(carga.lote_id);
  check('PUBLICAR_DIRECTO=0 deja REVISION', ccRev.estado === 'REVISION', JSON.stringify(ccRev));
  check('REVISION no aparece en catalogo', catalogo.consultar({}).total === 0);
  stock.publicar([ccRev.ref], 'test');
  check('publicar mueve a DISPONIBLE', base.prepare('SELECT estado FROM cc WHERE id=?').get(ccRev.id).estado === 'DISPONIBLE');
  check('publicada aparece en catalogo', catalogo.consultar({}).total === 1);
  process.env.PUBLICAR_DIRECTO = '1';
  const n2 = stock.demoNumero('550000', 16);
  const carga2 = stock.cargar('numero,venc,cvv,titular,dni,banco,precio\n' + n2 + ',12/28,123,Directa,30222333,Banco,100\n', { flexible: true, fase: 'confirmar', nombre: 'b4b', usuario: 'test' });
  check('PUBLICAR_DIRECTO=1 deja DISPONIBLE', base.prepare('SELECT estado FROM cc WHERE lote_id=?').get(carga2.lote_id).estado === 'DISPONIBLE');

  /* PRECIO_TIENDA / PRECIO_VENDEDOR como fallback */
  process.env.PRECIO_TIENDA = '777';
  process.env.PRECIO_VENDEDOR = '555';
  const cSinPrecio = card('400000', null, 'B4PREC1');
  const admin = catalogo.consultar({ bins: '400000' }, null);
  const vend = catalogo.consultar({ bins: '400000' }, u1);
  check('PRECIO_TIENDA fallback', admin.items[0] && admin.items[0].precio === 777, JSON.stringify(admin.items[0]));
  check('PRECIO_VENDEDOR fallback', vend.items[0] && vend.items[0].precio === 555, JSON.stringify(vend.items[0]));
  check('unitario tienda', precios.unitario(base, null, '400000', 1, null) === 777);
  check('unitario vendedor', precios.unitario(base, u1, '400000', 1, null) === 555);
  delete process.env.PRECIO_TIENDA;
  delete process.env.PRECIO_VENDEDOR;

  /* 0 = deshabilitado, no precio literal: sin tarjeta/BIN no se lista. */
  const cCero = card('400001', null, 'B4CERO1');
  check('precio 0 no es literal', catalogo.consultar({ bins: '400001' }, null).total === 0 && precios.unitario(base, null, '400001', 1, null) === null, 'cc=' + cCero);

  /* VENTANA_MIN */
  process.env.VENTANA_MIN = '1';
  const cVentana = card('411112', 100, 'B4VENT1');
  const rv = catalogo.reservar(u1, { refs: [cVentana] });
  const mins = (new Date(rv.expira).getTime() - Date.now()) / 60000;
  check('VENTANA_MIN=1', rv.ok && rv.ventana_min === 1 && mins > 0.9 && mins <= 1.1, 'min=' + mins.toFixed(2));
  process.env.VENTANA_MIN = '15';

  /* DESCUENTO_MODO / VENTA_SIN_SALDO */
  const cCuenta = card('411113', 100, 'B4CTA1');
  process.env.DESCUENTO_MODO = 'cuenta';
  process.env.VENTA_SIN_SALDO = '0';
  const rCta = catalogo.reservar(u2, { refs: [cCuenta] });
  check('DESCUENTO_MODO=cuenta sin saldo', rCta.ok && rCta.modo === 'cuenta' && wallet.saldoDe(u2) === -100, 'saldo=' + wallet.saldoDe(u2));
  const cBloq = card('411114', 100, 'B4BLO1');
  process.env.DESCUENTO_MODO = 'saldo';
  const rBloq = catalogo.reservar(u3, { refs: [cBloq] });
  check('VENTA_SIN_SALDO=0 bloquea', rBloq.ok === false && rBloq.error === 'saldo_insuficiente', JSON.stringify(rBloq));
  process.env.VENTA_SIN_SALDO = '1';
  const rSin = catalogo.reservar(u3, { refs: [cBloq] });
  check('VENTA_SIN_SALDO=1 permite', rSin.ok && wallet.saldoDe(u3) === -100, 'saldo=' + wallet.saldoDe(u3));
  process.env.VENTA_SIN_SALDO = '0';

  /* VENDEDOR_GANA_CARRERA */
  const cA = card('455555', 100, 'B4CARR1');
  const cB = card('455555', 100, 'B4CARR2');
  const cAnum = base.prepare('SELECT numero FROM cc WHERE id=?').get(cA).numero;
  const rCarr = catalogo.reservar(u4, { refs: [cA] });
  check('reserva para carrera', rCarr.ok);
  process.env.VENDEDOR_GANA_CARRERA = '1';
  const v1 = stock.entrega({ refs: [cAnum], comprador: 'bot', usuario: 'bot', cantidad: 1 });
  const cA1 = base.prepare('SELECT estado FROM cc WHERE id=?').get(cA);
  check('carrera=1 protege al vendedor', v1.codigo === null && cA1.estado === 'RESERVADA', 'estado=' + cA1.estado);
  process.env.VENDEDOR_GANA_CARRERA = '0';
  const v0 = stock.entrega({ refs: [cAnum], comprador: 'bot', usuario: 'bot', cantidad: 1 });
  const cA0 = base.prepare('SELECT estado FROM cc WHERE id=?').get(cA);
  check('carrera=0 permite vender', Boolean(v0.codigo) && cA0.estado === 'VENDIDA', 'estado=' + cA0.estado);
  const resA = base.prepare('SELECT * FROM reservas WHERE cc_id=? ORDER BY id DESC LIMIT 1').get(cA);
  base.prepare("UPDATE reservas SET expira=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), resA.id);
  const saldoAntes = wallet.saldoDe(u4);
  const exp = catalogo.expirar();
  check('reserva vendida por carrera=0 vence sin romper', exp.liberadas >= 1 && wallet.saldoDe(u4) === saldoAntes + 100 && base.prepare('SELECT estado FROM cc WHERE id=?').get(cA).estado === 'VENDIDA', JSON.stringify(exp));
  process.env.VENDEDOR_GANA_CARRERA = '1';
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
