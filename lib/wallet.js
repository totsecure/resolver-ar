/* wallet.js — saldo del vendedor con ledger inmutable.
 *
 * Reglas:
 *   - mov_saldo nunca se edita ni se borra: cada movimiento deja saldo_post.
 *   - el saldo se deriva de los movimientos, pero se materializa en `saldos`
 *     dentro de la misma transaccion para leerlo rapido.
 *   - montos enteros (la moneda del proyecto no usa centavos).
 */
import { base } from './stock.js';
import { audit } from './auth.js';
import * as ledger from './ledger.js';

let listo = false;
export function migrar() {
  if (listo) return base();
  const d = base();
  d.exec(
    'CREATE TABLE IF NOT EXISTS saldos(' +
    'usuario_id INTEGER PRIMARY KEY, saldo INTEGER NOT NULL DEFAULT 0, actualizado TEXT)'
  );
  d.exec(
    'CREATE TABLE IF NOT EXISTS mov_saldo(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL, tipo TEXT NOT NULL, ' +
    'monto INTEGER NOT NULL, saldo_post INTEGER NOT NULL, ref TEXT, nota TEXT, creado TEXT NOT NULL)'
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_mov_saldo_usuario ON mov_saldo(usuario_id, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_mov_saldo_ref ON mov_saldo(ref)');
  ledger.migrar();
  listo = true;
  return d;
}

export const ahora = () => new Date().toISOString();

export function saldoDe(usuarioId) {
  migrar();
  const f = base().prepare('SELECT saldo FROM saldos WHERE usuario_id = ?').get(Number(usuarioId));
  return f ? Number(f.saldo) : 0;
}

export function movimientos(usuarioId, limite = 100) {
  migrar();
  return base().prepare(
    'SELECT id, tipo, monto, saldo_post, ref, nota, creado FROM mov_saldo WHERE usuario_id = ? ORDER BY id DESC LIMIT ?'
  ).all(Number(usuarioId), Math.max(1, Math.min(1000, Number(limite) || 100)));
}

function validarMonto(monto) {
  const n = Number(monto);
  if (!Number.isInteger(n) || n === 0) throw new Error('monto invalido');
  return n;
}

/**
 * Aplica un movimiento dentro de una transaccion ya abierta por el llamador.
 * monto > 0 acredita, monto < 0 debita. Nunca deja saldo negativo.
 */
export function aplicarTx(d, usuarioId, monto, tipo, ref, nota, opts = {}) {
  migrar();
  const m = validarMonto(monto);
  const id = Number(usuarioId);
  const actual = d.prepare('SELECT saldo FROM saldos WHERE usuario_id = ?').get(id);
  const saldo = actual ? Number(actual.saldo) : 0;
  const nuevo = saldo + m;
  if (nuevo < 0 && !opts.permitirNegativo) throw new Error('saldo_insuficiente');
  const creado = ahora();
  const asientoId = ledger.movimientoWallet(d, { usuarioId: id, monto: m, tipo, ref, nota });
  const info = d.prepare(
    'INSERT INTO mov_saldo(usuario_id, tipo, monto, saldo_post, ref, nota, creado, asiento_id) VALUES(?,?,?,?,?,?,?,?)'
  ).run(id, String(tipo), m, nuevo, ref == null ? null : String(ref), nota == null ? null : String(nota), creado, asientoId);
  d.prepare(
    'INSERT INTO saldos(usuario_id, saldo, actualizado) VALUES(?,?,?) ' +
    'ON CONFLICT(usuario_id) DO UPDATE SET saldo=excluded.saldo, actualizado=excluded.actualizado'
  ).run(id, nuevo, creado);
  return { ok: true, saldo: nuevo, mov_id: Number(info.lastInsertRowid), monto: m };
}

function transaccion(fn) {
  const d = migrar();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

export function acreditar(usuarioId, monto, tipo = 'ajuste', ref = null, nota = null, ip = null) {
  const r = transaccion((d) => aplicarTx(d, usuarioId, Number(monto), tipo, ref, nota));
  audit(Number(usuarioId), 'SALDO_ACREDITAR', 'usuario', usuarioId, tipo + ' ' + monto + ' saldo=' + r.saldo, ip);
  return r;
}

export function debitar(usuarioId, monto, tipo = 'debito', ref = null, nota = null, ip = null) {
  try {
    const r = transaccion((d) => aplicarTx(d, usuarioId, -Math.abs(Number(monto)), tipo, ref, nota));
    audit(Number(usuarioId), 'SALDO_DEBITAR', 'usuario', usuarioId, tipo + ' ' + monto + ' saldo=' + r.saldo, ip);
    return r;
  } catch (e) {
    if (String(e?.message) === 'saldo_insuficiente') return { ok: false, error: 'saldo_insuficiente', saldo: saldoDe(usuarioId) };
    throw e;
  }
}

/** Ajuste manual de administracion: monto positivo o negativo, con nota obligatoria. */
export function ajustar(usuarioId, monto, nota, adminId, ip = null) {
  if (!String(nota || '').trim()) throw new Error('nota obligatoria');
  const r = transaccion((d) => aplicarTx(d, usuarioId, Number(monto), 'ajuste_admin', 'admin:' + adminId, nota));
  audit(adminId, 'SALDO_AJUSTE', 'usuario', usuarioId, monto + ' · ' + nota + ' · saldo=' + r.saldo, ip);
  return r;
}
