#!/usr/bin/env node
/* verificar-invariantes.mjs — chequeos de integridad del modelo de dominio.
 *
 * Read-only sobre datos/stock.db. Sale 0 solo si no hay FAIL.
 *   node scripts/verificar-invariantes.mjs
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = '/Users/bunker/resolver';
const RUTA = process.env.RESOLVER_STOCK_DB || path.join(RAIZ, 'datos', 'stock.db');
const db = new DatabaseSync(RUTA, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000');

let ok = 0;
let fail = 0;
const fallos = [];

function check(nombre, fn) {
  try {
    const detalle = fn();
    ok += 1;
    console.log('  OK    ' + nombre + (detalle ? ' :: ' + detalle : ''));
  } catch (e) {
    fail += 1;
    const motivo = String(e?.message || e);
    fallos.push({ nombre, motivo });
    console.log('  FAIL  ' + nombre + ' :: ' + motivo);
  }
}

const existe = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const uno = (sql, ...p) => db.prepare(sql).get(...p);
const todos = (sql, ...p) => db.prepare(sql).all(...p);
const sinFilas = (nombre, sql, ...p) => {
  const f = todos(sql, ...p);
  if (f.length) throw new Error(nombre + ': ' + f.length + ' caso(s), ej. ' + JSON.stringify(f[0]));
  return '';
};

console.log('INVARIANTES DE DOMINIO — ' + RUTA);
console.log('');

if (!existe('ledger_asientos')) {
  console.log('  FAIL  ledger :: no existe la tabla ledger_asientos (¿migración sin correr?)');
  process.exit(1);
}

/* ------------------------------- ledger ------------------------------- */
check('asientos balanceados (suma 0)', () => sinFilas(
  'asientos desbalanceados',
  'SELECT a.id, SUM(l.monto) s FROM ledger_asientos a LEFT JOIN ledger_lineas l ON l.asiento_id=a.id ' +
  'GROUP BY a.id HAVING COALESCE(SUM(l.monto),0) <> 0'
));

check('líneas con asiento y cuenta existentes', () => sinFilas(
  'líneas huérfanas',
  'SELECT l.id FROM ledger_lineas l ' +
  'LEFT JOIN ledger_asientos a ON a.id=l.asiento_id LEFT JOIN ledger_cuentas c ON c.id=l.cuenta_id ' +
  'WHERE a.id IS NULL OR c.id IS NULL'
));

check('asientos con al menos dos líneas', () => sinFilas(
  'asientos incompletos',
  'SELECT a.id FROM ledger_asientos a LEFT JOIN ledger_lineas l ON l.asiento_id=a.id ' +
  'GROUP BY a.id HAVING COUNT(l.id) < 2'
));

check('saldos materializados == ledger', () => sinFilas(
  'saldos que no coinciden',
  'SELECT s.usuario_id, s.saldo, COALESCE(SUM(l.monto),0) ledger FROM saldos s ' +
  'LEFT JOIN ledger_cuentas c ON c.codigo = \'wallet:\' || s.usuario_id ' +
  'LEFT JOIN ledger_lineas l ON l.cuenta_id = c.id ' +
  'GROUP BY s.usuario_id HAVING s.saldo <> COALESCE(SUM(l.monto),0)'
));

check('todo mov_saldo tiene asiento', () => {
  const n = uno('SELECT COUNT(*) n FROM mov_saldo WHERE asiento_id IS NULL').n;
  if (n) throw new Error(n + ' movimientos sin asiento');
  return '';
});

check('idem_key sin duplicados', () => sinFilas(
  'idem_key duplicada',
  'SELECT idem_key, COUNT(*) n FROM ledger_asientos WHERE idem_key IS NOT NULL GROUP BY idem_key HAVING n > 1'
));

check('wallet no negativo (sin permiso explícito)', () => sinFilas(
  'wallet negativo',
  'SELECT usuario_id, saldo FROM saldos WHERE saldo < 0'
));

