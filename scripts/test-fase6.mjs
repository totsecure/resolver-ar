#!/usr/bin/env node
/* test-fase6.mjs — hook del checker, cola, resultados y marcado manual. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-fase6-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.PUBLICAR_DIRECTO = '1';

const auth = await import('../lib/auth.js');
const checker = await import('../lib/checker.js');
const stock = await import('../lib/stock.js');
const { base } = stock;

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }

console.log('TEST fase 6 — ' + new Date().toISOString());
auth.migrar();
checker.migrar();
const admin = auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });

try {
  const numeros = [stock.demoNumero('411111', 16), stock.demoNumero('411111', 16), stock.demoNumero('411111', 16)];
  const texto = numeros.map((n) => n + '|12|28|123').join('\n');
  const carga = stock.cargar(texto, { flexible: true, fase: 'confirmar', nombre: 'lote-checker', usuario: 'test' });
  check('lote cargado', carga.nuevas === 3 && carga.lote_id > 0, 'lote=' + carga.lote_id);
  const loteId = carga.lote_id;
  const ids = carga.ids;

  /* 1. cola idempotente */
  const e1 = checker.encolarLote(loteId);
  check('encolar lote', e1.ok && e1.encoladas === 3, 'encoladas=' + e1.encoladas);
  const e2 = checker.encolarLote(loteId);
  check('encolar lote es idempotente', e2.encoladas === 0);
  check('cola pendiente', checker.pendientes(10).length === 3);
  const res0 = checker.resumen();
  check('resumen checker', res0.cola_pendiente === 3 && res0.sin_verificar === 3 && res0.proveedor === 'manual', JSON.stringify(res0));

  /* 2. manual: no procesa solo, el admin marca */
  const p0 = await checker.procesar(10);
  check('procesar con manual no decide', p0.manual === true && p0.procesados === 0 && p0.pendientes === 3, JSON.stringify(p0));

  const m1 = checker.marcarManual(ids[0], 'ok', 'se ve bien', admin.id);
  check('marcar OK manual', m1.ok && m1.estado === 'ok');
  check('cc queda verif ok', base().prepare('SELECT verif_estado, verif_intentos FROM cc WHERE id=?').get(ids[0]).verif_estado === 'ok');
  const m2 = checker.marcarManual(ids[1], 'falla', 'sin saldo', admin.id);
  check('marcar falla manual', m2.ok && m2.estado === 'falla');
  check('cc queda verif falla', base().prepare('SELECT verif_estado FROM cc WHERE id=?').get(ids[1]).verif_estado === 'falla');
  check('cola baja a 1', checker.resumen().cola_pendiente === 1);
  let malo = null;
  try { checker.marcarManual(ids[2], 'otro', 'x', admin.id); } catch (e) { malo = e.message; }
  check('estado manual invalido rechazado', malo === 'estado invalido', String(malo));

  /* 3. hook directo con el proveedor manual */
  const v = await checker.verificar({ id: ids[2] });
  check('hook verificar manual', v.estado === 'pendiente' && v.proveedor === 'manual');
  check('hook no decide verif_estado', base().prepare('SELECT verif_estado FROM cc WHERE id=?').get(ids[2]).verif_estado === 'sin_verificar');
  check('hook incrementa intentos', base().prepare('SELECT verif_intentos FROM cc WHERE id=?').get(ids[2]).verif_intentos >= 1);

  /* 4. proveedor externo enchufable sin tocar el resto */
  checker.registrarProveedor('prueba', async (cc) => ({ estado: 'ok', motivo: 'proveedor externo simulado', proveedor: 'prueba' }));
  check('proveedor registrado', checker.proveedoresDisponibles().includes('prueba'));
  process.env.CHECKER_PROVEEDOR = 'prueba';
  const p1 = await checker.procesar(10);
  check('procesar con externo', p1.procesados === 1, JSON.stringify(p1));
  check('externo deja verif ok', base().prepare('SELECT verif_estado FROM cc WHERE id=?').get(ids[2]).verif_estado === 'ok');
  check('cola vacia', checker.resumen().cola_pendiente === 0);
  delete process.env.CHECKER_PROVEEDOR;

  /* 5. resultados e historial */
  const resultados = checker.resultados({ loteId });
  check('resultados guardados', resultados.length >= 4, 'n=' + resultados.length);
  check('resultado externo con proveedor', resultados.some((r) => r.proveedor === 'prueba' && r.estado === 'ok'));
  check('resultados enmascarados', resultados.every((r) => r.numero_mask.includes('xxxx')));
  check('sin verificar restante', checker.tarjetasSinVerificar(10).length === 0);
  check('auditoria checker', base().prepare("SELECT COUNT(*) n FROM auditoria WHERE accion LIKE 'CHECKER%'").get().n >= 4);
  check('encolar de nuevo no duplica', checker.encolarLote(loteId).encoladas === 0);
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
