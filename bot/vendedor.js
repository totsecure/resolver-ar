/* vendedor.js (bot) — transporte Telegram de la logica de lib/vendedor-bot.js.
 * No contiene reglas de negocio: solo formatea y manda.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as vb from '../lib/vendedor-bot.js';
import * as notificaciones from '../lib/notificaciones.js';
import * as vinculacion from '../lib/vinculacion.js';
import { pedidoTexto } from '../lib/pedido.js';

const RUTA_LOG = path.join(import.meta.dirname, '..', 'datos', 'bot.log');
function log(msg) {
  try { fs.appendFileSync(RUTA_LOG, new Date().toISOString() + ' vendedor ' + msg + '\n'); } catch (_) {}
}

const CMD = new Set(['stock', 'bin', 'pedir', 'mis', 'saldo', 'pagar', 'datos', 'ok', 'falla', 'chk', 'recargar', 'recuperar', 'ayuda', 'start', 'help', 'comandos', 'desvincular']);

export function esVendedorChat(chatId) {
  try { return vb.esVendedor(chatId); } catch (_) { return false; }
}

export function ayudaVendedor() {
  return vb.ayuda();
}

/** Vinculacion temprana: se atiende aunque el chat todavia no este permitido. */
export async function manejarVinculacion(chatId, codigo, ctx) {
  const r = vb.vincular(chatId, codigo);
  log('vincular chat=' + chatId + ' ok=' + r.ok);
  await ctx.enviar(chatId, ctx.escapeHtml(r.texto));
  return true;
}

/**
 * Devuelve true si consumo el comando (vendedor vinculado o /vincular).
 * Devuelve false para que el bot siga con los comandos de administracion.
 */
export async function manejarVendedor(chatId, cmd, args, payload, ctx) {
  const c = String(cmd || '').toLowerCase();
  if (c === 'vincular') {
    const codigo = args.join(' ').trim();
    if (!codigo) {
      await ctx.enviar(chatId, 'Uso: <code>/vincular XXXXX-XXXXX</code> (el código se genera en la web, en Mi cuenta).');
      return true;
    }
    return manejarVinculacion(chatId, codigo, ctx);
  }

  if (c === 'recuperar') {
    const r = vb.recuperar(chatId);
    await ctx.enviar(chatId, ctx.escapeHtml(r.texto));
    return true;
  }

  if (c === 'desvincular') {
    const r = vb.desvincular(chatId);
    await ctx.enviar(chatId, ctx.escapeHtml(r.texto));
    return true;
  }

  /* /pedir <bin|saldeadas|base> es un listado (sin precio), igual en web y bot.
   * /pedir <bin> <n> conserva la reserva directa del flujo anterior. */
  if (c === 'pedir' && !(args[1] && /^\d+$/.test(args[1]))) {
    const filtro = args[0] || 'base';
    const r = pedidoTexto({ filtro });
    for (const pagina of r.paginas) {
      await ctx.enviar(chatId, '<pre>' + ctx.escapeHtml(pagina) + '</pre>');
    }
    if (r.n === 0 && /^\d{6,8}$/.test(filtro)) vb.suscribirStock(chatId, filtro);
    return true;
  }

  const u = vinculacion.vinculadoA(chatId);
  if (!u || u.rol !== 'vendedor') return false;

  if (!CMD.has(c)) {
    /* Un vendedor nunca debe llegar a los comandos de admin. */
    await ctx.enviar(chatId, 'Comando no disponible para vendedores.\n\n' + ctx.escapeHtml(vb.ayuda()));
    return true;
  }

  let r;
  const pagina = Math.max(1, Number(args[args.length - 1]) || 1);
  try {
    if (c === 'ayuda' || c === 'start' || c === 'help' || c === 'comandos') r = { ok: true, texto: vb.ayuda(), mono: false };
    else if (c === 'stock') r = vb.stock(chatId, pagina);
    else if (c === 'bin') r = vb.bin(chatId, args[0], pagina);
    else if (c === 'pedir') r = vb.pedir(chatId, args[0], args[1]);
    else if (c === 'mis') r = vb.mis(chatId, pagina);
    else if (c === 'saldo') r = vb.saldo(chatId, pagina);
    else if (c === 'pagar') r = vb.pagar(chatId, args[0]);
    else if (c === 'datos') r = vb.datos(chatId, args[0]);
    else if (c === 'ok') r = vb.marcarOk(chatId, args[0]);
    else if (c === 'falla') r = vb.marcarFalla(chatId, args[0], args.slice(1).join(' '));
    else if (c === 'chk') r = await vb.chk(chatId, args[0]);
    else if (c === 'recargar') r = vb.recargar(chatId, args[0], args.slice(1).join(' '));
    else if (c === 'recuperar') r = vb.recuperar(chatId);
    else if (c === 'desvincular') r = vb.desvincular(chatId);
    else r = { ok: false, texto: 'Comando no implementado.' };
  } catch (e) {
    log('ERROR chat=' + chatId + ' cmd=' + c + ': ' + (e?.message || e));
    r = { ok: false, texto: 'Error: ' + (e?.message || e) };
  }
  log('chat=' + chatId + ' cmd=' + c + ' ok=' + r.ok);
  const extra = r.markup ? { reply_markup: r.markup } : {};
  if (r.mono === false) await ctx.enviar(chatId, ctx.escapeHtml(r.texto), extra);
  else await ctx.enviar(chatId, '<pre>' + ctx.escapeHtml(r.texto) + '</pre>', extra);
  return true;
}

/* ------------------------- avisos y canal de auditoria -------------------- */
let corriendo = false;
let arrancado = false;
export function iniciarNotificaciones(ctx, ms = 5000) {
  if (arrancado) return;
  arrancado = true;
  setInterval(async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      const lista = notificaciones.pendientes(20);
      for (const n of lista) {
        if (n.canal === 'audit') {
          const destino = process.env.TELEGRAM_AUDIT
            || (process.env.TELEGRAM_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
          if (!destino) { notificaciones.marcar(n.id, 'sin TELEGRAM_AUDIT'); continue; }
          try {
            await ctx.enviar(destino, ctx.escapeHtml(vb.notifTexto(n)));
            notificaciones.marcar(n.id);
          } catch (e) {
            notificaciones.marcar(n.id, String(e?.message || e).slice(0, 200));
          }
          continue;
        }
        const destino = n.telegram_id;
        if (!destino) { notificaciones.marcar(n.id, 'sin telegram_id'); continue; }
        try {
          await ctx.enviar(destino, ctx.escapeHtml(vb.notifTexto(n)));
          notificaciones.marcar(n.id);
        } catch (e) {
          notificaciones.marcar(n.id, String(e?.message || e).slice(0, 200));
        }
      }
    } catch (e) {
      log('ERROR notificaciones: ' + (e?.message || e));
    } finally {
      corriendo = false;
    }
  }, Math.max(2000, Number(ms) || 5000));
  log('notificaciones activas cada ' + ms + 'ms');
}
