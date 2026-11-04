/* vendedor-bot.js — la logica del bot de vendedores, en lib/.
 *
 * bot/vendedor.js es solo transporte de Telegram: llama a estas funciones.
 * La web llama a los mismos modulos, por eso una accion del bot se ve en la
 * web (y viceversa) sin duplicar reglas.
 */
import { base } from './stock.js';
import * as catalogo from './catalogo.js';
import * as wallet from './wallet.js';
import * as vinculacion from './vinculacion.js';
import * as notificaciones from './notificaciones.js';
import * as reclamos from './reclamos.js';
import * as recargas from './recargas.js';
import * as checker from './checker.js';
import * as pedidos from './pedidos.js';
import * as auth from './auth.js';
import { audit } from './auth.js';
import * as precios from './precios.js';

export function usuarioDeChat(chatId) {
  return vinculacion.vinculadoA(chatId);
}

export function esVendedor(chatId) {
  const u = usuarioDeChat(chatId);
  return Boolean(u && u.rol === 'vendedor');
}

export function restante(iso) {
  if (!iso) return '-';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'vencida';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

export function ayuda() {
  return [
    'Soy tu cuenta de vendedor. Los comandos:',
    '',
    '/stock [pagina] - stock disponible por BIN y precio',
    '/precio - tu arreglo: el precio que se te descuenta al reservar',
    '/bin <bin> [pagina] - listado de un BIN',
    '/pedir <bin|saldeadas|base> - listado sin precio (igual que la web)',
    '/pedir <bin> <n> - reserva n tarjetas (default 1)',
    '/pedir <ultimos4> - entrega y vende la tarjeta que termina en esos 4 dígitos',
    '/vender [bin|ultimos4] - venta directa: la entrega y la marca vendida',
    '/saldeadas [todo] - lista de saldeadas (numerada, con los últimos 4 a la vista)',
    '/dead <numero> - el cliente se quejó: la manda a revisión',
    '/ventas [n] - historial de ventas con totales',
    '/anular <numero> - anula una venta (igual que /devolver)',
    '/cancel - cancela la operación pendiente',
    '/help - igual que /ayuda',
    '/mis [pagina] - reservas activas, pagadas y cerradas',
    '/pagar <grupo|codigo> - confirma el pago de una reserva',
    '/datos <codigo> - numero completo y titular de tu tarjeta',
    '/ok <codigo> - verificación OK',
    '/falla <codigo> [motivo] - registrar una falla/reclamo',
    '/chk <codigo> - verificar una tarjeta',
    '/saldo [pagina] - saldo y últimos movimientos',
    '/recargar [monto] [texto] - pedir recarga o ver tus pedidos',
    '/recuperar - recuperar la contraseña por este chat vinculado',
    '/vincular <codigo> - vincular este chat (código generado en la web)',
    '/desvincular - desvincular este chat',
    '/ayuda - esta lista',
  ].join('\n');
}

export function vincular(chatId, codigo) {
  const r = vinculacion.consumir(codigo, chatId);
  if (!r.ok) {
    const m = {
      codigo_invalido: 'El código no existe o ya fue usado.',
      codigo_vencido: 'El código venció. Generá uno nuevo en la web.',
      usuario_inactivo: 'La cuenta no está activa. Falta la aprobación del administrador.',
    };
    return { ok: false, texto: m[r.error] || 'No pudimos vincular la cuenta.' };
  }
  return {
    ok: true,
    texto: 'Listo, ' + (r.usuario.nombre || r.usuario.usuario) + '. Este chat ya es tu cuenta (' + r.usuario.rol + ').\n\n' + ayuda(),
  };
}

export function recuperar(chatId) {
  const u = usuarioDeChat(chatId);
  if (!u) return { ok: false, texto: 'Vinculá tu cuenta con /vincular antes de recuperar la contraseña.' };
  const r = auth.resetearClaveTemporal(u.id);
  if (!r.ok) return { ok: false, texto: 'No se pudo recuperar: ' + r.error };
  return { ok: true, texto: 'Contraseña temporal para ' + r.usuario + ': ' + r.clave + '\nCambiala al entrar desde /mi.' };
}

export function desvincular(chatId) {
  const u = usuarioDeChat(chatId);
  if (!u) return { ok: false, texto: 'Este chat no está vinculado.' };
  vinculacion.desvincular(u.id);
  return { ok: true, texto: 'Chat desvinculado. Ya no vas a recibir avisos acá.' };
}

/* ------------------------------- comandos -------------------------------- */
function paginar(texto, pagina, por, cmd) {
  const lineas = String(texto || '').split('\n');
  const total = Math.max(1, Math.ceil(lineas.length / por));
  const p = Math.max(1, Math.min(total, Number(pagina) || 1));
  const desde = (p - 1) * por;
  const cuerpo = lineas.slice(desde, desde + por).join('\n');
  const botones = [];
  if (p > 1) botones.push({ text: '◀ Anterior', callback_data: 'vp|' + cmd + '|' + (p - 1) });
  if (p < total) botones.push({ text: 'Siguiente ▶', callback_data: 'vp|' + cmd + '|' + (p + 1) });
  return {
    texto: cuerpo + '\n\n' + (total > 1 ? 'Página ' + p + '/' + total : ''),
    markup: botones.length ? { inline_keyboard: [botones] } : undefined,
  };
}

/* Sin precio cargado (cada vendedor arregla el suyo) igual se muestra el stock. */
function monto(a, b) {
  if (!(Number(a) > 0)) return 's/precio';
  return '$' + a + (Number(b) !== Number(a) ? '-' + b : '');
}

/* uid = null => precios de tienda (modo publico, sin vendedor vinculado). */
function stockDe(uid, pagina = 1) {
  const filas = catalogo.resumen(uid, { sinPrecio: true });
  if (!filas.length) return { ok: true, texto: 'No hay stock disponible.' };
  const lineas = filas.map((f) =>
    f.bin + ' · ' + f.n + ' disp · ' + monto(f.precio_min, f.precio_max) +
    (f.banco ? ' · ' + f.banco : ''));
  const pg = paginar('STOCK DISPONIBLE (' + filas.length + ' BIN)\n' + lineas.join('\n'), pagina, 15, 'stock');
  return { ok: true, texto: pg.texto, markup: pg.markup };
}

export function stock(chatId, pagina = 1) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  return stockDe(u.id, pagina);
}

