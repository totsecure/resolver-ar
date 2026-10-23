#!/usr/bin/env node
/* test-asientos.mjs — cada camino que cambia saldo debe emitir un asiento
 * balanceado y linkear mov_saldo.asiento_id. Corre en una base temporal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-asientos-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.VENTA_SIN_SALDO = '0';

const stock = await import('../lib/stock.js');
const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const recargas = await import('../lib/recargas.js');
const catalogo = await import('../lib/catalogo.js');
const vendedores = await import('../lib/vendedores.js');
const ledger = await import('../lib/ledger.js');

let ok = 0;
let fail = 0;
const fallos = [];
const check = (nombre, fn) => {
  try { fn(); ok++; console.log('  OK    ' + nombre); }
  catch (e) { fail++; fallos.push(nombre + ' :: ' + String(e?.message || e)); console.log('  FAIL  ' + nombre + ' :: ' + String(e?.message || e)); }
};

const d = stock.base();
auth.migrar(); wallet.migrar(); recargas.migrar(); catalogo.migrar(); vendedores.migrar();

d.prepare("INSERT INTO usuarios(id, usuario, nombre, rol, hash, salt, estado, creado) VALUES(1,'e2e-asientos','E2E','vendedor','x','y','activo',?)")
  .run(new Date().toISOString());
d.prepare("INSERT INTO vendedores(usuario_id, dni, estado, limite_reservas_dia, limite_simultaneas, creado) VALUES(1,'99999999','activo',100,100,?)")
  .run(new Date().toISOString());

let n = 0;
function nuevaCC() {
  n += 1;
  const numero = '411111111111' + String(1000 + n);
  const info = d.prepare(
    "INSERT INTO cc(numero, bin, marca, estado, precio_num, etiqueta, creado, es_test) VALUES(?, '411111','Visa','DISPONIBLE',50,'E2E',?,1)"
  ).run(numero, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

function ultimoMov(uid = 1) {
  return d.prepare('SELECT * FROM mov_saldo WHERE usuario_id=? ORDER BY id DESC LIMIT 1').get(uid);
}
function verificar(nombre, uid = 1) {
  check(nombre, () => {
    const mv = ultimoMov(uid);
    if (!mv) throw new Error('no hay mov_saldo');
    if (mv.asiento_id == null) throw new Error('mov_saldo sin asiento_id');
    const suma = d.prepare('SELECT COALESCE(SUM(monto),0) s FROM ledger_lineas WHERE asiento_id=?').get(mv.asiento_id).s;
    if (Number(suma) !== 0) throw new Error('asiento ' + mv.asiento_id + ' suma ' + suma);
    const saldo = d.prepare('SELECT saldo FROM saldos WHERE usuario_id=?').get(uid);
    const led = ledger.saldoLedger(uid);
    if (!saldo || Number(saldo.saldo) !== led) throw new Error('saldo ' + (saldo && saldo.saldo) + ' != ledger ' + led);
  });
}

console.log('ASIENTOS POR CAMINO — base temporal');
console.log('');

const rec = recargas.crear(1, { monto: 100, comprobante: 'test' });
recargas.revisar(rec.id, 99, true);
verificar('recarga aprobada (recargas.revisar)');

const cc1 = nuevaCC();
const r1 = catalogo.reservar(1, { refs: [cc1] });
if (!r1.ok) throw new Error('reserva falló: ' + JSON.stringify(r1));
verificar('reserva debita saldo (catalogo.reservar)');

const pago = catalogo.pagar(1, { grupo: r1.grupo });
if (!pago.ok) throw new Error('pago falló: ' + JSON.stringify(pago));
verificar('pago de reserva (catalogo.pagar)');
check('asiento de venta balanceado', () => {
  const a = d.prepare("SELECT id FROM ledger_asientos WHERE idem_key=?").get('venta:' + r1.grupo);
  if (!a) throw new Error('no se creó asiento de venta');
  const s = d.prepare('SELECT COALESCE(SUM(monto),0) s FROM ledger_lineas WHERE asiento_id=?').get(a.id).s;
  if (Number(s) !== 0) throw new Error('venta suma ' + s);
});

const cc2 = nuevaCC();
const r2 = catalogo.reservar(1, { refs: [cc2] });
const reserva2 = d.prepare('SELECT id FROM reservas WHERE grupo=?').get(r2.grupo);
const cancel = catalogo.cancelar(1, reserva2.id);
if (!cancel.ok) throw new Error('cancelar falló: ' + JSON.stringify(cancel));
verificar('cancelación reembolsa (catalogo.cancelar)');

wallet.ajustar(1, 10, 'ajuste de prueba', 99);
verificar('ajuste admin (wallet.ajustar)');

wallet.comision(1, 5, 'com-test', 'comisión de prueba');
verificar('comisión (wallet.comision)');

wallet.acreditar(1, 50, 'devolucion_reclamo', 'reclamo-test', 'devolución reclamo');
verificar('devolución de reclamo (tipo devolucion_reclamo)');

wallet.debitarForzado(1, 3, 'ajuste_forzado', 'forzado-test', 'débito forzado');
verificar('débito forzado con saldo negativo permitido');

check('todos los movimientos tienen asiento', () => {
  const n = d.prepare('SELECT COUNT(*) n FROM mov_saldo WHERE asiento_id IS NULL').get().n;
  if (n) throw new Error(n + ' sin asiento');
});
check('todos los asientos balancean', () => {
  const malos = d.prepare(
    'SELECT a.id, SUM(l.monto) s FROM ledger_asientos a JOIN ledger_lineas l ON l.asiento_id=a.id ' +
    'GROUP BY a.id HAVING SUM(l.monto)<>0'
  ).all();
  if (malos.length) throw new Error(JSON.stringify(malos));
});

d.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(ok + ' OK / ' + fail + ' FAIL');
if (fail) { for (const f of fallos) console.log('  - ' + f); process.exit(1); }
process.exit(0);