/* ------------------------------- pedidos ------------------------------ */
const ESTADOS = ['reservado', 'pagado', 'entregado', 'verificado', 'vencido', 'cancelado', 'reclamo'];

check('estados de pedido válidos', () => sinFilas(
  'estados fuera del enum',
  "SELECT id, estado FROM pedidos WHERE estado NOT IN ('" + ESTADOS.join("','") + "')"
));

check('último evento == estado del pedido', () => sinFilas(
  'pedidos con evento desincronizado',
  'SELECT p.id, p.estado, (SELECT e.estado FROM pedido_eventos e WHERE e.pedido_id=p.id ORDER BY e.id DESC LIMIT 1) ultimo ' +
  'FROM pedidos p WHERE COALESCE((SELECT e.estado FROM pedido_eventos e WHERE e.pedido_id=p.id ORDER BY e.id DESC LIMIT 1), \'\') <> p.estado'
));

check('pedidos con al menos una tarjeta', () => sinFilas(
  'pedidos sin tarjetas',
  'SELECT p.id FROM pedidos p LEFT JOIN pedido_tarjetas t ON t.pedido_id=p.id GROUP BY p.id HAVING COUNT(t.id)=0'
));

check('pedido_tarjetas apunta a cc existente', () => sinFilas(
  'tarjetas de pedido huérfanas',
  'SELECT t.id FROM pedido_tarjetas t LEFT JOIN cc c ON c.id=t.cc_id WHERE c.id IS NULL'
));

check('cantidad de pedido == tarjetas', () => sinFilas(
  'cantidad inconsistente',
  'SELECT p.id, p.cantidad, COUNT(t.id) n FROM pedidos p LEFT JOIN pedido_tarjetas t ON t.pedido_id=p.id ' +
  'GROUP BY p.id HAVING p.cantidad <> COUNT(t.id)'
));

check('coherencia cc/estado de pedido', () => sinFilas(
  'cc en estado incompatible',
  "SELECT p.id, p.estado, c.estado FROM pedidos p JOIN pedido_tarjetas t ON t.pedido_id=p.id JOIN cc c ON c.id=t.cc_id " +
  "WHERE (p.estado='pagado' AND c.estado <> 'PAGADA') " +
  "   OR (p.estado IN ('entregado','verificado') AND c.estado <> 'VENDIDA')"
));

/* ------------------------------- reservas ----------------------------- */
check('reservas activas con vencimiento', () => sinFilas(
  'reservas activas sin vence',
  "SELECT id FROM reservas WHERE estado='activa' AND (expira IS NULL OR expira='')"
));

/* --------------------------- BIN / bininfo ---------------------------- */
check('bininfo: país Title case', () => {
  const malos = todos("SELECT bin, pais FROM bininfo WHERE pais IS NOT NULL AND (pais <> '' AND (pais NOT GLOB '[A-Z]*' OR pais = upper(pais)))");
  if (malos.length) throw new Error(JSON.stringify(malos.slice(0, 5)));
  return '';
});
check('bininfo: país2 ISO-2', () => sinFilas(
  'pais2 inválido',
  "SELECT bin, pais2 FROM bininfo WHERE pais2 IS NOT NULL AND pais2 <> '' AND pais2 NOT GLOB '[A-Z][A-Z]'"
));
check('bininfo: marcas permitidas', () => sinFilas(
  'marca fuera del set',
  "SELECT bin, marca FROM bininfo WHERE marca IS NOT NULL AND marca NOT IN ('Visa','Master','Amex','Discover')"
));
check('bininfo: tipo/nivel normalizados', () => sinFilas(
  'tipo/nivel inválido',
  "SELECT bin FROM bininfo WHERE (tipo IS NOT NULL AND tipo NOT IN ('CREDIT','DEBIT')) OR (nivel IS NOT NULL AND nivel <> upper(nivel))"
));
check('bininfo: sin cache externo incompleto', () => sinFilas(
  'cache externo sin banco',
  "SELECT bin, fuente FROM bininfo WHERE fuente <> 'dataset' AND (banco IS NULL OR banco = '')"
));