/** Sin vincular: stock a precio de tienda. */
export function stockPublico(pagina = 1) {
  return stockDe(null, pagina);
}

/* uid = null => precios de tienda (modo publico, sin vendedor vinculado). */
function binDe(uid, valor, pagina = 1) {
  const b = String(valor || '').replace(/\D/g, '').slice(0, 6);
  if (b.length < 6) return { ok: false, texto: 'Uso: /bin <bin> [pagina].' };
  const r = catalogo.consultar({ bins: b, por: 20, pagina, sinPrecio: true }, uid);
  if (!r.items.length) return { ok: true, texto: 'BIN ' + b + ': sin disponibles.' };
  const lineas = r.items.map((x) => '#' + (x.ref || x.id) + ' · ' + x.numero_mask + ' · ' + monto(x.precio) + ' · ' + (x.banco || ''));
  const pg = paginar('BIN ' + b + ' (' + r.total + ')\n' + lineas.join('\n'), pagina, 20, 'bin|' + b);
  return { ok: true, texto: pg.texto, markup: pg.markup };
}

export function bin(chatId, valor, pagina = 1) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  return binDe(u.id, valor, pagina);
}

/** Sin vincular: detalle de un BIN a precio de tienda. */
export function binPublico(valor, pagina = 1) {
  return binDe(null, valor, pagina);
}

export function suscribirStock(chatId, bin) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return false;
  return notificaciones.suscribirStock(u.id, bin);
}

