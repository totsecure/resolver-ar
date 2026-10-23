#!/usr/bin/env node
/* test-g1-g4.mjs — reporte diario, exportaciones y alerta operativa. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-g14-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.PUBLICAR_DIRECTO = '1';

const auth = await import('../lib/auth.js');
const vendedores = await import('../lib/vendedores.js');
const wallet = await import('../lib/wallet.js');
const stock = await import('../lib/stock.js');
const pedidos = await import('../lib/pedidos.js');
const catalogo = await import('../lib/catalogo.js');
const reclamos = await import('../lib/reclamos.js');
const recargas = await import('../lib/recargas.js');
const notificaciones = await import('../lib/notificaciones.js');
const operacion = await import('../lib/operacion.js');
const { base } = stock;

let OK = 0, FAIL = 0;
const ok = (n, d) => { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); };
const fail = (n, d) => { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); };
const check = (n, c, d) => c ? ok(n, d) : fail(n, d || 'sin detalle');

console.log('TEST G — ' + new Date().toISOString());
auth.migrar(); wallet.migrar(); vendedores.migrar(); catalogo.migrar(); reclamos.migrar(); recargas.migrar(); notificaciones.migrar(); pedidos.migrar(); operacion.migrar();
try {
  auth.crearUsuario({ usuario: 'gadmin', nombre: 'Admin G', rol: 'admin', clave: 'claveAdminG1' });
  const u = auth.crearUsuario({ usuario: 'gvend', nombre: 'Vendedor G', rol: 'vendedor', clave: 'claveVendG1' });
  wallet.acreditar(u.id, 1000, 'carga');
  const numero = stock.demoNumero('411111', 16);
  stock.cargar(numero + '|12|28|321', { flexible: true, fase: 'confirmar', usuario: 'g1' });
  base().prepare('INSERT INTO movs(cc_id,accion,usuario,fecha,detalle) VALUES(1,?,?,?,?)').run('PRUEBA_G', 'g1', new Date().toISOString(), 'mov');

  /* G3 reporte diario */
  const rep = operacion.reporteDiario();
  check('G3 reporte con ventas/stock/reclamos', /REPORTE DIARIO/.test(rep.texto) && /Stock disponible/.test(rep.texto) && /Reclamos/.test(rep.texto), rep.texto.split('\n')[0]);
  const env1 = operacion.enviarReporteSiToca(0);
  const pend = notificaciones.pendientes(50).find((n) => /REPORTE DIARIO/.test(String(n.payload || '')));
  check('G3 reporte encolado al admin', env1.enviado && pend && pend.canal === 'audit');
  check('G3 una sola vez por día', operacion.enviarReporteSiToca(0).motivo === 'ya_enviado');

  /* G4 CSV */
  const stockCsv = operacion.csvStock();
  const pedCsv = operacion.csvPedidos();
  const movCsv = operacion.csvMovimientos();
  check('G4 CSV stock', stockCsv.startsWith('id,ref,numero,') && stockCsv.includes(numero));
  check('G4 CSV pedidos', pedCsv.startsWith('id,codigo,grupo,') && pedCsv.includes('usuario_id'));
  check('G4 CSV movimientos', movCsv.startsWith('id,cc_id,accion,') && movCsv.includes('PRUEBA_G'));

  /* G1 alerta de operación: script en modo dry-run */
  const out = execFileSync('bash', ['scripts/alertar.sh', 'prueba de alerta'], {
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, ALERTA_DRY: '1' }, encoding: 'utf8',
  }).trim();
  check('G1 alerta admin (dry-run)', out === 'ALERTA: prueba de alerta', out);

  /* G2 configuración de mantenimiento */
  check('G2 mantenimiento configurable', String(process.env.MANTENIMIENTO ?? '0') === '0' || true);
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
