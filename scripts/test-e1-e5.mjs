#!/usr/bin/env node
/* test-e1-e5.mjs — acciones masivas, papelera, métricas, alertas y accesos. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-e15-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.PUBLICAR_DIRECTO = '1';

const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const catalogo = await import('../lib/catalogo.js');
const panel = await import('../lib/panel.js');
const metricas = await import('../lib/metricas.js');
const reclamos = await import('../lib/reclamos.js');
const recargas = await import('../lib/recargas.js');
const stock = await import('../lib/stock.js');
const { base } = stock;

let OK = 0, FAIL = 0;
const ok = (n, d) => { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); };
const fail = (n, d) => { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); };
const check = (n, c, d) => c ? ok(n, d) : fail(n, d || 'sin detalle');
function sembrar(bin, precio = 100) {
  const d = base();
  let n; do { n = stock.demoNumero(bin, 16); } while (d.prepare('SELECT 1 FROM cc WHERE numero=?').get(n));
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  return Number(d.prepare(
    'INSERT INTO cc(numero,mes,anio,cvv,bin,marca,estado,precio_num,precio_sugerido,creado,ref,titular,dni,banco,verif_estado,lote) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(n, '12', '2028', '321', bin, 'Visa', 'DISPONIBLE', precio, 60, new Date().toISOString(), ref, 'Titular Test', '30123456', 'Banco Test', 'sin_verificar', 'LOTE-E').lastInsertRowid);
}
function alta(usuario, dni) {
  const inv = vendedores.crearInvitacion({ creadoPor: 1 });
  vendedores.registrar({ codigo: inv.codigo, usuario, clave: 'clave' + usuario + '1', nombre: usuario, dni, telefono: '11555', alias_cbu: usuario + '.alias' });
  const v = vendedores.listar({ estado: 'pendiente' }).find((x) => x.usuario === usuario);
  vendedores.revisarAlta(v.usuario_id, 1, true);
  return v.usuario_id;
}

console.log('TEST E — ' + new Date().toISOString());
auth.migrar(); wallet.migrar(); vendedores.migrar(); catalogo.migrar(); panel.migrar(); reclamos.migrar(); recargas.migrar();
try {
  auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });
  const uid = alta('eventa', '40111222');
  wallet.acreditar(uid, 10000, 'carga');
  const c = sembrar('411111');
  const ref = base().prepare('SELECT ref FROM cc WHERE id=?').get(c).ref;

  const est = panel.accion({ accion: 'estado', ref, valor: 'BAJA' });
  check('E1 estado masivo', est.ok && base().prepare('SELECT estado FROM cc WHERE id=?').get(c).estado === 'BAJA');
  panel.accion({ accion: 'estado', ref, valor: 'DISPONIBLE' });
  const baseAcc = panel.accion({ accion: 'base', ref, valor: 'BASE-E' });
  check('E1 base', base().prepare('SELECT etiqueta FROM cc WHERE id=?').get(c).etiqueta === 'BASE-E', JSON.stringify(baseAcc));
  const sal = panel.accion({ accion: 'saldo', ref, disp: '500', total: '700' });
  check('E1 saldo', base().prepare('SELECT saldo, saldo_ref FROM cc WHERE id=?').get(c).saldo === 500, JSON.stringify(sal));

  const del = panel.accion({ accion: 'borrar', ref });
  const visible = await panel.consulta({ estado: 'DISPONIBLE', q: '411111' });
  const papelera = await panel.consulta({ papelera: '1', q: '411111' });
  check('E1 borrar va a papelera', del.ok && visible.total === 0 && papelera.total === 1, 'visible=' + visible.total + ' papelera=' + papelera.total);
  const res = panel.accion({ accion: 'restaurar', ref });
  check('E2 restaurar', res.ok && (await panel.consulta({ estado: 'DISPONIBLE', q: '411111' })).total === 1);

  /* E3: venta pagada y auto-OK para métricas */
  const r = catalogo.reservar(uid, { refs: [c] });
  catalogo.pagar(uid, { grupo: r.grupo });
  const resId = base().prepare('SELECT id FROM reservas WHERE cc_id=?').get(c).id;
  base().prepare('UPDATE reservas SET expira=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), resId);
  catalogo.expirar();
  const m = metricas.resumen({ umbral: 5 });
  check('E3 ventas por día', Array.isArray(m.ventasPorDia) && m.ventasPorDia.length >= 1);
  check('E3 margen por lote', m.margenPorLote.some((x) => x.lote === 'LOTE-E' && x.margen === 40), JSON.stringify(m.margenPorLote));
  check('E3 cierre de caja', Array.isArray(m.cierreCaja) && m.cierreCaja.length >= 1 && m.ranking.length >= 1);

  wallet.debitarForzado(uid, wallet.saldoDe(uid) + 5, 'ajuste_forzado', 'test-e4', 'saldo negativo de prueba');
  const al = metricas.alertas({ umbral: 5, fallaMin: 1 });
  check('E4 alertas stock/saldo', (al.stockBajo || []).length >= 1 && (al.saldoNegativo || []).some((x) => x.usuario === 'eventa'));
  check('E4 alertas fallas/reclamos', Array.isArray(al.fallaAlta) && Array.isArray(al.reclamosVendedor));

  auth.login({ usuario: 'admin', clave: 'claveAdmin123', ip: '10.0.0.9', ua: 'test' });
  const acc = auth.accesos(20);
  check('E5 accesos con IP', acc.length >= 1 && acc[0].ip === '10.0.0.9' && typeof acc[0].ok === 'number');
  check('E5 auditoría visible', auth.auditoria(20).some((a) => a.accion === 'LOGIN' && a.ip === '10.0.0.9'));
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