export function pedir(chatId, bin, cantidad) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  const b = String(bin || '').replace(/\D/g, '').slice(0, 6);
  if (b.length < 6) return { ok: false, texto: 'Uso: /pedir <bin> [cantidad]. Ejemplo: /pedir 516585 3' };
  const n = Math.max(1, Math.min(20, Number(cantidad) || 1));
  const r = catalogo.reservar(u.id, { bin: b, cantidad: n });
  if (!r.ok) {
    if (r.error === 'sin_stock') { try { notificaciones.suscribirStock(u.id, b); } catch (_) {} }
    const m = {
      sin_stock: 'No hay suficientes tarjetas de ' + b + ' disponibles. Te aviso cuando entre stock.',
      sin_precio: 'Ese BIN no tiene precio asignado. Miralo con /precio o pedile al admin que te lo cargue.',
      saldo_insuficiente: 'Saldo insuficiente. Cargá saldo desde la web.',
      limite_simultaneas: r.detalle || 'Llegaste al límite de reservas simultáneas.',
      limite_diario: r.detalle || 'Llegaste al límite diario de reservas.',
    };
    return { ok: false, texto: m[r.error] || ('No se pudo reservar: ' + r.error) };
  }
  const lineas = [];
  for (const d of r.items) {
    lineas.push(
      '#' + (d.codigo || d.ref) + ' · ' + d.bin + ' · $' + d.precio + '\n' +
      d.numero + '|' + d.mes + '|' + d.anio + '|' + d.cvv + '\n' +
      (d.titular || 'Sin titular') + (d.dni ? ' · DNI ' + d.dni : '') +
      (d.direccion ? '\n' + d.direccion + ' · ' + (d.ciudad || '') + ' ' + (d.provincia || '') : '')
    );
  }
  return {
    ok: true, grupo: r.grupo,
    texto: 'RESERVA ' + r.grupo + ' · ' + r.cantidad + ' CC · $' + r.total + '\n' +
      'Vence en ' + restante(r.expira) + ' (' + String(r.expira).slice(11, 16) + ' UTC)\n\n' +
      lineas.join('\n\n') +
      '\n\nPagá con /pagar ' + r.grupo + ' antes del vencimiento.\nSaldo: $' + r.saldo,
  };
}

export function mis(chatId, pagina = 1) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  const filas = catalogo.misReservas(u.id, 100).filter((r) => ['activa', 'pagada', 'ok', 'falla'].includes(r.estado));
  if (!filas.length) return { ok: true, texto: 'MIS RESERVAS (0)\nNo tenés reservas.' };
  const lineas = filas.map((r) => {
    const reloj = (r.estado === 'activa' || r.estado === 'pagada') ? ' · ' + restante(r.expira) : '';
    return (r.estado === 'activa' ? '🟡' : r.estado === 'pagada' ? '🔵' : r.estado === 'ok' ? '✅' : '🔴') +
      ' #' + (r.id) + ' · ' + r.numero_mask + ' · ' + r.estado + reloj + ' · $' + r.precio + ' · ' + r.grupo;
  });
  const pg = paginar('MIS RESERVAS (' + filas.length + ')\n' + lineas.join('\n') + '\n\nVer datos: /datos <codigo> · OK: /ok <codigo> · Falla: /falla <codigo> motivo', pagina, 12, 'mis');
  return { ok: true, texto: pg.texto, markup: pg.markup };
}

export function saldo(chatId, pagina = 1) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  const s = wallet.saldoDe(u.id);
  const movs = wallet.movimientos(u.id, 100);
  const lineas = movs.map((m) => (m.monto >= 0 ? '+' : '') + m.monto + ' · ' + m.tipo + ' · ' + String(m.creado).slice(0, 16).replace('T', ' '));
  const arreglo = precios.preciosVendedor(u.id);
  const como = arreglo.length ? ' · tu precio: ' + (arreglo.find((f) => !f.bin) ? '$' + arreglo.find((f) => !f.bin).precio + ' (comodín)' : 'ver /precio') : '';
  const pg = paginar('SALDO: $' + s + como + '\n\n' + (lineas.join('\n') || 'Sin movimientos.'), pagina, 15, 'saldo');
  return { ok: true, texto: pg.texto, markup: pg.markup };
}

/** Tu arreglo de precio. Con argumentos lo maneja el bot de admin (precio base). */
export function precio(chatId) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  return { ok: true, texto: precios.resumenVendedor(u.id) };
}

