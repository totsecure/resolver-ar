#!/usr/bin/env node
/* test-fase3.mjs — concurrencia, ventana de 15 min, pago, auto-OK y revelado. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RAIZ = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-fase3-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.VENTANA_MIN = '15';

const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const catalogo = await import('../lib/catalogo.js');
const stock = await import('../lib/stock.js');
const { base } = stock;

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }

function sembrar(numero, bin, precio, titular, dni) {
  const d = base();
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  const info = d.prepare(
    'INSERT INTO cc(numero, mes, anio, cvv, bin, marca, estado, precio_num, creado, ref, titular, dni, banco, verif_estado) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(numero, '12', '2028', '321', bin, 'Visa', 'DISPONIBLE', precio, new Date().toISOString(), ref, titular, dni, 'Banco Test', 'sin_verificar');
  return Number(info.lastInsertRowid);
}
function alta(usuario, dni) {
  const admin = vendedores.listar({ estado: 'activo' }).find((v) => v.usuario === 'admin');
  const inv = vendedores.crearInvitacion({ creadoPor: 1 });
  vendedores.registrar({ codigo: inv.codigo, usuario, clave: 'clave' + usuario + '1', nombre: usuario, dni, telefono: '11555', alias_cbu: usuario + '.alias' });
  const v = vendedores.listar({ estado: 'pendiente' }).find((x) => x.usuario === usuario);
  vendedores.revisarAlta(v.usuario_id, 1, true);
  return v.usuario_id;
}
function esperarHijo(uid, ccId, startMs) {
  const url = pathToFileURL(path.join(RAIZ, 'lib', 'catalogo.js')).href;
  const code = `
    const cat = await import(${JSON.stringify(url)});
    const t = Number(process.env.START_MS);
    while (Date.now() < t) {}
    const r = cat.reservar(Number(process.env.UID), { refs: [Number(process.env.CCID)] });
    process.stdout.write(JSON.stringify(r));
  `;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: RAIZ,
      env: { ...process.env, UID: String(uid), CCID: String(ccId), START_MS: String(startMs) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { err += b.toString(); });
    p.on('close', () => {
      let j = null; try { j = JSON.parse(out); } catch (_) {}
      resolve({ j, err });
    });
  });
}

console.log('TEST fase 3 — ' + new Date().toISOString());
auth.migrar(); wallet.migrar(); vendedores.migrar(); catalogo.migrar();

try {
  auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });
  const idA = alta('venda', '40111222');
  const idB = alta('vendb', '40222333');
  wallet.acreditar(idA, 1000, 'carga');
  wallet.acreditar(idB, 1000, 'carga');

  const ccA = sembrar(stock.demoNumero('411111', 16), '411111', 100, 'Titular Test', '30123456');
  const ccB = sembrar(stock.demoNumero('411111', 16), '411111', 150, 'Otro Titular', '30987654');
  const ccC = sembrar(stock.demoNumero('516585', 16), '516585', 200, 'Tercer Titular', '30555444');

  /* 1. reserva revela numero y titular; catalogo sigue enmascarado */
  const r1 = catalogo.reservar(idA, { refs: [ccA] });
  check('reserva ok', r1.ok === true && r1.cantidad === 1);
  check('revela numero completo', r1.items[0].numero === base().prepare('SELECT numero FROM cc WHERE id=?').get(ccA).numero);
  check('revela titular y DNI', r1.items[0].titular === 'Titular Test' && r1.items[0].dni === '30123456');
  check('catalogo sigue enmascarado', catalogo.consultar({}).items.every((x) => x.numero_mask.includes('xxxx')));
  const ventanaMin = (new Date(r1.expira).getTime() - Date.now()) / 60000;
  check('ventana VENTANA_MIN', ventanaMin > 14.5 && ventanaMin <= 15.1, 'min=' + ventanaMin.toFixed(2));
  const saldoTrasReserva = wallet.saldoDe(idA);
  check('saldo debitado al reservar', saldoTrasReserva === 900, 'saldo=' + saldoTrasReserva);

  const datos = catalogo.datosReserva(idA, r1.items[0].id ? base().prepare('SELECT id FROM reservas WHERE cc_id=?').get(ccA).id : 0);
  check('datosReserva revela', datos.ok && datos.item.numero && datos.item.titular === 'Titular Test');
  check('datos ajenos bloqueados', catalogo.datosReserva(idB, base().prepare('SELECT id FROM reservas WHERE cc_id=?').get(ccA).id).ok === false);

  /* 2. pago no vuelve a cobrar y pasa a PAGADA */
  const resIdA = base().prepare('SELECT id FROM reservas WHERE cc_id=?').get(ccA).id;
  const p1 = catalogo.pagar(idA, { id: resIdA });
  check('pago ok', p1.ok === true && p1.estado === 'pagada');
  check('pago no recobra', wallet.saldoDe(idA) === saldoTrasReserva);
  check('cc PAGADA', base().prepare('SELECT estado FROM cc WHERE id=?').get(ccA).estado === 'PAGADA');
  check('doble pago rechazado', catalogo.pagar(idA, { id: resIdA }).ok === false);
  check('reserva pagada', base().prepare('SELECT estado FROM reservas WHERE id=?').get(resIdA).estado === 'pagada');

  /* 3. auto-OK al vencer la ventana pagada */
  base().prepare('UPDATE reservas SET expira=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), resIdA);
  const ex1 = catalogo.expirar();
  check('job cierra pagada', ex1.cerradas >= 1, 'cerradas=' + ex1.cerradas);
  const ccArow = base().prepare('SELECT estado, verif_estado, codigo_venta, vendido_a FROM cc WHERE id=?').get(ccA);
  check('auto-OK deja VENDIDA', ccArow.estado === 'VENDIDA' && ccArow.verif_estado === 'ok');
  check('auto-OK guarda venta', Boolean(ccArow.codigo_venta) && Number(ccArow.vendido_a) === idA);
  check('auto-OK no devuelve saldo', wallet.saldoDe(idA) === saldoTrasReserva);
  check('reserva quedo ok', base().prepare('SELECT estado FROM reservas WHERE id=?').get(resIdA).estado === 'ok');

  /* 4. impaga vencida vuelve a disponible y devuelve el saldo */
  const r2 = catalogo.reservar(idA, { refs: [ccB] });
  check('segunda reserva', r2.ok === true);
  const saldoConB = wallet.saldoDe(idA);
  const resB = base().prepare('SELECT id FROM reservas WHERE cc_id=?').get(ccB).id;
  base().prepare('UPDATE reservas SET expira=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), resB);
  const ex2 = catalogo.expirar();
  check('job libera impaga', ex2.liberadas >= 1, 'liberadas=' + ex2.liberadas);
  check('impaga vuelve a DISPONIBLE', base().prepare('SELECT estado FROM cc WHERE id=?').get(ccB).estado === 'DISPONIBLE');
  check('impaga devuelve saldo', wallet.saldoDe(idA) === saldoConB + 150);
  check('reserva vencida', base().prepare('SELECT estado FROM reservas WHERE id=?').get(resB).estado === 'vencida');
  check('libre se ve en catalogo', catalogo.consultar({ bins: '411111' }).items.some((x) => x.id === ccB));

  /* 5. maquina de estados rechaza saltos */
  let invalida = null;
  try { catalogo.transicion(base(), ccB, 'DISPONIBLE', 'PAGADA'); } catch (e) { invalida = e.message; }
  check('transicion invalida rechazada', /transicion_invalida/.test(String(invalida)), String(invalida));
  check('transiciones auditadas', base().prepare("SELECT COUNT(*) n FROM movs WHERE accion LIKE 'ESTADO_%'").get().n >= 4);

  /* 6. concurrencia real: dos procesos pelean por la misma tarjeta */
  const start = Date.now() + 700;
  const [a, b] = await Promise.all([esperarHijo(idA, ccC, start), esperarHijo(idB, ccC, start)]);
  const exitos = [a, b].filter((x) => x.j && x.j.ok).length;
  check('solo un proceso gana', exitos === 1, 'ok=' + exitos + ' detalle=' + JSON.stringify([a.j && a.j.error, b.j && b.j.error]));
  check('sin doble venta', base().prepare('SELECT COUNT(*) n FROM reservas WHERE cc_id=?').get(ccC).n === 1);
  check('una sola cc reservada', base().prepare('SELECT estado FROM cc WHERE id=?').get(ccC).estado === 'RESERVADA');
  const perdedor = [a, b].find((x) => !(x.j && x.j.ok));
  check('perdedor recibe sin_stock', perdedor && perdedor.j && ['sin_stock', 'saldo_insuficiente'].includes(perdedor.j.error), perdedor && perdedor.j ? perdedor.j.error : (perdedor && perdedor.err.slice(-120)));

  /* 7. idempotencia del job */
  const ex3 = catalogo.expirar();
  check('job idempotente', ex3.liberadas === 0 && ex3.cerradas === 0, JSON.stringify(ex3));
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