/* ------------------------------ api tokens ---------------------------- */
const SCOPES = ['catalogo:read', 'catalogo:reserve', 'catalogo:pay', 'wallet:read', 'pedidos:read', 'pedidos:write', 'admin:read', 'admin:write'];
check('scopes de API keys válidos', () => {
  const filas = todos('SELECT id, scopes FROM api_tokens');
  for (const f of filas) {
    let arr;
    try { arr = JSON.parse(f.scopes || '[]'); } catch (_) { throw new Error('token ' + f.id + ': scopes no es JSON'); }
    if (!Array.isArray(arr)) throw new Error('token ' + f.id + ': scopes no es array');
    const malo = arr.find((s) => !SCOPES.includes(s));
    if (malo) throw new Error('token ' + f.id + ': scope ' + malo);
  }
  return filas.length + ' tokens';
});

check('revocados con fecha', () => sinFilas(
  'revocados sin fecha',
  'SELECT id FROM api_tokens WHERE COALESCE(revocado,0)=1 AND (revocado_en IS NULL OR revocado_en=\'\')'
));

/* ----------------------- catálogo vendible / cc ----------------------- */
/* Regla: lo que el catálogo ofrece debe excluir borradas (eliminado=1) y
 * exigir precio>0. Si esto falla, borrar/restaurar o el precio quedaron
 * inconsistentes y el usuario vería stock imposible de vender. */
check('catálogo: ninguna cc borrada (eliminado=1) vendible', () => {
  const f = uno(
    "SELECT COUNT(*) n FROM cc c LEFT JOIN bininfo b ON b.bin = c.bin LEFT JOIN precios pr ON pr.bin = c.bin " +
    "WHERE c.estado = 'DISPONIBLE' AND COALESCE(c.eliminado,0) = 1 " +
    "AND COALESCE(c.precio_num, pr.precio, 0) > 0"
  );
  if (f.n) throw new Error(f.n + ' cc borradas entrarían al catálogo');
  return '';
});

/* DISPONIBLE sin precio NO es vendible (no sale en catálogo/bot). Es estado
 * válido: se reporta el conteo. Falla solo si el catálogo y la regla difieren,
 * o si hay una sin precio que igual figura como vendible. */
check('catálogo: coherente — lo vendible excluye borradas y sin precio', () => {
  const vendibles = uno(
    "SELECT COUNT(*) n FROM cc c LEFT JOIN bininfo b ON b.bin = c.bin LEFT JOIN precios pr ON pr.bin = c.bin " +
    "WHERE c.estado = 'DISPONIBLE' AND COALESCE(c.eliminado,0) = 0 AND COALESCE(c.precio_num, pr.precio, 0) > 0"
  ).n;
  const disp = uno("SELECT COUNT(*) n FROM cc WHERE estado='DISPONIBLE' AND COALESCE(eliminado,0)=0").n;
  const sinPrecio = uno(
    "SELECT COUNT(*) n FROM cc c LEFT JOIN precios pr ON pr.bin = c.bin " +
    "WHERE c.estado='DISPONIBLE' AND COALESCE(c.eliminado,0)=0 AND COALESCE(c.precio_num, pr.precio, 0) <= 0"
  ).n;
  if (vendibles + sinPrecio !== disp) {
    throw new Error('incoherente: vendibles ' + vendibles + ' + sin precio ' + sinPrecio + ' <> disponibles ' + disp);
  }
  return 'vendibles ' + vendibles + ', sin precio ' + sinPrecio + ' (no vendibles)';
});

db.close();
console.log('');
console.log(ok + ' OK / ' + fail + ' FAIL');
if (fail) {
  console.log('');
  for (const f of fallos) console.log('  - ' + f.nombre + ' :: ' + f.motivo);
  process.exit(1);
}
process.exit(0);