export function recargar(chatId, monto, texto) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  if (monto != null && String(monto).trim()) {
    try {
      const r = recargas.crear(u.id, { monto, comprobante: texto || 'pedido desde Telegram' });
      return { ok: true, texto: 'Recarga #' + r.id + ' por $' + r.monto + ' enviada. El administrador la revisa.' };
    } catch (e) {
      return { ok: false, texto: 'No se pudo pedir la recarga: ' + (e?.message || e) };
    }
  }
  const filas = recargas.listar({ usuarioId: u.id, limite: 50 });
  if (!filas.length) return { ok: true, texto: 'No tenés recargas. Uso: /recargar <monto> [texto].' };
  const lineas = filas.map((r) => '#' + r.id + ' · $' + r.monto + ' · ' + r.estado + ' · ' + String(r.creado).slice(0, 16).replace('T', ' '));
  return { ok: true, texto: 'RECARGAS (' + filas.length + ')\n' + lineas.join('\n') };
}

export async function chk(chatId, clave) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  const r = reservaDe(u.id, clave);
  if (!r) return { ok: false, texto: 'No encontré esa tarjeta en tus reservas.' };
  const res = await checker.verificar(r.cc_id, { proveedor: process.env.CHECKER_PROVEEDOR || 'manual' });
  return { ok: true, texto: 'CHECKER ' + (r.codigo || r.id) + ' · ' + res.estado + '\n' + (res.motivo || 'sin detalle') + '\nProveedor: ' + res.proveedor };
}

function reservaDe(usuarioId, clave) {
  const s = String(clave || '').trim();
  if (!s) return null;
  return base().prepare(
    'SELECT r.*, c.codigo, c.numero, c.mes, c.anio, c.cvv, c.estado cc_estado FROM reservas r ' +
    'JOIN cc c ON c.id=r.cc_id WHERE r.usuario_id=? AND (c.codigo=? OR CAST(r.id AS TEXT)=? OR r.grupo=?) ' +
    'ORDER BY r.id DESC LIMIT 1'
  ).get(Number(usuarioId), s.toUpperCase(), s, s) || null;
}

export function pagar(chatId, clave) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  const r = reservaDe(u.id, clave);
  if (!r) return { ok: false, texto: 'No encontré esa reserva.' };
  if (r.estado !== 'activa') return { ok: false, texto: 'La reserva está ' + r.estado + ' y no se puede pagar.' };
  const esGrupo = String(clave || '').trim() === String(r.grupo);
  const p = catalogo.pagar(u.id, esGrupo ? { grupo: r.grupo } : { id: r.id });
  if (!p.ok) return { ok: false, texto: 'No se pudo pagar: ' + p.error };
  return {
    ok: true,
    texto: 'PAGO CONFIRMADO · ' + p.grupo + ' · ' + p.cantidad + ' CC · $' + p.total +
      '\nAuto-OK en ' + restante(p.expira) + '. Después podés marcar /ok o /falla por código.',
  };
}

export function datos(chatId, clave) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  const r = reservaDe(u.id, clave);
  if (!r) return { ok: false, texto: 'No encontré esa tarjeta en tus reservas.' };
  const d = catalogo.datosReserva(u.id, r.id);
  if (!d.ok) return { ok: false, texto: 'La reserva está ' + (d.estado || d.error) + '.' };
  const i = d.item;
  return {
    ok: true,
    texto: '#' + (i.codigo || i.ref) + ' · ' + i.bin + ' · $' + i.precio + '\n' +
      i.numero + '|' + i.mes + '|' + i.anio + '|' + i.cvv + '\n' +
      (i.titular || 'Sin titular') + (i.dni ? ' · DNI ' + i.dni : '') +
      (i.direccion ? '\n' + i.direccion : '') +
      (i.ciudad ? '\n' + i.ciudad + ' · ' + (i.provincia || '') : '') +
      (i.mail ? '\n' + i.mail : '') + (i.telefono ? ' · ' + i.telefono : '') +
      '\nEstado: ' + i.estado + ' · verif: ' + i.verif_estado,
  };
}

