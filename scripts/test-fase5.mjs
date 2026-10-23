#!/usr/bin/env node
/* test-fase5.mjs — precios por tramo/vendedor, metricas y resolucion de reclamos. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.RECLAMO_AUTO_REEMPLAZO = '0';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-fase5-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');

const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const catalogo = await import('../lib/catalogo.js');
const vinculacion = await import('../lib/vinculacion.js');
const notificaciones = await import('../lib/notificaciones.js');
const reclamos = await import('../lib/reclamos.js');
const precios = await import('../lib/precios.js');
const metricas = await import('../lib/metricas.js');
const recargas = await import('../lib/recargas.js');
const vb = await import('../lib/vendedor-bot.js');
const stock = await import('../lib/stock.js');
const { base } = stock;

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }

function sembrar(bin, precio, titular, dni, codigo) {
  const d = base();
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  const info = d.prepare(
    'INSERT INTO cc(numero, mes, anio, cvv, bin, marca, estado, precio_num, creado, ref, titular, dni, banco, verif_estado, codigo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(stock.demoNumero(bin, 16), '12', '2028', '321', bin, 'Visa', 'DISPONIBLE', precio, new Date().toISOString(), ref, titular, dni, 'Banco Test', 'sin_verificar', codigo);
  return Number(info.lastInsertRowid);
}
function alta(usuario, dni) {
  const inv = vendedores.crearInvitacion({ creadoPor: 1 });
  vendedores.registrar({ codigo: inv.codigo, usuario, clave: 'clave' + usuario + '1', nombre: usuario, dni, telefono: '11555', alias_cbu: usuario + '.alias' });
  const v = vendedores.listar({ estado: 'pendiente' }).find((x) => x.usuario === usuario);
  vendedores.revisarAlta(v.usuario_id, 1, true);
  return v.usuario_id;
}
function grupoDe(ccId) {
  return base().prepare('SELECT * FROM reservas WHERE cc_id=? ORDER BY id DESC LIMIT 1').get(ccId);
}
function codigoDe(ccId) {
  return base().prepare('SELECT codigo FROM cc WHERE id=?').get(ccId).codigo;
}
function reclamoDe(ccId) {
  return reclamos.listar({}).find((r) => Number(r.cc_id) === Number(ccId) && r.estado === 'pendiente');
}

console.log('TEST fase 5 — ' + new Date().toISOString());
for (const m of [auth, wallet, vendedores, catalogo, vinculacion, notificaciones, reclamos, precios, recargas]) m.migrar();

try {
  auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });
  const u1 = alta('vend1', '51111222');
  const u2 = alta('vend2', '52222333');
  wallet.acreditar(u1, 10000, 'carga');
  wallet.acreditar(u2, 1000, 'carga');

  const cc = [];
  for (let i = 1; i <= 8; i++) cc.push(sembrar('411111', 100, 'Titular ' + i, '3011122' + i, 'P5' + String(i).padStart(5, '0')));
  const otroBin = sembrar('516585', 200, 'Otro Bin', '30999888', 'P5OTRO1');

  /* 1. precios: base, tramo y vendedor */
  stock.setPrecio('516585', 210, 'ARS');
  precios.setTramo('411111', 1, 2, 120, 1);
  precios.setTramo('411111', 3, null, 90, 1);
  precios.setPrecioVendedor(u2, '411111', 80, 1);
  check('tramo cantidad 1', precios.unitario(base(), null, '411111', 1, 100) === 120);
  check('tramo cantidad 3', precios.unitario(base(), null, '411111', 3, 100) === 90);
  check('precio por vendedor gana', precios.unitario(base(), u2, '411111', 3, 100) === 80);
  check('precio base del BIN', precios.unitario(base(), null, '516585', 1, null) === 210);

  const catU1 = catalogo.consultar({ bins: '411111' }, u1);
  const catU2 = catalogo.consultar({ bins: '411111' }, u2);
  check('catalogo usa tramo', catU1.items[0].precio === 120);
  check('catalogo usa precio de vendedor', catU2.items[0].precio === 80);

  /* 2. reserva cobra el tramo y no pisa el precio base */
  const r3 = catalogo.reservar(u1, { refs: [cc[0], cc[1], cc[2]] });
  check('reserva 3 cobra tramo 3+', r3.ok && r3.total === 270, 'total=' + r3.total);
  check('reservas guardan precio cobrado', base().prepare('SELECT precio FROM reservas WHERE cc_id=?').get(cc[0]).precio === 90);
  check('cc.precio_num no se modifica', base().prepare('SELECT precio_num FROM cc WHERE id=?').get(cc[0]).precio_num === 100);
  catalogo.pagar(u1, { grupo: r3.grupo });

  const r1u2 = catalogo.reservar(u2, { refs: [cc[7]] });
  check('vendedor 2 paga su precio', r1u2.ok && r1u2.total === 80, 'total=' + r1u2.total);
  catalogo.pagar(u2, { grupo: r1u2.grupo });

  /* 3. tres fallas desde el bot */
  const gen = vinculacion.generar(u1);
  vb.vincular(555, gen.codigo);
  const saldoAntes = wallet.saldoDe(u1);
  for (let i = 3; i <= 5; i++) {
    const p = vb.pedir(555, '411111', 1);
    check('pedido falla ' + (i - 2), p.ok === true && p.grupo);
    vb.pagar(555, p.grupo);
    const f = vb.marcarFalla(555, codigoDe(cc[i]), 'falla de prueba ' + i);
    check('falla registrada ' + (i - 2), f.ok === true, f.texto);
  }
  const pend = reclamos.listar({ estado: 'pendiente' });
  check('tres reclamos pendientes', pend.length === 3, 'n=' + pend.length);

  /* 4. reemplazo automatico por stock del mismo BIN */
  const cl = reclamoDe(cc[3]);
  const rr = reclamos.resolverAccion({ reclamoId: cl.id, adminId: 1, accion: 'reemplazo', nota: 'reemplazo test' });
  check('reclamo reemplazado', rr.ok === true && rr.reemplazo, JSON.stringify(rr));
  check('reclamada queda ANULADA', base().prepare('SELECT estado, verif_estado FROM cc WHERE id=?').get(cc[3]).estado === 'ANULADA');
  const rep = rr.reemplazo ? base().prepare('SELECT estado, vendido_a, verif_estado FROM cc WHERE id=?').get(rr.reemplazo.id) : null;
  check('reemplazo queda VENDIDA al vendedor', rep && rep.estado === 'VENDIDA' && Number(rep.vendido_a) === u1);
  check('reemplazo sin cobrar', base().prepare('SELECT precio FROM reservas WHERE cc_id=?').get(rr.reemplazo.id).precio === 0);
  check('aviso reclamo resuelto', base().prepare("SELECT COUNT(*) n FROM notificaciones WHERE usuario_id=? AND tipo='reclamo_resuelto'").get(u1).n === 1);
  check('auditoria reclamo', base().prepare("SELECT COUNT(*) n FROM notificaciones WHERE canal='audit' AND payload LIKE '%RECLAMO RESUELTO%'").get().n >= 1);

  /* 5. devolucion de saldo */
  const cl2 = reclamoDe(cc[4]);
  const saldoPre = wallet.saldoDe(u1);
  const rd = reclamos.resolverAccion({ reclamoId: cl2.id, adminId: 1, accion: 'devolucion', nota: 'devuelto' });
  check('reclamo devuelto', rd.ok === true && rd.devuelto === 120, JSON.stringify(rd));
  check('saldo devuelto', wallet.saldoDe(u1) === saldoPre + 120);
  check('cc devuelta ANULADA', base().prepare('SELECT estado FROM cc WHERE id=?').get(cc[4]).estado === 'ANULADA');

  /* 6. rechazo: la tarjeta era valida */
  const cl3 = reclamoDe(cc[5]);
  const saldoR = wallet.saldoDe(u1);
  const rj = reclamos.resolverAccion({ reclamoId: cl3.id, adminId: 1, accion: 'rechazar', nota: 'estaba ok' });
  check('reclamo rechazado', rj.ok === true && rj.accion === 'rechazar');
  const c6 = base().prepare('SELECT estado, verif_estado FROM cc WHERE id=?').get(cc[5]);
  check('rechazo deja VENDIDA/ok', c6.estado === 'VENDIDA' && c6.verif_estado === 'ok');
  check('rechazo no devuelve saldo', wallet.saldoDe(u1) === saldoR);
  check('reclamo ya no pendiente', reclamos.listar({ estado: 'pendiente' }).length === 0);

  /* 7. metricas */
  const m = metricas.resumen({ umbral: 2 });
  /* La devolucion excluye esa reserva de los ingresos. */
  check('metricas kpis', m.kpis && m.kpis.ingresos_total === 270 + 80 + 120 + 120, 'ingresos=' + (m.kpis && m.kpis.ingresos_total));
  check('ventas por dia', m.ventasPorDia.length >= 1 && m.ventasPorDia[0].n >= 1);
  const iv = m.ingresosPorVendedor.find((x) => Number(x.usuario_id) === u1);
  check('ingresos por vendedor', iv && iv.total === 510, 'total=' + (iv && iv.total));
  const fb = m.fallaPorBin.find((x) => x.bin === '411111');
  check('tasa de falla por BIN', fb && fb.fallas === 2 && fb.tasa > 0, JSON.stringify(fb));
  const sb = m.stockBajo.find((x) => x.bin === '411111');
  check('stock bajo por BIN', sb && sb.n === 0, JSON.stringify(sb));

  /* 8. auditoria y listas */
  const aud = auth.auditoria(500);
  check('auditoria de precios', aud.some((a) => a.accion === 'PRECIO_TRAMO'));
  check('auditoria de reclamos', aud.some((a) => a.accion === 'RECLAMO_RESOLVER'));
  check('auditoria de saldo', aud.some((a) => a.accion === 'SALDO_ACREDITAR'));
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
