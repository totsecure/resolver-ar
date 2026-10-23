#!/usr/bin/env node
/* limpiar-tests.mjs — limpieza quirúrgica: SOLO es_test=1.
 *
 *   node scripts/limpiar-tests.mjs       # dry-run, lista exacta
 *   node scripts/limpiar-tests.mjs --si  # borra en una transacción
 *
 * No usa BIN, nombre de lote ni prefijo de usuario para decidir.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const RUTA = process.env.RESOLVER_STOCK_DB || path.join(import.meta.dirname, '..', 'datos', 'stock.db');
const ejecutar = process.argv.includes('--si');
const db = new DatabaseSync(RUTA);
db.exec('PRAGMA busy_timeout = 8000');

function tabla(nombre) { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nombre); }
function cols(nombre) { return new Set((db.prepare('PRAGMA table_info(' + nombre + ')').all() || []).map((c) => c.name)); }
function all(sql, ...p) { return db.prepare(sql).all(...p); }
function one(sql, ...p) { return db.prepare(sql).get(...p); }
function n(sql, ...p) { return Number(one(sql, ...p)?.n || 0); }

if (!cols('cc').has('es_test')) db.exec('ALTER TABLE cc ADD COLUMN es_test INTEGER DEFAULT 0');
if (tabla('usuarios') && !cols('usuarios').has('es_test')) db.exec('ALTER TABLE usuarios ADD COLUMN es_test INTEGER DEFAULT 0');
if (tabla('lotes_cc') && !cols('lotes_cc').has('es_test')) db.exec('ALTER TABLE lotes_cc ADD COLUMN es_test INTEGER DEFAULT 0');

db.exec('BEGIN IMMEDIATE');
try {
  db.exec('CREATE TEMP TABLE _test_users(id INTEGER PRIMARY KEY)');
  db.exec('CREATE TEMP TABLE _test_cc(id INTEGER PRIMARY KEY)');
  db.exec('CREATE TEMP TABLE _test_pedidos(id INTEGER PRIMARY KEY)');
  db.exec('INSERT INTO _test_users SELECT id FROM usuarios WHERE COALESCE(es_test,0)=1');
  db.exec('INSERT INTO _test_cc SELECT id FROM cc WHERE COALESCE(es_test,0)=1');
  db.exec('INSERT OR IGNORE INTO _test_pedidos SELECT DISTINCT pt.pedido_id FROM pedido_tarjetas pt JOIN _test_cc c ON c.id=pt.cc_id');
  db.exec('INSERT OR IGNORE INTO _test_pedidos SELECT DISTINCT p.id FROM pedidos p JOIN _test_users u ON u.id=p.usuario_id');
  db.exec('INSERT OR IGNORE INTO _test_pedidos SELECT DISTINCT p.id FROM pedidos p JOIN reservas r ON r.grupo=p.grupo JOIN _test_users u ON u.id=r.usuario_id');

  const tarjetas = all(
    'SELECT c.id, c.numero, c.lote, c.bin, c.estado FROM cc c JOIN _test_cc t ON t.id=c.id ORDER BY c.id'
  );
  const usuarios = all(
    'SELECT u.id, u.usuario, u.nombre, u.rol FROM usuarios u JOIN _test_users t ON t.id=u.id ORDER BY u.id'
  );
  const resumen = {
    modo: ejecutar ? 'BORRAR' : 'DRY-RUN',
    usuarios: usuarios.length,
    tarjetas: tarjetas.length,
    pedidos: n('SELECT COUNT(*) n FROM _test_pedidos'),
    reservas: n('SELECT COUNT(*) n FROM reservas WHERE usuario_id IN (SELECT id FROM _test_users) OR cc_id IN (SELECT id FROM _test_cc)'),
    saldos: n('SELECT COUNT(*) n FROM saldos WHERE usuario_id IN (SELECT id FROM _test_users)'),
    mov_saldo: n('SELECT COUNT(*) n FROM mov_saldo WHERE usuario_id IN (SELECT id FROM _test_users)'),
    movs: n('SELECT COUNT(*) n FROM movs WHERE cc_id IN (SELECT id FROM _test_cc) OR usuario IN (SELECT CAST(id AS TEXT) FROM _test_users)'),
    notificaciones: n('SELECT COUNT(*) n FROM notificaciones WHERE usuario_id IN (SELECT id FROM _test_users)'),
    tokens: n('SELECT COUNT(*) n FROM api_tokens WHERE usuario_id IN (SELECT id FROM _test_users)'),
    sesiones: n('SELECT COUNT(*) n FROM sesiones WHERE usuario_id IN (SELECT id FROM _test_users)'),
    recargas: n('SELECT COUNT(*) n FROM recargas WHERE usuario_id IN (SELECT id FROM _test_users)'),
    reclamos: n('SELECT COUNT(*) n FROM reclamos WHERE usuario_id IN (SELECT id FROM _test_users)'),
    quedan_usuarios: n('SELECT COUNT(*) n FROM usuarios'),
    quedan_tarjetas: n('SELECT COUNT(*) n FROM cc'),
  };

  console.log(JSON.stringify(resumen, null, 2));
  console.log('\nTARJETAS A BORRAR (número completo, lote):');
  for (const c of tarjetas) console.log('  #' + c.id + '  ' + c.numero + '  lote=' + (c.lote || '(sin lote)') + '  bin=' + (c.bin || '') + '  estado=' + c.estado);
  console.log('\nUSUARIOS A BORRAR (usuario, nombre, rol):');
  for (const u of usuarios) console.log('  #' + u.id + '  ' + u.usuario + '  ' + (u.nombre || '') + '  rol=' + u.rol);

  if (!ejecutar) {
    console.log('\nDRY-RUN: no se borró nada. Usá --si para confirmar.');
    db.exec('ROLLBACK');
    process.exit(0);
  }

  db.exec('DELETE FROM pedido_eventos WHERE pedido_id IN (SELECT id FROM _test_pedidos)');
  db.exec('DELETE FROM pedido_tarjetas WHERE pedido_id IN (SELECT id FROM _test_pedidos) OR cc_id IN (SELECT id FROM _test_cc)');
  db.exec('DELETE FROM pedidos WHERE id IN (SELECT id FROM _test_pedidos)');
  db.exec('DELETE FROM reservas WHERE usuario_id IN (SELECT id FROM _test_users) OR cc_id IN (SELECT id FROM _test_cc)');
  db.exec('DELETE FROM checker_resultados WHERE cc_id IN (SELECT id FROM _test_cc)');
  db.exec('DELETE FROM checker_cola WHERE cc_id IN (SELECT id FROM _test_cc)');
  db.exec('DELETE FROM movs WHERE cc_id IN (SELECT id FROM _test_cc) OR usuario IN (SELECT CAST(id AS TEXT) FROM _test_users)');
  db.exec('DELETE FROM mov_saldo WHERE usuario_id IN (SELECT id FROM _test_users)');
  db.exec('DELETE FROM saldos WHERE usuario_id IN (SELECT id FROM _test_users)');
  db.exec('DELETE FROM notificaciones WHERE usuario_id IN (SELECT id FROM _test_users)');
  db.exec('DELETE FROM api_tokens WHERE usuario_id IN (SELECT id FROM _test_users)');
  db.exec('DELETE FROM sesiones WHERE usuario_id IN (SELECT id FROM _test_users)');
  db.exec('DELETE FROM totp_respaldo WHERE usuario_id IN (SELECT id FROM _test_users)');
  db.exec('DELETE FROM vinculaciones WHERE usuario_id IN (SELECT id FROM _test_users)');
  db.exec('DELETE FROM recargas WHERE usuario_id IN (SELECT id FROM _test_users)');
  db.exec('DELETE FROM reclamos WHERE usuario_id IN (SELECT id FROM _test_users)');
  db.exec('DELETE FROM vendedores WHERE usuario_id IN (SELECT id FROM _test_users)');
  db.exec('DELETE FROM auditoria WHERE usuario_id IN (SELECT id FROM _test_users)');
  db.exec('DELETE FROM auth_intentos WHERE usuario IN (SELECT usuario FROM usuarios WHERE id IN (SELECT id FROM _test_users))');
  db.exec('DELETE FROM cc WHERE id IN (SELECT id FROM _test_cc)');
  if (tabla('lotes_cc') && cols('lotes_cc').has('es_test')) db.exec('DELETE FROM lotes_cc WHERE COALESCE(es_test,0)=1');
  db.exec('DELETE FROM usuarios WHERE id IN (SELECT id FROM _test_users)');
  db.exec('COMMIT');

  console.log('\nBORRADO OK');
  console.log(JSON.stringify({
    quedan_usuarios: n('SELECT COUNT(*) n FROM usuarios'),
    quedan_tarjetas: n('SELECT COUNT(*) n FROM cc'),
    quedan_pedidos: n('SELECT COUNT(*) n FROM pedidos'),
    quedan_reservas: n('SELECT COUNT(*) n FROM reservas'),
  }, null, 2));
} catch (e) {
  try { db.exec('ROLLBACK'); } catch (_) {}
  console.error('ERROR limpiar-tests: ' + String(e?.message || e));
  process.exit(1);
}