export function marcarOk(chatId, clave) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  const r = reservaDe(u.id, clave);
  if (!r) return { ok: false, texto: 'No encontré esa tarjeta. Usá el código que te dio /mis o /datos.' };
  if (r.estado === 'activa') return { ok: false, texto: 'Primero pagá la reserva con /pagar ' + r.grupo + '.' };
  if (r.estado === 'falla' || r.estado === 'vencida') return { ok: false, texto: 'La reserva está ' + r.estado + '.' };

  const d = base();
  d.exec('BEGIN IMMEDIATE');
  try {
    if (r.estado === 'pagada') {
      const up = d.prepare("UPDATE reservas SET estado='ok' WHERE id=? AND estado='pagada'").run(r.id);
      if (!up.changes) throw new Error('ya_cambiada');
      catalogo.transicion(d, r.cc_id, 'PAGADA', 'VENDIDA', {
        usuarioId: u.id, detalle: 'ok manual',
        sets: {
          vendido_a: String(u.id), vendido_el: new Date().toISOString(), codigo_venta: r.grupo,
          verif_estado: 'ok',
        },
      });
    } else {
      d.prepare("UPDATE cc SET verif_estado='ok' WHERE id=?").run(r.cc_id);
      d.prepare('INSERT INTO movs(cc_id, accion, usuario, fecha, detalle) VALUES(?,?,?,?,?)')
        .run(r.cc_id, 'VERIF_OK', String(u.id), new Date().toISOString(), 'manual bot');
    }
    pedidos.estadoDeGrupo(d, r.grupo, 'verificado', 'verificación manual OK', { rol: 'sistema' });
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    return { ok: false, texto: 'No se pudo marcar OK: ' + (e?.message || e) };
  }
  audit(u.id, 'VERIF_OK', 'cc', r.cc_id, 'reserva=' + r.id, null);
  notificaciones.auditar('VERIFICACION OK · vendedor #' + u.id + ' · cc #' + r.cc_id + ' · ' + (r.codigo || r.id));
  return { ok: true, texto: 'Listo: ' + (r.codigo || r.id) + ' quedó OK. Ya se ve en la web.' };
}

export function marcarFalla(chatId, clave, motivo) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  const r = reservaDe(u.id, clave);
  if (!r) return { ok: false, texto: 'No encontré esa tarjeta.' };
  if (r.estado === 'activa') return { ok: false, texto: 'Primero pagá la reserva con /pagar ' + r.grupo + '.' };
  if (r.estado === 'falla') return { ok: false, texto: 'Ya estaba marcada como falla.' };
  if (!['pagada', 'ok'].includes(r.estado)) return { ok: false, texto: 'La reserva está ' + r.estado + '.' };
  const m = String(motivo || '').trim() || 'sin motivo';
  const d = base();
  d.exec('BEGIN IMMEDIATE');
  try {
    d.prepare("UPDATE reservas SET estado='falla' WHERE id=? AND estado IN ('pagada','ok')").run(r.id);
    catalogo.transicion(d, r.cc_id, r.estado === 'pagada' ? 'PAGADA' : 'VENDIDA', 'RECLAMADA', {
      usuarioId: u.id, detalle: 'falla bot: ' + m, sets: { verif_estado: 'falla' },
    });
    pedidos.estadoDeGrupo(d, r.grupo, 'reclamo', 'falla bot: ' + m, { rol: 'sistema' });
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    return { ok: false, texto: 'No se pudo registrar la falla: ' + (e?.message || e) };
  }
  const rec = reclamos.crear({ usuarioId: u.id, reservaId: r.id, ccId: r.cc_id, motivo: m });
  notificaciones.auditar('RECLAMO · vendedor #' + u.id + ' · cc #' + r.cc_id + ' · ' + m);
  notificaciones.crear(u.id, 'reclamo_creado', { reclamo_id: rec.id, cc_id: r.cc_id, motivo: m });

  /* Reemplazo automatico si hay stock del mismo BIN (default ON). */
  let reemplazo = null;
  if (String(process.env.RECLAMO_AUTO_REEMPLAZO || '1') === '1') {
    const rr = reclamos.resolverAccion({
      reclamoId: rec.id, adminId: null, accion: 'reemplazo', nota: 'reemplazo automático',
    });
    if (rr.ok) reemplazo = rr;
  }
  if (reemplazo) {
    return {
      ok: true,
      texto: 'Falla registrada (reclamo #' + rec.id + ') y reemplazada automáticamente por ' +
        (reemplazo.reemplazo.codigo || ('#' + reemplazo.reemplazo.id)) + ' del mismo BIN. Revisá /datos.',
    };
  }
  return { ok: true, texto: 'Falla registrada (reclamo #' + rec.id + '). No hay stock del mismo BIN para reemplazo automático; el administrador lo va a revisar.' };
}

