#!/usr/bin/env node
/* e2e-seed.mjs — siembra la base DESCARTABLE de los tests E2E.
 *
 * Nunca toca datos/stock.db: exige RESOLVER_STOCK_DB apuntando fuera de datos/.
 * Borra esa base, crea el esquema con base() de lib/stock.js y carga un fixture
 * determinista de 24 tarjetas, todas con es_test=1.
 *
 *   RESOLVER_STOCK_DB=/Users/bunker/resolver/.e2e/stock.db node scripts/e2e-seed.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const RAIZ = '/Users/bunker/resolver';
const RUTA = process.env.RESOLVER_STOCK_DB || path.join(RAIZ, '.e2e', 'stock.db');

if (!RUTA.includes('.e2e')) {
  console.error('ERROR: RESOLVER_STOCK_DB debe apuntar a .e2e/ (recibido: ' + RUTA + ')');
  process.exit(1);
}
process.env.RESOLVER_STOCK_DB = RUTA;

const DIR = path.dirname(RUTA);
fs.mkdirSync(DIR, { recursive: true });
for (const f of [RUTA, RUTA + '-wal', RUTA + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch (_) {}
}

/* Fixture: número, estado, eliminado, precios, saldo. BINs variados a propósito. */
const TARJETAS = [
  // DISPONIBLE (8): 3 con precio, 5 sin precio -> banner "5 sin precio"
  ['4111111111111111', 'DISPONIBLE', 0, 15000, null, 120000, 150000, '411111', 'Visa', 'Banco Nacion', 'AR', 'debito', 'classic'],
  ['4111111111111128', 'DISPONIBLE', 0, 25000, 45000, null, null, '411111', 'Visa', 'Banco Nacion', 'AR', 'debito', 'gold'],
  ['5165850000000008', 'DISPONIBLE', 0, 35000, null, null, null, '516585', 'Master', 'Galicia', 'AR', 'credito', 'gold'],
  ['5165850000000016', 'DISPONIBLE', 0, null, null, null, null, '516585', 'Master', 'Galicia', 'AR', 'credito', 'classic'],
  ['5456520000000008', 'DISPONIBLE', 0, null, null, null, null, '545652', 'Master', 'BBVA', 'AR', 'credito', 'gold'],
  ['4507990000000008', 'DISPONIBLE', 0, null, null, null, null, '450799', 'Visa', 'Santander', 'AR', 'debito', 'classic'],
  ['6011110000000008', 'DISPONIBLE', 0, null, null, null, null, '601111', 'Discover', 'Discover', 'US', 'credito', 'classic'],
  ['5164780000000008', 'DISPONIBLE', 0, null, null, null, null, '516478', 'Master', null, null, null, null],
  // REVISION (5) sin precio
  ['4111110000000016', 'REVISION', 0, null, null, null, null, '411111', 'Visa', 'Banco Nacion', 'AR', 'debito', 'classic'],
  ['4111110000000024', 'REVISION', 0, null, null, null, null, '411111', 'Visa', 'Banco Nacion', 'AR', 'debito', 'gold'],
  ['5456520000000016', 'REVISION', 0, null, null, null, null, '545652', 'Master', 'BBVA', 'AR', 'credito', 'gold'],
  ['2223000000000008', 'REVISION', 0, null, null, null, null, '222300', 'Master', 'Naranja', 'AR', 'credito', 'classic'],
  ['4023620000000008', 'REVISION', 0, null, null, null, null, '402362', 'Visa', 'Patagonia', 'AR', 'debito', 'classic'],
  // RESERVADA (3)
  ['4111110000000032', 'RESERVADA', 0, null, null, null, null, '411111', 'Visa', 'Banco Nacion', 'AR', 'debito', 'classic'],
  ['5165850000000024', 'RESERVADA', 0, null, null, null, null, '516585', 'Master', 'Galicia', 'AR', 'credito', 'gold'],
  ['4507990000000016', 'RESERVADA', 0, null, null, null, null, '450799', 'Visa', 'Santander', 'AR', 'debito', 'classic'],
  // VENDIDA (4)
  ['4111110000000040', 'VENDIDA', 0, 15000, null, null, null, '411111', 'Visa', 'Banco Nacion', 'AR', 'debito', 'classic'],
  ['5165850000000032', 'VENDIDA', 0, 20000, null, null, null, '516585', 'Master', 'Galicia', 'AR', 'credito', 'gold'],
  ['5456520000000024', 'VENDIDA', 0, 30000, null, null, null, '545652', 'Master', 'BBVA', 'AR', 'credito', 'gold'],
  ['6011110000000016', 'VENDIDA', 0, 10000, null, null, null, '601111', 'Discover', 'Discover', 'US', 'credito', 'classic'],
  // PAPELERA (2): eliminado=1, estados distintos para probar restaurar
  ['4023620000000016', 'DISPONIBLE', 1, null, null, null, null, '402362', 'Visa', 'Patagonia', 'AR', 'debito', 'classic'],
  ['2223000000000016', 'REVISION', 1, null, null, null, null, '222300', 'Master', 'Naranja', 'AR', 'credito', 'classic'],
  // BAJA (2): no aparecen en pestañas, sirven de contraste
  ['4507990000000024', 'BAJA', 0, null, null, null, null, '450799', 'Visa', 'Santander', 'AR', 'debito', 'classic'],
  ['371449000000016', 'BAJA', 0, null, null, null, null, '371449', 'Amex', 'Amex', 'US', 'credito', 'gold'],
];

