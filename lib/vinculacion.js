/* vinculacion.js — una cuenta, dos interfaces.
 *
 * La web genera un codigo de un solo uso; el usuario lo manda al bot con
 * /vincular <codigo>. A partir de ahi el chat de Telegram resuelve al mismo
 * usuario_id que la web y ejecuta las mismas funciones de lib/.
 */
import crypto from 'node:crypto';
import { base } from './stock.js';
import { audit, base32Codificar, publico, migrar as authMigrar } from './auth.js';

let listo = false;
export function migrar() {
  if (listo) return base();
  const d = base();
  /* La tabla `usuarios` la crea auth; sin ella `vinculadoA` no puede resolver. */
  try { authMigrar(); } catch (_) {}
  d.exec(
    'CREATE TABLE IF NOT EXISTS vinculaciones(' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, codigo_hash TEXT UNIQUE NOT NULL, ' +
    'usuario_id INTEGER NOT NULL, creado TEXT NOT NULL, expira TEXT NOT NULL, usado TEXT)'
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_vinculaciones_usuario ON vinculaciones(usuario_id)');
  /* Un chat de Telegram pertenece a un solo usuario. */
  try { d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_telegram ON usuarios(telegram_id) WHERE telegram_id IS NOT NULL'); } catch (_) {}
  listo = true;
  return d;
}

const ahora = () => new Date().toISOString();
const norm = (c) => String(c == null ? '' : c).toUpperCase().replace(/[^A-Z0-9]/g, '');
const hash = (c) => crypto.createHash('sha256').update(norm(c)).digest('hex');

export function generar(usuarioId, minutos = 10) {
  migrar();
  const codigo = base32Codificar(crypto.randomBytes(5)).slice(0, 8);
  const expira = new Date(Date.now() + Math.max(1, Number(minutos) || 10) * 60000).toISOString();
  base().prepare('INSERT INTO vinculaciones(codigo_hash, usuario_id, creado, expira) VALUES(?,?,?,?)')
    .run(hash(codigo), Number(usuarioId), ahora(), expira);
  audit(usuarioId, 'TELEGRAM_CODIGO', 'usuario', usuarioId, 'expira=' + expira, null);
  return {
    codigo: codigo.slice(0, 4) + '-' + codigo.slice(4), expira, minutos: Number(minutos) || 10,
    instruccion: 'Mandale al bot: /vincular ' + codigo.slice(0, 4) + '-' + codigo.slice(4),
  };
}

/** Consume el codigo y vincula el chat. Devuelve {ok, usuario} o error. */
export function consumir(codigo, chatId) {
  migrar();
  if (!norm(codigo) || !chatId) return { ok: false, error: 'codigo' };
  const d = base();
  const v = d.prepare('SELECT * FROM vinculaciones WHERE codigo_hash=? AND usado IS NULL').get(hash(codigo));
  if (!v) return { ok: false, error: 'codigo_invalido' };
  if (String(v.expira) < ahora()) return { ok: false, error: 'codigo_vencido' };
  const u = d.prepare('SELECT * FROM usuarios WHERE id=?').get(Number(v.usuario_id));
  if (!u) return { ok: false, error: 'usuario_inexistente' };
  if (u.estado !== 'activo') return { ok: false, error: 'usuario_inactivo' };
  d.exec('BEGIN IMMEDIATE');
  try {
    const up = d.prepare('UPDATE vinculaciones SET usado=? WHERE id=? AND usado IS NULL').run(ahora(), v.id);
    if (!up.changes) throw new Error('codigo_usado');
    d.prepare('UPDATE usuarios SET telegram_id=NULL WHERE telegram_id=? AND id<>?').run(String(chatId), u.id);
    d.prepare('UPDATE usuarios SET telegram_id=? WHERE id=?').run(String(chatId), u.id);
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    return { ok: false, error: String(e?.message || e) };
  }
  audit(u.id, 'TELEGRAM_VINCULAR', 'usuario', u.id, 'chat=' + chatId, null);
  return { ok: true, usuario: publico(d.prepare('SELECT * FROM usuarios WHERE id=?').get(u.id)) };
}

/** Usuario activo vinculado a este chat, o null. */
export function vinculadoA(chatId) {
  migrar();
  if (!chatId) return null;
  const u = base().prepare("SELECT * FROM usuarios WHERE telegram_id=? AND estado='activo'").get(String(chatId));
  return u || null;
}

export function desvincular(usuarioId) {
  migrar();
  base().prepare('UPDATE usuarios SET telegram_id=NULL WHERE id=?').run(Number(usuarioId));
  audit(usuarioId, 'TELEGRAM_DESVINCULAR', 'usuario', usuarioId, null, null);
  return true;
}

export function estado(usuarioId) {
  migrar();
  const u = base().prepare('SELECT telegram_id FROM usuarios WHERE id=?').get(Number(usuarioId));
  return { vinculado: Boolean(u && u.telegram_id), telegram_id: u ? (u.telegram_id || null) : null };
}
