/* telegram.js — bot de Telegram para resolver-ar.
 *
 * Long polling con getUpdates (timeout 50), offset persistido en
 * datos/bot-offset.json. Sin dependencias: fetch global de Node 24.
 *
 * SIN ESTADO: no hay "esperando lote" ni banderas en memoria. El tipo de
 * mensaje se detecta por su contenido:
 *   - 2+ lineas con un numero de 13-19 digitos, o una linea numero|MM|YY|CVV
 *     => lote (con o sin /lote previo)
 *   - 7 u 8 digitos => DNI
 *   - comando => comando
 *
 * El lote se delega al endpoint HTTP /lote del server local (cascara fina):
 * se pagina de a 100 bloques y se manda UN solo .txt.
 */

import fs from 'node:fs';
import dns from 'node:dns';
import { execFile, spawn } from 'node:child_process';

/* La Mac resuelve api.telegram.org por IPv6, que no tiene salida: forzar IPv4. */
dns.setDefaultResultOrder('ipv4first');
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { fichaDetalle } from '../lib/ficha.js';
import { asegurarPool, sembrarPool, elegirDelPool, randomAfip } from '../scripts/pool.js';
import {
  buscarPorPrefijo, ambiguedades, buscarPorCuit, basico,
  formatearCuit, cuitsPorDni,
} from '../lib/padron.js';
import { parsearTarjetas } from '../lib/parse-tarjetas.js';
import { manejarStock, resolverOperacion } from './stock.js';
import { manejarVendedor, manejarVinculacion, esVendedorChat, ayudaVendedor, iniciarNotificaciones } from './vendedor.js';
import { vinculadoA } from '../lib/vinculacion.js';
import { stockPublico, binPublico } from '../lib/vendedor-bot.js';
import * as vendedores from '../lib/vendedores.js';

/* Preferir IPv4: en esta red el AAAA de Telegram a veces cuelga. */
dns.setDefaultResultOrder('ipv4first');

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_ENV = path.join(RAIZ, 'datos', 'bot.env');
const RUTA_ENV_SERVER = path.join(RAIZ, 'datos', 'server.env');
const RUTA_OFFSET = path.join(RAIZ, 'datos', 'bot-offset.json');
const RUTA_LOG = path.join(RAIZ, 'datos', 'bot.log');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');

const HELP = [
  '<b>resolver-ar</b>',
  'Pegá las líneas de tarjetas tal cual (<code>numero|MM|YY|CVV</code>), una por',
  'línea o en un .txt. No hace falta /lote: te devuelvo un solo .txt.',
  'También podés mandar un DNI de 7 u 8 dígitos.',
  '',
  '/limpiar &lt;texto&gt; - pegar cualquier formato y devolver las líneas canónicas',
  '/nombre &lt;texto&gt; - buscar por apellido o nombre',
  '/cuit &lt;cuit&gt; - consulta inversa por CUIT',
  '/basico &lt;dni&gt; - apellido, nombre, DNI, CUIT, CUIL, sexo, nacionalidad',
  '/ambig - DNIs con más de un CUIT',
  '/random [afip] - DNI del pool; con afip, al azar del padrón',
  '',
  '<b>stock</b>',
  '/cargar - pegar lineas o .txt con leyenda /cargar',
  '/stock - resumen por BIN',
  '/bin &lt;bin&gt; - listado y datos del BIN',
  '/full - todo el disponible en .txt',
  '/saldeadas [todo] - saldeadas disponibles, numero xxxx + saldo',
  '/pedir &lt;n|ultimos4&gt; - envía la #n (o la que termina en esos 4) y la marca VENDIDA',
  '/revisar [n] - cliente se quejó: saca la #n (o la última venta) a REVISION',
  '/dead &lt;n&gt; - igual que /revisar',
  '/cc &lt;ref&gt; - detalle y trazabilidad',
  '/vender [n] [bin] [comprador] - vende y entrega .txt',
  '/reentrega &lt;codigo&gt; - rearma la entrega',
  '/devolver &lt;refs&gt; | /baja &lt;refs&gt;',
  '/reservar &lt;min&gt; &lt;refs&gt; | /expirar',
  '/saldo &lt;ref&gt; &lt;disp&gt; [total] | /etiqueta &lt;ref&gt; &lt;txt&gt;',
  '/precio &lt;bin&gt; &lt;valor&gt; | /precios | /bininfo &lt;bin&gt;',
  '/exportar [csv|txt] | /movs [ref] | /stats | /ventas | /alertas | /backup',
  '/anular &lt;refs&gt; - igual que /devolver | /cancel - cancela la operación pendiente',
  '',
  '<b>atajos</b>',
  '/v &lt;bin&gt; &lt;n&gt; - venta con confirmacion por boton',
  '/c &lt;bin&gt; &lt;n&gt; - cotizar sin vender',
  '/s /b /d /r /x /e /m /p /pl /al /st - alias de stock, bin, devolver, reservar, baja, entrega, movs, precio, precios, alertas, stats',
].join('\n');

