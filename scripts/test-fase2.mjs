#!/usr/bin/env node
/* test-fase2.mjs — invitaciones, alta aprobada, wallet, recargas y catalogo.
 * Base temporal: no toca datos/stock.db.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-fase2-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');

const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const recargas = await import('../lib/recargas.js');
const catalogo = await import('../lib/catalogo.js');
const stock = await import('../lib/stock.js');
const { base } = stock;

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }

function sembrar(numero, bin, precio) {
  const d = base();
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  const info = d.prepare(
    'INSERT INTO cc(numero, mes, anio, cvv, bin, marca, estado, precio_num, creado, ref) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(numero, '12', '2028', '123', bin, bin.startsWith('4') ? 'Visa' : 'Master', 'DISPONIBLE', precio, new Date().toISOString(), ref);
  return Number(info.lastInsertRowid);
}

console.log('TEST fase 2 — ' + new Date().toISOString());
auth.migrar(); wallet.migrar(); vendedores.migrar(); recargas.migrar(); catalogo.migrar();

try {
  const admin = auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });

  /* 1. invitacion de un solo uso */
  const inv = vendedores.crearInvitacion({ creadoPor: admin.id, dias: 7 });
  check('invitacion generada', /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(inv.codigo), inv.codigo);
  const reg = vendedores.registrar({
    codigo: inv.codigo, usuario: 'vend1', clave: 'claveV1x123', nombre: 'Vendedor Uno',
    dni: '30111222', telefono: '1155511111', alias_cbu: 'v1.alias',
  });
  check('registro crea pendiente', reg.ok && reg.estado === 'pendiente');
  const pend = vendedores.porUsuario(2);
  check('vendedor pendiente', pend && pend.estado === 'pendiente');
  check('login pendiente rechazado', auth.login({ usuario: 'vend1', clave: 'claveV1x123', ip: '1.1.1.1' }).error === 'suspendido');
  let reuso = null;
  try { vendedores.registrar({ codigo: inv.codigo, usuario: 'v1b', clave: 'claveV1b123', nombre: 'Otro', dni: '30111223', telefono: '1', alias_cbu: 'x' }); }
  catch (e) { reuso = e.message; }
  check('invitacion no se reusa', reuso === 'invitacion invalida o vencida', String(reuso));
  let dniDup = null;
  const inv2 = vendedores.crearInvitacion({ creadoPor: admin.id });
  try { vendedores.registrar({ codigo: inv2.codigo, usuario: 'v1c', clave: 'claveV1c123', nombre: 'Dup', dni: '30111222', telefono: '1', alias_cbu: 'x' }); }
  catch (e) { dniDup = e.message; }
  check('DNI duplicado rechazado', dniDup === 'dni ya registrado', String(dniDup));

  const ap = vendedores.revisarAlta(2, admin.id, true);
  check('admin aprueba alta', ap.ok && ap.estado === 'activo');
  check('login aprobado', auth.login({ usuario: 'vend1', clave: 'claveV1x123', ip: '1.1.1.1' }).ok === true);

  const inv3 = vendedores.crearInvitacion({ creadoPor: admin.id });
  vendedores.registrar({ codigo: inv3.codigo, usuario: 'vend2', clave: 'claveV2x123', nombre: 'Vendedor Dos', dni: '30222333', telefono: '1155522222', alias_cbu: 'v2.alias' });
  vendedores.revisarAlta(3, admin.id, true);
  const inv4 = vendedores.crearInvitacion({ creadoPor: admin.id });
  vendedores.registrar({ codigo: inv4.codigo, usuario: 'vend3', clave: 'claveV3x123', nombre: 'Vendedor Tres', dni: '30333444', telefono: '1155533333', alias_cbu: 'v3.alias' });
  vendedores.revisarAlta(4, admin.id, true);

  /* 2. wallet con ledger */
  check('saldo inicial 0', wallet.saldoDe(2) === 0);
  const a1 = wallet.acreditar(2, 1000, 'carga', 'test:1', 'carga inicial');
  check('acreditar 1000', a1.saldo === 1000);
  const a2 = wallet.acreditar(2, 500, 'carga', 'test:2', 'segunda');
  check('acreditar 500', a2.saldo === 1500);
  check('mov deja saldo_post', a2.mov_id > 0 && base().prepare('SELECT saldo_post FROM mov_saldo WHERE id=?').get(a2.mov_id).saldo_post === 1500);
  const mv1 = base().prepare('SELECT saldo_post FROM mov_saldo WHERE id=?').get(a1.mov_id).saldo_post;
  check('movimiento viejo no se edita', mv1 === 1000, 'saldo_post=' + mv1);
  check('debitar 200', wallet.debitar(2, 200, 'compra').saldo === 1300);
  const insuf = wallet.debitar(2, 999999, 'compra');
  check('debito insuficiente rechazado', insuf.ok === false && insuf.error === 'saldo_insuficiente');
  check('saldo intacto tras rechazo', wallet.saldoDe(2) === 1300);
  wallet.acreditar(3, 1000, 'carga');

  /* 3. recargas */
  const r1 = recargas.crear(2, { monto: 300, comprobante: 'transferencia 123' });
  check('recarga pendiente creada', r1.ok && r1.estado === 'pendiente');
  const rv = recargas.revisar(r1.id, admin.id, true, 'ok');
  check('admin aprueba recarga', rv.ok && rv.estado === 'aprobada');
  check('recarga acredita', wallet.saldoDe(2) === 1600);
  check('recarga no se aprueba dos veces', recargas.revisar(r1.id, admin.id, true).error === 'ya_revisada');
  const r2 = recargas.crear(2, { monto: 500, comprobante: 'otra' });
  recargas.revisar(r2.id, admin.id, false, 'ilegible');
  check('recarga rechazada no acredita', wallet.saldoDe(2) === 1600);
  check('comprobante en archivo opcional', recargas.comprobanteDe(r1.id) === null);

  /* 4. catalogo enmascarado y filtros */
  const c1 = stock.demoNumero('516585', 16);
  const c2 = stock.demoNumero('516585', 16);
  const c3 = stock.demoNumero('516585', 16);
  const c4 = stock.demoNumero('411111', 16);
  const c5 = stock.demoNumero('411111', 16);
  sembrar(c1, '516585', 100); sembrar(c2, '516585', 100); sembrar(c3, '516585', 100);
  sembrar(c4, '411111', 250); sembrar(c5, '411111', 250);
  const cat = catalogo.consultar({});
  check('catalogo lista 5', cat.total === 5, 'total=' + cat.total);
  check('catalogo enmascara', cat.items.every((x) => x.numero_mask.includes('xxxx') && !('numero' in x)));
  check('catalogo filtra BIN', catalogo.consultar({ bins: '516585' }).total === 3);
  check('catalogo filtra precio', catalogo.consultar({ pmin: 200 }).total === 2);
  check('precio visible', cat.items.every((x) => Number(x.precio) > 0));

  /* 5. v2 reserva 3 del mismo BIN: debita y desaparecen para todos */
  const antes = wallet.saldoDe(3);
  const res = catalogo.reservar(3, { bin: '516585', cantidad: 3 });
  check('reserva lote de 3', res.ok && res.cantidad === 3, 'total=' + res.total);
  check('debito exacto', res.saldo === antes - 300, 'saldo=' + res.saldo);
  check('reservadas ya no se ven', catalogo.consultar({ bins: '516585' }).total === 0);
  check('otro vendedor tampoco las ve', catalogo.consultar({}).total === 2);
  check('cc en RESERVADA', base().prepare("SELECT COUNT(*) n FROM cc WHERE bin='516585' AND estado='RESERVADA'").get().n === 3);
  check('reservas activas', base().prepare("SELECT COUNT(*) n FROM reservas WHERE usuario_id=3 AND estado='activa'").get().n === 3);
  check('mis reservas enmascaradas', catalogo.misReservas(3).every((r) => r.numero_mask.includes('xxxx')));

  /* 6. v1 reserva por ref y cancela: vuelve y se devuelve */
  const uno = catalogo.consultar({ bins: '411111' }).items[0];
  const saldoV1 = wallet.saldoDe(2);
  const rv1 = catalogo.reservar(2, { refs: [uno.id] });
  check('reserva por ref', rv1.ok && rv1.cantidad === 1);
  check('debito por ref', wallet.saldoDe(2) === saldoV1 - uno.precio);
  const idRes = base().prepare('SELECT id FROM reservas WHERE usuario_id=2 AND estado=? ORDER BY id DESC').get('activa').id;
  const can = catalogo.cancelar(2, idRes);
  check('cancelar devuelve saldo', can.ok && can.devuelto === uno.precio);
  check('cancelar libera stock', catalogo.consultar({ bins: '411111' }).total === 2);
  check('saldo tras cancelar', wallet.saldoDe(2) === saldoV1);

  /* 7. vencimiento automatico devuelve stock y saldo */
  const rv2 = catalogo.reservar(2, { bin: '411111', cantidad: 1 });
  check('reserva para vencer', rv2.ok === true, rv2.ok ? '' : String(rv2.error));
  const saldoV2 = wallet.saldoDe(2);
  const ultima = base().prepare("SELECT id FROM reservas WHERE usuario_id=2 AND estado='activa' ORDER BY id DESC").get().id;
  base().prepare('UPDATE reservas SET expira=? WHERE id=?').run(new Date(Date.now() - 60000).toISOString(), ultima);
  const ex = catalogo.expirar();
  check('job expira reserva', ex.liberadas >= 1, 'liberadas=' + ex.liberadas);
  check('vencida devuelve saldo', wallet.saldoDe(2) === saldoV2 + 250, 'saldo=' + wallet.saldoDe(2));
  check('vencida vuelve a disponible', catalogo.consultar({ bins: '411111' }).total === 2);

  /* 8. saldo insuficiente no reserva nada */
  wallet.acreditar(4, 50, 'carga');
  const antesTotal = catalogo.consultar({}).total;
  const rv3 = catalogo.reservar(4, { bin: '411111', cantidad: 1 });
  check('saldo insuficiente rechazado', rv3.ok === false && rv3.error === 'saldo_insuficiente');
  check('no reservó parcial', catalogo.consultar({}).total === antesTotal);
  check('sin movimientos de reserva', base().prepare("SELECT COUNT(*) n FROM mov_saldo WHERE usuario_id=4 AND tipo='reserva'").get().n === 0);

  /* 9. limite de simultaneas */
  vendedores.setLimites(3, { limite_simultaneas: 1 });
  const rv4 = catalogo.reservar(3, { bin: '411111', cantidad: 1 });
  check('limite de simultaneas', rv4.ok === false && rv4.error === 'limite_simultaneas', String(rv4.error));

  /* 10. ledger inmutable y auditoria */
  const nMov = base().prepare('SELECT COUNT(*) n FROM mov_saldo').get().n;
  check('ledger acumula movimientos', nMov >= 8, 'movs=' + nMov);
  check('saldo_post coherente', base().prepare('SELECT COUNT(*) n FROM mov_saldo WHERE saldo_post IS NULL').get().n === 0);
  check('auditoría fase 2', base().prepare("SELECT COUNT(*) n FROM auditoria WHERE accion LIKE 'RESERVA%' OR accion LIKE 'RECARGA%'").get().n >= 5);
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
