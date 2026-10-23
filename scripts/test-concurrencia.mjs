#!/usr/bin/env node
/* test-concurrencia.mjs — reservas simultáneas, saldo, vencimiento y doble venta. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RAIZ = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-conc-'));
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
const ok = (n, d) => { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); };
const fail = (n, d) => { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); };
const check = (n, c, d) => c ? ok(n, d) : fail(n, d || 'sin detalle');
const precio = 100;

function sembrar(bin) {
  const d = base();
  let numero;
  do { numero = stock.demoNumero(bin, 16); } while (d.prepare('SELECT 1 FROM cc WHERE numero=?').get(numero));
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  const info = d.prepare(
    'INSERT INTO cc(numero, mes, anio, cvv, bin, marca, estado, precio_num, creado, ref, titular, dni, banco, verif_estado, es_test) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)'
  ).run(numero, '12', '2028', '321', bin, 'Visa', 'DISPONIBLE', precio, new Date().toISOString(), ref, 'Titular Test', '30123456', 'Banco Test', 'sin_verificar');
  return Number(info.lastInsertRowid);
}

function alta(usuario, dni) {
  const inv = vendedores.crearInvitacion({ creadoPor: 1 });
  vendedores.registrar({ codigo: inv.codigo, usuario, clave: 'clave' + usuario + '1', nombre: usuario, dni, telefono: '11555', alias_cbu: usuario + '.alias', es_test: 1 });
  const v = vendedores.listar({ estado: 'pendiente' }).find((x) => x.usuario === usuario);
  vendedores.revisarAlta(v.usuario_id, 1, true);
  return v.usuario_id;
}

function hijoReserva(uid, opts, startMs) {
  const url = pathToFileURL(path.join(RAIZ, 'lib', 'catalogo.js')).href;
  const code = `
    const cat = await import(${JSON.stringify(url)});
    const t = Number(process.env.START_MS);
    while (Date.now() < t) {}
    let r;
    try { r = cat.reservar(Number(process.env.UID), ${JSON.stringify(opts)}); }
    catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    process.stdout.write(JSON.stringify(r));
  `;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: RAIZ, env: { ...process.env, UID: String(uid), START_MS: String(startMs) },
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

function hijoPago(uid, reservaId, startMs) {
  const url = pathToFileURL(path.join(RAIZ, 'lib', 'catalogo.js')).href;
  const code = `
    const cat = await import(${JSON.stringify(url)});
    const t = Number(process.env.START_MS);
    while (Date.now() < t) {}
    let r;
    try { r = cat.pagar(Number(process.env.UID), { id: Number(process.env.RID) }); }
    catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    process.stdout.write(JSON.stringify(r));
  `;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: RAIZ, env: { ...process.env, UID: String(uid), RID: String(reservaId), START_MS: String(startMs) },
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

async function tanda(ids, tareas) {
  const start = Date.now() + 1800;
  return Promise.all(tareas.map((t, i) => hijoReserva(ids[i % 2], t, start)));
}

console.log('TEST concurrencia — ' + new Date().toISOString());
auth.migrar(); wallet.migrar(); vendedores.migrar(); catalogo.migrar();
try {
  auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });
  const idA = alta('conca', '40111222');
  const idB = alta('concb', '40222333');
  vendedores.setLimites(idA, { limite_reservas_dia: 0, limite_simultaneas: 0 });
  vendedores.setLimites(idB, { limite_reservas_dia: 0, limite_simultaneas: 0 });
  wallet.acreditar(idA, 100000, 'carga');
  wallet.acreditar(idB, 100000, 'carga');
  const saldoInicial = wallet.saldoDe(idA) + wallet.saldoDe(idB);
  const ids = [idA, idB];

  /* 1. 20 reservas simultáneas sobre la MISMA tarjeta, 5 veces. */
  const cards1 = Array.from({ length: 5 }, () => sembrar('411111'));
  const errores = [];
  for (let vuelta = 1; vuelta <= 5; vuelta++) {
    const card = cards1[vuelta - 1];
    const r = await tanda(ids, Array.from({ length: 20 }, () => ({ refs: [card] })));
    const winners = r.filter((x) => x.j && x.j.ok);
    const perdedores = r.filter((x) => !(x.j && x.j.ok));
    const malos = perdedores.filter((x) => !x.j || !['sin_stock', 'saldo_insuficiente'].includes(x.j.error));
    for (const x of malos) errores.push(x.j ? x.j.error : (x.err || 'sin salida'));
    console.log('  vuelta ' + vuelta + ': ganadoras=' + winners.length + ' sin_stock=' + perdedores.filter((x) => x.j && x.j.error === 'sin_stock').length + ' otros=' + (perdedores.length - perdedores.filter((x) => x.j && x.j.error === 'sin_stock').length));
    check('CONC 1/' + vuelta + ': exactamente 1 ganadora', winners.length === 1, 'ganadoras=' + winners.length);
    check('CONC 1/' + vuelta + ': 19 perdedoras "sin_stock"', perdedores.length === 19 && perdedores.every((x) => x.j && x.j.error === 'sin_stock'), perdedores.map((x) => x.j && x.j.error).join(','));
    check('CONC 1/' + vuelta + ': una reserva/una RESERVADA', base().prepare('SELECT COUNT(*) n FROM reservas WHERE cc_id=?').get(card).n === 1 && base().prepare('SELECT estado FROM cc WHERE id=?').get(card).estado === 'RESERVADA');
  }
  check('CONC 1: sin errores raros', errores.length === 0, errores.join(' | '));

  /* 2. 5 tarjetas y 20 reservas: exactamente 5 ganadoras. */
  const cards2 = Array.from({ length: 5 }, () => sembrar('516585'));
  const r2 = await tanda(ids, Array.from({ length: 20 }, () => ({ bin: '516585', cantidad: 1 })));
  const win2 = r2.filter((x) => x.j && x.j.ok);
  const lose2 = r2.filter((x) => !(x.j && x.j.ok));
  const ids2 = new Set(win2.map((x) => x.j.items && x.j.items[0] && x.j.items[0].id).filter(Boolean));
  console.log('  bloque 5 tarjetas: ganadoras=' + win2.length + ' sin_stock=' + lose2.filter((x) => x.j && x.j.error === 'sin_stock').length + ' tarjetas_distintas=' + ids2.size);
  check('CONC 2: exactamente 5 ganadoras', win2.length === 5, 'ganadoras=' + win2.length);
  check('CONC 2: 15 perdedoras', lose2.length === 15 && lose2.every((x) => x.j && x.j.error === 'sin_stock'), lose2.map((x) => x.j && x.j.error).join(','));
  check('CONC 2: 5 tarjetas distintas RESERVADAS', ids2.size === 5 && base().prepare("SELECT COUNT(*) n FROM cc WHERE bin='516585' AND estado='RESERVADA'").get().n === 5);
  check('CONC 2: ni una reserva de más', base().prepare("SELECT COUNT(*) n FROM reservas r JOIN cc c ON c.id=r.cc_id WHERE c.bin='516585'").get().n === 5);

  /* 3. Saldo exacto: 10 ganadoras (5 + 5) * precio. */
  const saldoFinal = wallet.saldoDe(idA) + wallet.saldoDe(idB);
  const movimientos = base().prepare("SELECT COALESCE(SUM(monto),0) s FROM mov_saldo WHERE tipo='reserva'").get().s;
  check('CONC 3: saldo descuenta 10 * precio', saldoInicial - saldoFinal === 10 * precio, 'delta=' + (saldoInicial - saldoFinal) + ' esperado=' + (10 * precio));
  check('CONC 3: ledger coincide', movimientos === -10 * precio, 'ledger=' + movimientos);

  /* 4. Reserva impaga vencida: vuelve a DISPONIBLE y devuelve saldo. */
  const card4 = sembrar('411111');
  const antes4 = wallet.saldoDe(idA);
  const r4 = catalogo.reservar(idA, { refs: [card4] });
  check('CONC 4: reserva impaga creada', r4.ok === true && wallet.saldoDe(idA) === antes4 - precio);
  const res4 = base().prepare('SELECT id FROM reservas WHERE cc_id=? AND estado=\'activa\'').get(card4).id;
  base().prepare('UPDATE reservas SET expira=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), res4);
  const ex4 = catalogo.expirar();
  check('CONC 4: vuelve a DISPONIBLE', base().prepare('SELECT estado FROM cc WHERE id=?').get(card4).estado === 'DISPONIBLE' && ex4.liberadas >= 1);
  check('CONC 4: saldo devuelto exacto', wallet.saldoDe(idA) === antes4, 'saldo=' + wallet.saldoDe(idA) + ' antes=' + antes4);

  /* 5. Doble venta: dos reservas de la misma tarjeta pagan casi juntas. */
  const card5 = sembrar('411111');
  const exp = new Date(Date.now() + 15 * 60000).toISOString();
  base().prepare("UPDATE cc SET estado='RESERVADA', reservado_por=?, reservado_hasta=? WHERE id=?").run(String(idA), exp, card5);
  const insR = base().prepare('INSERT INTO reservas(grupo, cc_id, usuario_id, precio, creado, expira, estado) VALUES(?,?,?,?,?,?,?)');
  const resA = Number(insR.run('CONC-DOBLE-A', card5, idA, precio, new Date().toISOString(), exp, 'activa').lastInsertRowid);
  const resB = Number(insR.run('CONC-DOBLE-B', card5, idB, precio, new Date().toISOString(), exp, 'activa').lastInsertRowid);
  const antesReservaA = wallet.saldoDe(idA);
  const antesReservaB = wallet.saldoDe(idB);
  wallet.debitar(idA, precio, 'reserva', 'CONC-DOBLE-A', 'débito simulado doble venta');
  wallet.debitar(idB, precio, 'reserva', 'CONC-DOBLE-B', 'débito simulado doble venta');
  const start5 = Date.now() + 1800;
  const p5 = await Promise.all([hijoPago(idA, resA, start5), hijoPago(idB, resB, start5)]);
  const okPagos = p5.filter((x) => x.j && x.j.ok).length;
  console.log('  doble venta: pagos_ok=' + okPagos + ' errores=' + JSON.stringify(p5.map((x) => x.j && x.j.error)));
  const ganoA = Boolean(p5[0].j && p5[0].j.ok);
  const perdedor = ganoA ? idB : idA;
  const antesPerdedor = ganoA ? antesReservaB : antesReservaA;
  const despuesPerdedor = wallet.saldoDe(perdedor);
  console.log('  doble venta: saldo_perdedor antes=' + antesPerdedor + ' despues=' + despuesPerdedor);
  check('CONC 5: solo un pago gana', okPagos === 1, 'ok=' + okPagos);
  check('CONC 5: saldo del perdedor intacto', despuesPerdedor === antesPerdedor, 'antes=' + antesPerdedor + ' despues=' + despuesPerdedor);
  check('CONC 5: cc PAGADA una vez', base().prepare('SELECT estado FROM cc WHERE id=?').get(card5).estado === 'PAGADA');
  const pagada = base().prepare("SELECT id FROM reservas WHERE cc_id=? AND estado='pagada'").get(card5);
  if (pagada) base().prepare('UPDATE reservas SET expira=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), pagada.id);
  catalogo.expirar();
  check('CONC 5: una sola VENDIDA', base().prepare('SELECT estado FROM cc WHERE id=?').get(card5).estado === 'VENDIDA' && base().prepare("SELECT COUNT(*) n FROM reservas WHERE cc_id=? AND estado='ok'").get(card5).n === 1);
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); console.log('  limpieza: temp DB eliminada (es_test=1)'); } catch (_) {}
}
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