const stock = await import(pathToFileURL(path.join(RAIZ, 'lib', 'stock.js')).href);
const auth = await import(pathToFileURL(path.join(RAIZ, 'lib', 'auth.js')).href);
const d = stock.base();

const refPorBin = new Map();
const creado = '2026-01-01T00:00:00.000Z';

const ins = d.prepare(
  'INSERT INTO cc(numero, mes, anio, cvv, bin, marca, banco, pais, tipo, nivel, ' +
  'dni, titular, mail, telefono, direccion, ciudad, provincia, zip, ' +
  'estado, etiqueta, refund, precio_num, precio_cuotas, saldo, saldo_ref, ' +
  'saldo_disp, saldo_total, saldo_disp_num, saldo_total_num, creado, ref, ' +
  'es_test, eliminado, huella, codigo_venta) ' +
  'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
);

d.exec('BEGIN');
try {
  TARJETAS.forEach((t, i) => {
    const [numero, estado, eliminado, precio, cuotas, saldo, saldoRef, bin, marca, banco, pais, tipo, nivel] = t;
    const ref = (refPorBin.get(bin) || 0) + 1;
    refPorBin.set(bin, ref);
    const n = String(i + 1).padStart(2, '0');
    const titular = 'E2E-' + n;
    ins.run(
      numero, '12', '28', '123', bin, marca, banco, pais, tipo, nivel,
      null, titular, null, null, null, null, null, (i % 3 === 0 ? '1000' : null),
      estado, 'E2E', 1, precio, cuotas, saldo, saldoRef,
      saldo, saldoRef, saldo, saldoRef, creado, ref,
      1, eliminado, crypto.createHash('sha256').update(numero).digest('hex'),
      estado === 'VENDIDA' ? 'E2E-V' + (i + 1) : null
    );
  });
  d.exec('COMMIT');
} catch (e) {
  try { d.exec('ROLLBACK'); } catch (_) {}
  throw e;
}

/* Usuario para el test de login real (operador exige 2FA). */
try {
  auth.crearUsuario({ usuario: 'e2e-admin', nombre: 'E2E Admin', rol: 'operador', clave: 'clave-e2e-123', es_test: 1 });
} catch (e) {
  if (!/ya existe/.test(String(e?.message || e))) throw e;
}
d.prepare("UPDATE usuarios SET totp_secret=?, totp_activo=1, totp_pendiente=NULL WHERE usuario='e2e-admin'")
  .run('JBSWY3DPEHPK3PXP');

/* Saldeadas del fixture: varias para probar /saldeadas y /pedir N sin agotarlas.
 * Con saldo para validar el formato "N> mascara - disp/ref". */
d.prepare("UPDATE cc SET etiqueta='Saldeadas' WHERE titular IN ('E2E-01','E2E-02','E2E-03','E2E-04','E2E-05','E2E-06','E2E-07','E2E-08')").run();
d.prepare("UPDATE cc SET saldo=5000000, saldo_ref=8000000, saldo_disp_num=5000000, saldo_total_num=8000000 WHERE titular IN ('E2E-01','E2E-03','E2E-05','E2E-07')").run();
d.prepare("UPDATE cc SET saldo=1000000, saldo_ref=2000000, saldo_disp_num=1000000, saldo_total_num=2000000 WHERE titular IN ('E2E-02','E2E-04','E2E-06','E2E-08')").run();

/* Vencimientos para los tests de A2. */
d.prepare("UPDATE cc SET dias_para_vencer=20, vencida=0 WHERE titular='E2E-05'").run();
d.prepare("UPDATE cc SET dias_para_vencer=-5, vencida=1 WHERE titular='E2E-06'").run();
d.prepare("UPDATE cc SET dias_para_vencer=75, vencida=0 WHERE titular='E2E-07'").run();

const porEstado = d.prepare('SELECT estado, COALESCE(eliminado,0) eliminado, COUNT(*) n FROM cc GROUP BY 1,2 ORDER BY 1,2').all();
const total = d.prepare('SELECT COUNT(*) n FROM cc').get().n;
const esTest = d.prepare('SELECT COUNT(*) n FROM cc WHERE es_test=1').get().n;
d.close();

console.log('e2e-seed: ' + total + ' tarjetas en ' + RUTA + ' (es_test=1: ' + esTest + ')');
for (const r of porEstado) console.log('  ' + r.estado + (r.eliminado ? ' (papelera)' : '') + ': ' + r.n);
if (total !== 24 || esTest !== 24) {
  console.error('ERROR: el fixture debe tener 24 tarjetas es_test=1');
  process.exit(1);
}