/** /revisar <clave> — el vendedor manda su tarjeta a REVISION sin reclamo. */
export function revisar(chatId, clave) {
  const u = usuarioDeChat(chatId);
  if (!u || u.rol !== 'vendedor') return { ok: false, texto: 'Vinculá una cuenta de vendedor con /vincular.' };
  const r = reservaDe(u.id, clave);
  if (!r) return { ok: false, texto: 'No encontré esa tarjeta. Usá el número/ref que te dio la venta.' };
  if (r.estado === 'activa') return { ok: false, texto: 'Primero pagá la reserva con /pagar ' + r.grupo + '.' };
  const d = base();
  d.exec('BEGIN IMMEDIATE');
  try {
    d.prepare("UPDATE reservas SET estado='falla' WHERE id=? AND estado IN ('pagada','ok')").run(r.id);
    catalogo.transicion(d, r.cc_id, r.estado === 'pagada' ? 'PAGADA' : 'VENDIDA', 'REVISION', {
      usuarioId: u.id, detalle: 'revisar bot', sets: { verif_estado: 'revisar' },
    });
    pedidos.estadoDeGrupo(d, r.grupo, 'reclamo', 'revisar bot', { rol: 'sistema' });
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    return { ok: false, texto: 'No se pudo enviar a revisión: ' + (e?.message || e) };
  }
  notificaciones.auditar('REVISAR · vendedor #' + u.id + ' · cc #' + r.cc_id);
  return { ok: true, texto: '🔎 ' + (r.codigo || ('#' + r.cc_id)) + ' enviada a REVISION. La revisa el administrador.' };}

/* --------------------------- texto de avisos ----------------------------- */
export function notifTexto(n) {
  let p = {};
  try { p = typeof n.payload === 'string' ? JSON.parse(n.payload) : (n.payload || {}); } catch (_) { p = {}; }
  switch (n.tipo) {
    case 'reserva_asignada':
      return '🟡 Reserva ' + p.grupo + ' · ' + p.cantidad + ' CC · $' + p.total + '\nVence en ' + restante(p.expira) + '. Pagá desde la web o con /pagar ' + p.grupo + '.';
    case 'reserva_por_vencer':
      return '⏳ La reserva ' + p.grupo + ' vence en ' + restante(p.expira) + '.\n' + (p.numero_mask || '') + ' · ' + (p.bin || '') + '\nSi no la pagás, vuelve al stock.';
    case 'pago_confirmado':
    case 'pedido_aprobado':
      return '🔵 Pedido aprobado ' + (p.grupo || '') + ' · ' + p.cantidad + ' CC · $' + p.total + '\nAuto-OK en ' + restante(p.expira) + '.';
    case 'venta_ok':
      return '✅ Venta OK · ' + p.grupo + (p.auto ? ' (auto-OK)' : '') + '.';
    case 'recarga_aprobada':
      return '💵 Recarga aprobada · $' + p.monto + (p.nota ? '\n' + p.nota : '') + '\nYa está en tu saldo.';
    case 'recarga_rechazada':
      return '❌ Recarga rechazada · $' + p.monto + (p.nota ? '\nMotivo: ' + p.nota : '');
    case 'reclamo_creado':
      return '📝 Reclamo #' + p.reclamo_id + ' registrado · cc #' + p.cc_id + (p.motivo ? '\n' + p.motivo : '');
    case 'reclamo_resuelto':
      return '📬 Reclamo #' + (p.reclamo_id || '') + ': ' + (p.resolucion || 'resuelto');
    case 'stock_bin':
      return '📦 Entró stock del BIN ' + p.bin + (p.cantidad ? ' (' + p.cantidad + ' disponibles)' : '') + '.\nPedí con /pedir ' + p.bin + '.';
    case 'auditoria':
      return '📣 ' + (p.texto || 'evento');
    default:
      return 'Aviso: ' + n.tipo;
  }
}