const COMANDOS = [
  HELP,
  '',
  '<b>atajos sin comando</b>',
  'Pegar lineas <code>numero|MM|YY|CVV</code> o mandar un .txt: carga el lote y devuelve el .txt',
  'Mandar un DNI de 7 u 8 digitos: ficha del titular',
  '',
  '/comandos - esta lista completa',
].join('\n');
const PISTA = [
  'No encontré ni un DNI (7 u 8 dígitos) ni líneas de tarjetas.',
  '',
  'Pegá las líneas tal cual, por ejemplo:',
  '<code>4111111111111111|12|28|123</code>',
  'o mandá un .txt. También vale /start para ver los comandos.',
].join('\n');

export const MENU = {
  inline_keyboard: [[
    { text: '📦 Stock', callback_data: 'menu|stock' },
    { text: '🧾 Pedir', callback_data: 'menu|pedir' },
    { text: '📋 Mis tarjetas', callback_data: 'menu|mis' },
    { text: '💰 Saldo', callback_data: 'menu|saldo' },
    { text: '❓ Ayuda', callback_data: 'menu|ayuda' },
  ]],
};

const busquedas = new Map();
let seqBusqueda = 0;

function tokenBusqueda(texto) {
  const token = String(++seqBusqueda);
  busquedas.set(token, { texto });
  if (busquedas.size > 200) busquedas.delete(busquedas.keys().next().value);
  return token;
}

/* Modo publico: cualquiera ve stock a precio de tienda y se puede dar de alta
 * como vendedor, sin estar en TELEGRAM_ALLOW. Se prende con TELEGRAM_PUBLICO=1. */
export function publicoActivo() {
  return String(process.env.TELEGRAM_PUBLICO || '') === '1';
}

const AYUDA_PUBLICO = [
  '<b>resolver-ar</b> · stock disponible',
  '',
  '/stock - stock disponible por BIN',
  '/bin &lt;bin&gt; - que hay de ese BIN',
  '/vender - código de alta para vender (pedidos y precios propios)',
].join('\n');

export function ayudaPublico() {
  const base = String(process.env.URL_PUBLICA || '').replace(/\/+$/, '');
  return AYUDA_PUBLICO + (base ? '\n\nVidriera web: ' + base + '/tienda' : '');
}

const MENU_PUBLICO = {
  inline_keyboard: [[
    { text: '📦 Stock', callback_data: 'vp|stock|1' },
    { text: '❓ Ayuda', callback_data: 'vp|ayuda|1' },
  ]],
};

/* Lista blanca explicita: vacia => nadie. El dueño va en datos/bot.env. */
function permitido(chatId) {
  const lista = (process.env.TELEGRAM_ALLOW || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (lista.includes(String(chatId))) return true;
  /* Un vendedor vinculado entra aunque no este en TELEGRAM_ALLOW. */
  try { return Boolean(vinculadoA(chatId)); } catch (_) { return false; }
}

function cargarEnv() {
  for (const ruta of [RUTA_ENV_SERVER, RUTA_ENV]) {
    try {
      const txt = fs.readFileSync(ruta, 'utf8');
      for (const linea of txt.split(/\r?\n/)) {
        const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch (_) {}
  }
}

function log(msg) {
  const linea = `${new Date().toISOString()} ${msg}`;
  try {
    fs.appendFileSync(RUTA_LOG, linea + '\n');
  } catch (_) {}
  /* En background stdout ya va a datos/bot.log: no duplicar. */
  if (process.stdout.isTTY) console.log(linea);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Extrae un DNI de 7/8 digitos de un texto. Acepta puntos, espacios y guiones
 * como separadores. 7 digitos se rellena a 8 con cero a la izquierda.
 * Devuelve null si no hay un DNI claro.
 */
export function normalizarDni(texto) {
  const s = String(texto ?? '');
  if (!s.trim()) return null;
  const grupos = s.match(/\d(?:[.\s-]*\d)*/g) || [];
  for (const g of grupos) {
    const d = g.replace(/\D/g, '');
    if (d.length === 8) return d;
    if (d.length === 7) return d.padStart(8, '0');
  }
  return null;
}

/** Numeros de 13 a 19 digitos de una linea (tolera grupos 4-4-4-4). */
function numerosDeLinea(linea) {
  const grupos = String(linea ?? '').match(/\d(?:[ -]?\d){12,18}/g) || [];
  return grupos
    .map((g) => g.replace(/\D/g, ''))
    .filter((d) => d.length >= 13 && d.length <= 19);
}

/**
 * Detecta un lote por contenido, sin estado:
 *   - una linea numero|MM|YY|CVV, o
 *   - 2+ lineas con un numero de 13 a 19 digitos.
 */
export function detectarLote(texto) {
  const lineas = String(texto ?? '').split(/\r?\n/).filter((l) => l.trim());
  if (!lineas.length) return false;
  const canonica = /^\s*\d(?:[ -]?\d){12,18}\s*\|\s*\d{1,2}\s*\|\s*\d{2,4}\s*\|\s*\d{3,4}\s*$/;
  if (lineas.some((l) => canonica.test(l))) return true;
  return lineas.filter((l) => numerosDeLinea(l).length > 0).length >= 2;
}

/** Ruteo puro de un mensaje: comando, lote, DNI o texto. */
export function parsearMensaje(texto) {
  const s = String(texto ?? '').trim();
  if (s.startsWith('/')) {
    const [raw, ...args] = s.split(/\s+/);
    const cmd = raw.slice(1).split('@')[0].toLowerCase();
    return { tipo: 'comando', cmd, args };
  }
  if (detectarLote(s)) return { tipo: 'lote' };
  const dni = normalizarDni(s);
  if (dni) return { tipo: 'dni', dni };
  return { tipo: 'texto' };
}

/** Payload crudo de un comando, conservando saltos de linea. */
function payloadComando(texto) {
  return String(texto ?? '').replace(/^\/[A-Za-z0-9_]+(?:@\w+)?\s*/, '');
}

function leerOffset() {
  try {
    const j = JSON.parse(fs.readFileSync(RUTA_OFFSET, 'utf8'));
    return Number.isFinite(Number(j.offset)) ? Number(j.offset) : 0;
  } catch (_) {
    return 0;
  }
}

function guardarOffset(offset) {
  try {
    fs.mkdirSync(path.dirname(RUTA_OFFSET), { recursive: true });
    fs.writeFileSync(RUTA_OFFSET, JSON.stringify({ offset }));
  } catch (_) {}
}

async function api(metodo, params, timeoutMs = 15000, intentos = 3) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${metodo}`;
  let ultimo = null;
  for (let i = 1; i <= intentos; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) {
        throw new Error(`telegram ${metodo} http=${r.status} ${j?.description || ''}`.trim());
      }
      return j.result;
    } catch (e) {
      ultimo = e;
      /* La red a veces da UND_ERR_CONNECT_TIMEOUT en el primer intento. */
      const code = e?.cause?.code;
      const transitorio = code === 'UND_ERR_CONNECT_TIMEOUT'
        || code === 'ECONNRESET'
        || /fetch failed|aborted|timeout/i.test(String(e?.message || ''));
      if (i < intentos && transitorio) {
        await sleep(2000);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  throw ultimo || new Error(`telegram ${metodo}: sin intentos`);
}

let POLL_TIMEOUT = 50;
function getUpdates(offset) {
  return api('getUpdates', { offset, timeout: POLL_TIMEOUT, allowed_updates: ['message', 'callback_query'] }, (POLL_TIMEOUT + 10) * 1000);
}

function enviar(chatId, texto, extra = {}) {
  return api('sendMessage', {
    chat_id: chatId,
    text: texto,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

/* Lo que consume bot/vendedor.js: transporte, nunca reglas de negocio. */
const ctxBot = { enviar, escapeHtml, enviarDoc: enviarDocumento };

async function enviarDocumento(chatId, nombreArchivo, contenido, caption = '') {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendDocument`;
  let ultimo = null;

  for (let intento = 1; intento <= 3; intento++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    try {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      if (caption) form.append('caption', caption);
      form.append(
        'document',
        new Blob([contenido], { type: 'text/plain; charset=utf-8' }),
        nombreArchivo
      );
      const r = await fetch(url, { method: 'POST', body: form, signal: ctrl.signal });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) {
        throw new Error(`telegram sendDocument http=${r.status} ${j?.description || ''}`.trim());
      }
      return j.result;
    } catch (e) {
      ultimo = e;
      if (intento < 3) await sleep(2000);
    } finally {
      clearTimeout(t);
    }
  }
  throw ultimo || new Error('telegram sendDocument: sin intentos');
}

async function descargarDocumento(fileId) {
  const f = await api('getFile', { file_id: fileId });
  if (!f?.file_path) throw new Error('telegram getFile sin file_path');
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${f.file_path}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`descarga http=${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function fechaArchivo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* Manda texto largo en partes, siempre dentro de <pre>. */
async function enviarPrePartes(chatId, texto, cabecera = '') {
  const lineas = String(texto ?? '').split('\n');
  let parte = cabecera;
  for (const linea of lineas) {
    const candidato = parte ? `${parte}\n${linea}` : linea;
    if (candidato.length > 3500 && parte) {
      await enviar(chatId, '<pre>' + escapeHtml(parte) + '</pre>');
      parte = linea;
    } else {
      parte = candidato;
    }
  }
  if (parte.trim()) await enviar(chatId, '<pre>' + escapeHtml(parte) + '</pre>');
}

function sobrantesUnicos(lista) {
  const vistos = new Set();
  const out = [];
  for (const s of lista) {
    const t = String(s ?? '').trim();
    if (!t || vistos.has(t)) continue;
    vistos.add(t);
    out.push(t);
  }
  return out;
}

/* Una pagina del endpoint /lote (hasta 100 bloques). */
async function pedirLote(tarjetas, desde, saltar) {
  if (!process.env.RESOLVER_TOKEN) throw new Error('falta RESOLVER_TOKEN (datos/server.env)');
  const q = new URLSearchParams({
    token: process.env.RESOLVER_TOKEN,
    cards: tarjetas.map((t) => t.numero + '|' + t.mes + '|' + t.anio + '|' + t.codigo).join(';'),
    desde: String(desde),
    saltar: String(saltar),
  });
  const base = process.env.RESOLVER_URL || `http://localhost:${process.env.PORT || 3001}`;
  const r = await fetch(`${base}/lote?${q}`);
  if (!r.ok) throw new Error(`/lote http=${r.status}`);
  return (await r.text()).trimEnd();
}

export async function responderLote(chatId, entrada, origen = 'texto') {
  const { tarjetas, sobrantes } = parsearTarjetas(entrada);
  log(`chat=${chatId} lote origen=${origen} tarjetas=${tarjetas.length} sobrantes=${sobrantes.length}`);

  if (!tarjetas.length) {
    await enviar(chatId, PISTA);
    return;
  }

  /* Pagina sola de a 100 bloques contra /lote y manda UN solo .txt. */
  const partes = [];
  for (let i = 0; i < tarjetas.length; i += 100) {
    partes.push(await pedirLote(tarjetas.slice(i, i + 100), 1 + i, i));
  }
  const cuerpo = partes.filter(Boolean).join('\n\n');
  if (!cuerpo) {
    await enviar(chatId, 'No se pudo generar el lote.');
    return;
  }

  const lista = sobrantesUnicos(sobrantes);
  const caption = `Lote: ${tarjetas.length} bloque(s)`
    + (lista.length ? ` · ${lista.length} sobrante(s)` : '');
  await enviarDocumento(chatId, `lote-${fechaArchivo()}.txt`, cuerpo + '\n', caption);
}

/* /limpiar: cualquier formato -> lineas canonicas numero|MM|YY|CVV. */
async function responderLimpiar(chatId, entrada) {
  const { tarjetas } = parsearTarjetas(entrada);
  if (!tarjetas.length) {
    await enviar(chatId, PISTA);
    return;
  }
  const lineas = tarjetas.map((t) => `${t.numero}|${t.mes}|${t.anio}|${t.codigo}`);
  log(`chat=${chatId} limpiar tarjetas=${tarjetas.length}`);
  await enviarPrePartes(chatId, lineas.join('\n'));
}

function editar(chatId, messageId, texto, extra = {}) {
  return api('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: texto,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

async function responderFicha(chatId, dni, opts = {}) {
  const { texto } = await fichaDetalle(dni, { red: true, ...opts });
  await enviar(chatId, '<pre>' + escapeHtml(texto) + '</pre>');
}

function formatearCrudo(p) {
  return [
    `APELLIDO ${p.apellido ?? '-'}`,
    `NOMBRE ${p.nombre ?? '-'}`,
    `DENOMINACION ${p.denominacion ?? '-'}`,
    `DNI ${p.dni ?? '-'}`,
    `CUIT ${p.cuit ? formatearCuit(p.cuit) : '-'}`,
    `GANANCIAS ${p.ganancias ?? '-'}`,
    `IVA ${p.iva ?? '-'}`,
    `MONOTRIBUTO ${p.monotributo ?? '-'}`,
    `INTEGRANTE_SOC ${p.integrante_soc ?? '-'}`,
    `EMPLEADOR ${p.empleador ?? '-'}`,
    `ACTIVIDAD ${p.actividad ?? '-'}`,
  ].join('\n');
}

function renderNombre(db, texto, offset, token) {
  const { filas, haySiguiente, prefijo } = buscarPorPrefijo(db, texto, offset, 10);
  if (!filas.length) {
    return { texto: `Sin resultados para <b>${escapeHtml(prefijo || texto)}</b>.` };
  }
  const nCuits = cuitsPorDni(db, filas.map((f) => f.dni));
  const lineas = filas.map((f) => {
    const star = (nCuits.get(f.dni) || 0) > 1 ? ' *' : '';
    return `${f.apellido ?? '-'} ${f.nombre ?? '-'} — DNI ${f.dni} — CUIT ${formatearCuit(f.cuit)}${star}`;
  });
  const cab = `Resultados para ${prefijo} (desde ${offset + 1})`;
  const botones = [];
  if (offset > 0) {
    botones.push({ text: '◀ Anterior', callback_data: `nombre|${token}|${Math.max(0, offset - 10)}` });
  }
  if (haySiguiente) {
    botones.push({ text: 'Siguiente ▶', callback_data: `nombre|${token}|${offset + 10}` });
  }
  return {
    texto: '<pre>' + escapeHtml(cab + '\n' + lineas.join('\n')) + '</pre>',
    reply_markup: botones.length ? { inline_keyboard: [botones] } : undefined,
  };
}

function renderAmbig(db, offset) {
  const { filas, haySiguiente } = ambiguedades(db, offset, 10);
  if (!filas.length) return { texto: 'Sin DNIs ambiguos.' };
  const bloques = filas.map(({ dni, personas }) => {
    const lineas = personas.map((p) =>
      `  CUIT ${formatearCuit(p.cuit)} — ${p.apellido ?? '-'} ${p.nombre ?? '-'}`);
    return `DNI ${dni}\n${lineas.join('\n')}`;
  });
  const cab = `DNIs con mas de un CUIT (desde ${offset + 1})`;
  const botones = [];
  if (offset > 0) botones.push({ text: '◀ Anterior', callback_data: `ambig|${Math.max(0, offset - 10)}` });
  if (haySiguiente) botones.push({ text: 'Siguiente ▶', callback_data: `ambig|${offset + 10}` });
  return {
    texto: '<pre>' + escapeHtml(cab + '\n\n' + bloques.join('\n\n')) + '</pre>',
    reply_markup: botones.length ? { inline_keyboard: [botones] } : undefined,
  };
}

async function procesarCallback(cq, db) {
  const chatId = cq?.message?.chat?.id;
  if (chatId && !permitido(chatId) && publicoActivo()) {
    const p = String(cq.data || '').split('|');
    await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    const pagina = Number(p[p.length - 1]) || 1;
    const enviarStock = async (r) => {
      await enviar(chatId, '<pre>' + escapeHtml(r.texto) + '</pre>', r.markup ? { reply_markup: r.markup } : {});
    };
    if (p[0] === 'vp' && p[1] === 'stock') { await enviarStock(stockPublico(pagina)); return; }
    if (p[0] === 'vp' && p[1] === 'bin') { await enviarStock(binPublico(p.slice(2, -1).join('|'), pagina)); return; }
    await enviar(chatId, escapeHtml(ayudaPublico()), { reply_markup: MENU_PUBLICO });
    return;
  }
  if (!chatId || !permitido(chatId)) {
    await api('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Bot privado.',
      show_alert: false,
    }).catch(() => {});
    if (chatId) await avisarPrivado(chatId);
    return;
  }
  const partes = String(cq.data || '').split('|');
  let render = null;

  if (partes[0] === 'menu') {
    const cmd = partes[1] || 'ayuda';
    await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    if (cmd === 'ayuda') {
      const texto = esVendedorChat(chatId) ? ayudaVendedor() : COMANDOS;
      await enviar(chatId, escapeHtml(texto), { reply_markup: MENU });
      return;
    }
    if (await manejarVendedor(chatId, cmd, [], '', ctxBot)) return;
    if (await manejarStock(chatId, cmd, [], '')) return;
    await enviar(chatId, 'Comando no disponible.', { reply_markup: MENU });
    return;
  }
  if (partes[0] === 'vp') {
    const cmd = partes[1];
    const page = Number(partes[partes.length - 1]) || 1;
    const extra = partes.slice(2, -1);
    await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    await manejarVendedor(chatId, cmd, [...extra, String(page)], '', ctxBot);
    return;
  }
  if (partes[0] === 'nombre') {
    const token = partes[1];
    const offset = Math.max(0, Number(partes[2]) || 0);
    const b = busquedas.get(token);
    if (!b) {
      await api('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'Busqueda expirada. Repeti /nombre.',
      }).catch(() => {});
      return;
    }
    render = renderNombre(db, b.texto, offset, token);
  } else if (partes[0] === 'ambig') {
    render = renderAmbig(db, Math.max(0, Number(partes[1]) || 0));
  } else if (partes[0] === 'op') {
    render = await resolverOperacion(chatId, partes[1], partes[2]);
  } else {
    await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    return;
  }

  await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  await editar(chatId, cq.message.message_id, render.texto, {
    reply_markup: render.reply_markup || { inline_keyboard: [] },
  });
}

async function procesarDocumento(msg) {
  const chatId = msg.chat?.id;
  const doc = msg.document;
  const nombre = String(doc?.file_name || '');
  const mime = String(doc?.mime_type || '');
  if (!/\.(txt|csv)$/i.test(nombre) && mime !== 'text/plain') {
    await enviar(chatId, 'Mandame un archivo <b>.txt</b> con las lineas de tarjetas.');
    return;
  }
  if (Number(doc?.file_size) > 10 * 1024 * 1024) {
    await enviar(chatId, 'El archivo es demasiado grande (maximo 10 MB).');
    return;
  }

  try {
    const contenido = await descargarDocumento(doc.file_id);
    if (/^\/cargar/i.test(String(msg.caption || ''))) await manejarStock(chatId, 'cargar', [], contenido);
    await responderLote(chatId, contenido, 'documento');
  } catch (e) {
    log(`chat=${chatId} ERROR documento: ${e?.message || e}`);
    await enviar(chatId, 'No pude procesar el archivo.');
  }
}

async function avisarPrivado(chatId) {
  log(`chat=${chatId} rechazado (fuera de TELEGRAM_ALLOW)`);
  await enviar(chatId, 'Este bot es privado. Pedile acceso al dueño.').catch(() => {});
}

/* Flujo publico (chat no habilitado): ver stock y darse de alta como vendedor. */
async function manejarPublico(chatId, msg) {
  const t = String(msg?.text || '').trim();
  const cmd = (t.split(/\s+/)[0] || '').split('@')[0].toLowerCase();
  const args = t.replace(/^\/[^\s@]+(?:@\w+)?\s*/, '').trim().split(/\s+/).filter(Boolean);
  const enviarStock = async (r) => {
    await enviar(chatId, '<pre>' + escapeHtml(r.texto) + '</pre>', r.markup ? { reply_markup: r.markup } : {});
  };
  if (cmd === '/stock' || cmd === '/s') { await enviarStock(stockPublico(Number(args[0]) || 1)); return; }
  if (cmd === '/bin' || cmd === '/b') { await enviarStock(binPublico(args[0], Number(args[1]) || 1)); return; }
  if (cmd === '/vender') {
    const inv = vendedores.crearInvitacion({ dias: 7, nota: 'tg:' + chatId });
    const base = String(process.env.URL_PUBLICA || '').replace(/\/+$/, '');
    await enviar(chatId, [
      '<b>Alta de vendedor</b>',
      '',
      'Código: <code>' + escapeHtml(inv.codigo) + '</code> (vence en ' + inv.dias + ' días)',
      base
        ? 'Registrate acá y quedás habilitado: ' + escapeHtml(base + '/registro?codigo=' + inv.codigo)
        : 'Pasale este código al dueño para que te dé el alta.',
    ].join('\n'));
    return;
  }
  await enviar(chatId, escapeHtml(ayudaPublico()), { reply_markup: MENU_PUBLICO });
}

export async function procesarUpdate(update, db) {
  /* /comandos */
  {
    const _m = update?.message;
    const _t = String(_m?.text || '').trim().toLowerCase().split('@')[0];
    if (_t === '/comandos' || _t === '/comando' || _t === '/ayuda' || _t === '/start') {
      const _c = _m?.chat?.id;
      if (_c && permitido(_c)) {
        if (esVendedorChat(_c)) await enviar(_c, escapeHtml(ayudaVendedor()), { reply_markup: MENU });
        else await enviar(_c, COMANDOS, { reply_markup: MENU });
        return;
      }
      if (_c && publicoActivo()) { await manejarPublico(_c, _m); return; }
    }
  }

  if (update?.callback_query) {
    await procesarCallback(update.callback_query, db);
    return;
  }

  const msg = update?.message;
  if (!msg) return;

  const chatId = msg.chat?.id;

  /* /vincular se atiende antes de la lista blanca: es el unico puente. */
  const textoCrudo = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (/^\/vincular(?:@\w+)?(?:\s|$)/i.test(textoCrudo)) {
    const codigo = textoCrudo.replace(/^\/vincular(?:@\w+)?\s*/i, '').trim();
    await manejarVinculacion(chatId, codigo, ctxBot);
    return;
  }

  if (!permitido(chatId)) {
    if (publicoActivo()) { await manejarPublico(chatId, msg); return; }
    await avisarPrivado(chatId);
    return;
  }

  const vendedor = esVendedorChat(chatId);

  if (vendedor && typeof msg.text === 'string') {
    const cmd = String(msg.text).trim().split(/\s+/)[0].slice(1).split('@')[0].toLowerCase();
    if (cmd === 'ayuda' || cmd === 'start' || cmd === 'help') {
      await enviar(chatId, escapeHtml(ayudaVendedor()), { reply_markup: MENU });
      return;
    }
  }

  if (msg.document) {
    if (vendedor) {
      await enviar(chatId, 'Los vendedores no cargan archivos por acá. Usá /pedir &lt;bin&gt; &lt;n&gt;.');
      return;
    }
    await procesarDocumento(msg);
    return;
  }
  if (typeof msg.text !== 'string') return;

  const p = parsearMensaje(msg.text);

  if (vendedor && p.tipo !== 'comando') {
    await enviar(chatId, 'Usá los comandos de vendedor:\n\n' + escapeHtml(ayudaVendedor()));
    return;
  }

  if (p.tipo === 'comando') {
    if (await manejarVendedor(chatId, p.cmd, p.args, payloadComando(msg.text), ctxBot)) return;
    if (await manejarStock(chatId, p.cmd, p.args, payloadComando(msg.text))) return;
    if (p.cmd === 'start' || p.cmd === 'help') {
      log(`chat=${chatId} /${p.cmd}`);
      await enviar(chatId, `${HELP}\n\nTu chat id: <code>${chatId}</code>`, { reply_markup: MENU });
      return;
    }
    if (p.cmd === 'random') {
      const afip = String(p.args[0] || '').toLowerCase() === 'afip';
      const dni = afip ? dniAlAzarPadron(db) : (dniAlAzarPool(db) || dniAlAzarPadron(db));
      if (!dni) {
        await enviar(chatId, 'No pude elegir un DNI.');
        return;
      }
      log(`chat=${chatId} /random${afip ? ' afip' : ''} dni=${dni}`);
      await responderFicha(chatId, dni);
      return;
    }
    if (p.cmd === 'lote') {
      /* /lote sigue aceptandose, pero es opcional: sin payload no hay estado. */
      const payload = payloadComando(msg.text).trim();
      if (!payload) {
        await enviar(chatId, 'No hace falta /lote: pegá las líneas directamente o mandá el .txt.');
        return;
      }
      await responderLote(chatId, payload, 'comando');
      return;
    }
    if (p.cmd === 'limpiar') {
      const payload = payloadComando(msg.text).trim();
      if (!payload) {
        await enviar(chatId, 'Pegá el contenido junto al comando: <code>/limpiar 4111...|12|28|123</code>, o mandá el .txt directo.');
        return;
      }
      await responderLimpiar(chatId, payload);
      return;
    }
    if (p.cmd === 'nombre') {
      const texto = p.args.join(' ').trim();
      if (!texto) {
        await enviar(chatId, 'Uso: /nombre &lt;texto&gt;');
        return;
      }
      const token = tokenBusqueda(texto);
      const r = renderNombre(db, texto, 0, token);
      log(`chat=${chatId} /nombre texto=${texto}`);
      await enviar(chatId, r.texto, r.reply_markup ? { reply_markup: r.reply_markup } : {});
      return;
    }
    if (p.cmd === 'cuit') {
      const cuit = String(p.args[0] || '').replace(/\D/g, '');
      if (cuit.length !== 11) {
        await enviar(chatId, 'Uso: /cuit &lt;11 digitos&gt;');
        return;
      }
      const fila = buscarPorCuit(db, cuit);
      log(`chat=${chatId} /cuit cuit=${cuit} encontrado=${Boolean(fila)}`);
      if (!fila) {
        await enviar(chatId, 'CUIT no encontrado.');
        return;
      }
      if (fila.dni) {
        const { texto } = await fichaDetalle(fila.dni, { red: false });
        await enviar(chatId, '<pre>' + escapeHtml(texto) + '</pre>');
      } else {
        await enviar(chatId, '<pre>' + escapeHtml(formatearCrudo(fila)) + '</pre>');
      }
      return;
    }
    if (p.cmd === 'basico') {
      const dni = normalizarDni(p.args.join(' '));
      if (!dni) {
        await enviar(chatId, 'Uso: /basico &lt;dni&gt;');
        return;
      }
      const b = basico(db, dni);
      const lineas = [
        `APELLIDO ${b?.apellido ?? '-'}`,
        `NOMBRE ${b?.nombre ?? '-'}`,
        `DNI ${dni}`,
        `CUIT ${b?.cuit ? formatearCuit(b.cuit) : '-'}`,
        `CUIL ${b?.cuil ? formatearCuit(b.cuil) : '-'}`,
        `SEXO ${b?.sexo ?? '-'}`,
        `NACIONALIDAD ${b?.nacionalidad ?? '-'}`,
      ];
      log(`chat=${chatId} /basico dni=${dni} encontrado=${Boolean(b?.cuit)}`);
      await enviar(chatId, '<pre>' + escapeHtml(lineas.join('\n')) + '</pre>');
      return;
    }
    if (p.cmd === 'ambig') {
      const r = renderAmbig(db, 0);
      log(`chat=${chatId} /ambig`);
      await enviar(chatId, r.texto, r.reply_markup ? { reply_markup: r.reply_markup } : {});
      return;
    }
    log(`chat=${chatId} comando desconocido=${p.cmd}`);
    await enviar(chatId, HELP);
    return;
  }

  if (p.tipo === 'lote') {
    await responderLote(chatId, msg.text, 'deteccion');
    return;
  }

  if (p.tipo === 'dni') {
    log(`chat=${chatId} dni=${p.dni}`);
    await responderFicha(chatId, p.dni);
    return;
  }

  log(`chat=${chatId} texto sin DNI ni lote`);
  await enviar(chatId, PISTA);
}

async function iniciar() {
  cargarEnv();

  const token = process.env.TELEGRAM_TOKEN;
  if (!token) {
    log('ERROR: falta TELEGRAM_TOKEN en datos/bot.env');
    process.exit(1);
  }

  const db = new DatabaseSync(RUTA_DB);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA case_sensitive_like = ON');
  asegurarPool(db);
  sembrarPool(db);

  /* Avisos al vendedor y canal de auditoria: una sola cola en stock.db. */
  iniciarNotificaciones(ctxBot, Number(process.env.BOT_NOTIF_MS || 5000));

  if (!(process.env.TELEGRAM_ALLOW || '').trim()) {
    log('ERROR: falta TELEGRAM_ALLOW en datos/bot.env: el bot rechazara todos los chats');
  }

  let offset = leerOffset();
  let primerPollOk = false;
  /* El pidfile real es el del node: `nohup` forkea y bot.sh guarda el pid del
   * padre, que sobrevive al bot y hace creer que sigue vivo (dos pollers, 409). */
  try { fs.writeFileSync(path.join(RAIZ, 'datos', 'bot.pid'), process.pid + '\n'); } catch { /* sin pidfile igual arranca */ }
  log(`bot iniciado offset=${offset} token=...${token.slice(-4)}`);

  /* Menú "/" de Telegram, igual al del bot de referencia. */
  try {
    await api('setMyCommands', { commands: [
      { command: 'vender', description: 'Vender tarjetas' },
      { command: 'stock', description: 'Ver stock por país' },
      { command: 'bin', description: 'Buscar por BIN' },
      { command: 'saldeadas', description: 'Tarjetas con saldo' },
      { command: 'dead', description: 'Marcar dead' },
      { command: 'ventas', description: 'Historial de ventas' },
      { command: 'anular', description: 'Anular una venta' },
      { command: 'help', description: 'Ayuda' },
      { command: 'cancel', description: 'Cancelar operación' },
    ] });
  } catch (e) { log('setMyCommands: ' + e.message); }
/* Watchdog: si el server local deja de escuchar, se relanza solo. */
/* El bot ya vive bajo launchd: no hace falta sudo ni otro proceso. */
let caidas = 0;
setInterval(async () => {
  try {
    const r = await fetch("http://127.0.0.1:" + (process.env.PORT || 3001) + "/health", { signal: AbortSignal.timeout(1500) });
    if (r.ok) { caidas = 0; return; }
  } catch (_) {}
  caidas += 1;
  if (caidas < 2) return;
  caidas = 0;
  log("watchdog: server caido, relanzando");
  try {
    /* Via server.sh: carga datos/server.env (token incluido) y deja el pidfile,
     * asi el daemon de launchd no levanta un segundo server. */
    const h = spawn("bash", ["scripts/server.sh"], { cwd: process.cwd(), detached: true, stdio: "ignore" });
    h.unref();
  } catch (e) { log("watchdog error: " + e.message); }
}, 5000);


  let fallosSeguidos = 0;
  let ultimoAviso = 0;
  while (true) {
    try {
      const updates = await getUpdates(offset);
      fallosSeguidos = 0;
      if (!primerPollOk) { primerPollOk = true; log(`poll OK timeout=${POLL_TIMEOUT}s`); }
      for (const u of updates) {
        offset = Number(u.update_id) + 1;
        guardarOffset(offset);
        try {
          await procesarUpdate(u, db);
        } catch (e) {
          log(`ERROR update=${u.update_id}: ${e?.message || e}`);
        }
      }
    } catch (e) {
      const msg = String(e?.message || e);
      /* Algunas redes cortan long polls largos: bajar a 20s y seguir. */
      if (POLL_TIMEOUT > 20 && /fetch failed|abort|timeout/i.test(msg)) {
        POLL_TIMEOUT = 20;
        log(`long poll inestable (${msg}); bajo timeout a ${POLL_TIMEOUT}s`);
      }
      fallosSeguidos += 1;
      const backoff = Math.min(60000, 5000 * Math.pow(2, Math.min(6, fallosSeguidos - 1)));
      log(`ERROR loop: ${msg}; fallos=${fallosSeguidos} backoff=${Math.round(backoff / 1000)}s`);
      if (fallosSeguidos >= 3 && Date.now() - ultimoAviso > 600000) {
        ultimoAviso = Date.now();
        execFile('/bin/bash', ['/Users/bunker/resolver/scripts/alertar.sh',
          `Bot sin conexión con Telegram (${fallosSeguidos} fallos): ${msg}`], () => {});
      }
      await sleep(backoff);
    }
  }
}

const esMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (esMain) {
  iniciar().catch((e) => {
    log(`ERROR fatal: ${e?.message || e}`);
    process.exit(1);
  });
}

/* === random firme === */
let _colDni = null, _colListo = false;
let ultimoRandom = null;
function colDni(db) {
  if (_colListo) return _colDni;
  _colListo = true;
  try {
    const cols = db.prepare("PRAGMA table_info(personas)").all().map((c) => String(c.name));
    for (const k of ["dni", "DNI", "documento", "doc", "nro_doc", "nrodoc"]) { if (cols.indexOf(k) >= 0) { _colDni = k; break; } }
  } catch (e) {}
  return _colDni;
}

function dniAlAzarPadron(db) {
  try {
    const col = colDni(db) || "dni";
    let max = 0;
    try { const m = db.prepare("SELECT MAX(rowid) AS m FROM personas").get(); max = Number(m && m.m) || 0; } catch (e) {}
    if (max > 0) {
      for (let k = 0; k < 10; k++) {
        const r = 1 + Math.floor(Math.random() * max);
        const row = db.prepare("SELECT " + col + " AS d FROM personas WHERE rowid >= ? AND " + col + " IS NOT NULL ORDER BY rowid LIMIT 1").get(r);
        if (row && row.d && String(row.d) !== String(ultimoRandom || "")) { ultimoRandom = row.d; return row.d; }
      }
    }
    const row2 = db.prepare("SELECT " + col + " AS d FROM personas WHERE " + col + " IS NOT NULL ORDER BY RANDOM() LIMIT 1").get();
    if (row2 && row2.d) ultimoRandom = row2.d;
    return row2 ? row2.d : null;
  } catch (e) { return null; }
}

function dniAlAzarPool(db) {
  try {
    const c = db.prepare("SELECT COUNT(*) AS n FROM pool_random").get();
    if (!c || Number(c.n) < 2) return null;
    const row = db.prepare("SELECT * FROM pool_random WHERE dni <> ? ORDER BY RANDOM() LIMIT 1").get(String(ultimoRandom || ""));
    if (!row) return null;
    for (const k of ["dni", "DNI", "documento", "doc"]) { if (row[k] != null && String(row[k]).trim()) { ultimoRandom = row[k]; return row[k]; } }
    for (const v of Object.values(row)) { const t = String(v == null ? "" : v).trim(); if (/^[0-9]{7,8}$/.test(t)) { ultimoRandom = t; return t; } }
    return null;
  } catch (e) { return null; }
}
/* === fin random firme === */
