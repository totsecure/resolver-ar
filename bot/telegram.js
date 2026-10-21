/* telegram.js — bot de Telegram para resolver-ar.
 *
 * Long polling con getUpdates (timeout 50), offset persistido en
 * datos/bot-offset.json. Sin dependencias: fetch global de Node 24.
 *
 * Comandos: /start, /help, /random, /random afip, /refresh <dni>.
 * Cualquier mensaje con 7 u 8 digitos (aunque tenga puntos/espacios) es un DNI.
 *
 * Respuesta: las 10 lineas de lib/ficha.js dentro de <pre>, parse_mode HTML.
 * Importa lib/ficha.js directo (no HTTP) y usa red=true.
 */

import fs from 'node:fs';
import dns from 'node:dns';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as pathResolver from 'path';

import { fichaDetalle } from '../lib/ficha.js';
import { asegurarPool, sembrarPool, elegirDelPool, randomAfip } from '../scripts/pool.js';
import {
  buscarPorPrefijo, ambiguedades, buscarPorCuit, basico,
  formatearCuit, cuitsPorDni,
} from '../lib/padron.js';
import { armarBloque, generarLote, seleccionarTitulares, parsearCards } from '../lib/lote.js';

/* Preferir IPv4: en esta red el AAAA de Telegram a veces cuelga. */
dns.setDefaultResultOrder('ipv4first');

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_ENV = path.join(RAIZ, 'datos', 'bot.env');
const RUTA_OFFSET = path.join(RAIZ, 'datos', 'bot-offset.json');
const RUTA_LOG = path.join(RAIZ, 'datos', 'bot.log');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');

const HELP = [
  '<b>resolver-ar</b>',
  'Mandame un DNI de 7 u 8 digitos y te devuelvo la ficha.',
  '',
  '/lote - genera un lote de tarjetas (usa items del padron)',
  '/nombre &lt;texto&gt; - buscar por apellido o nombre',
  '/cuit &lt;cuit&gt; - consulta inversa por CUIT',
  '/basico &lt;dni&gt; - apellido, nombre, DNI, CUIT, CUIL, sexo, nacionalidad',
  '/ambig - DNIs con mas de un CUIT',
  '/random - DNI del pool',
  '/random afip - DNI al azar del padron',
  '/refresh &lt;dni&gt; - vuelve a consultar RENAPER',
  '/help - esta ayuda',
].join('\n');

const busquedas = new Map();
let seqBusqueda = 0;

function tokenBusqueda(texto) {
  const token = String(++seqBusqueda);
  busquedas.set(token, { texto });
  if (busquedas.size > 200) busquedas.delete(busquedas.keys().next().value);
  return token;
}

function permitido(chatId) {
  const lista = (process.env.TELEGRAM_ALLOW || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return !lista.length || lista.includes(String(chatId));
}

function cargarEnv() {
  try {
    const txt = fs.readFileSync(RUTA_ENV, 'utf8');
    for (const linea of txt.split(/\r?\n/)) {
      const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
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

/** Ruteo puro de un mensaje: comando, DNI o texto. */
export function parsearMensaje(texto) {
  const s = String(texto ?? '').trim();
  if (s.startsWith('/')) {
    const [raw, ...args] = s.split(/\s+/);
    const cmd = raw.slice(1).split('@')[0].toLowerCase();
    return { tipo: 'comando', cmd, args };
  }
  const dni = normalizarDni(s);
  if (dni) return { tipo: 'dni', dni };
  return { tipo: 'texto' };
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

async function enviarDocumento(chatId, texto, nombreArchivo, metodo) {
  return api(metodo, {
    chat_id: chatId,
    document: {
      source: 'file',
      filename: nombreArchivo,
      mimeType: 'text/plain',
    },
    caption: texto,
  });
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
  if (!chatId || !permitido(chatId)) {
    await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    return;
  }
  const partes = String(cq.data || '').split('|');
  let render = null;

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
  } else {
    await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    return;
  }

  await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  await editar(chatId, cq.message.message_id, render.texto, {
    reply_markup: render.reply_markup || { inline_keyboard: [] },
  });
}

async function procesarUpdate(update, db) {
  if (update?.callback_query) {
    await procesarCallback(update.callback_query, db);
    return;
  }

  const msg = update?.message;
  if (!msg || typeof msg.text !== 'string') return;

  const chatId = msg.chat?.id;
  if (!permitido(chatId)) {
    log(`chat=${chatId} ignorado (fuera de TELEGRAM_ALLOW)`);
    return;
  }

  const p = parsearMensaje(msg.text);

  if (p.tipo === 'comando') {
    if (p.cmd === 'start') {
      log(`chat=${chatId} /start`);
      await enviar(chatId, `${HELP}\n\nTu chat id: <code>${chatId}</code>`);
      return;
    }
    if (p.cmd === 'help') {
      log(`chat=${chatId} /help`);
      await enviar(chatId, HELP);
      return;
    }
    if (p.cmd === 'random') {
      const afip = String(p.args[0] || '').toLowerCase() === 'afip';
      const dni = afip ? randomAfip(db) : (elegirDelPool(db) || randomAfip(db));
      if (!dni) {
        await enviar(chatId, 'No pude elegir un DNI.');
        return;
      }
      log(`chat=${chatId} /random${afip ? ' afip' : ''} dni=${dni}`);
      await responderFicha(chatId, dni);
      return;
    }
    if (p.cmd === 'lote') {
      const textoEntrada = p.args.join(' ').trim() || '';
      
      if (!textoEntrada) {
        await enviar(chatId, 'Uso: /lote &lt;numero|MM|YY|CVV o nombre.txt&gt; o adjuntar nombre.txt');
        return;
      }
      
      // Verificar si es un archivo
      if (textoEntrada.endsWith('.txt')) {
        const rutaArchivo = pathResolver.join(RAIZ, 'datos', textoEntrada);
        try {
          const contenido = fs.readFileSync(rutaArchivo, 'utf8');
          const lista = parsearCards(contenido);
          
          if (lista.length === 0) {
            await enviar(chatId, 'No se encontraron tarjetas válidas en el archivo.');
            return;
          }
          
          // Generar nombre de archivo
          const fecha = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          const nombreArchivo = `lote-${fecha}.txt`;
          
          // Generar el lote
          const titulares = seleccionarTitulares(db, { cantidad: lista.length, saltar: 0 });
          const textoLote = generarLote(lista, { desde: 1, titulares });
          
          if (!textoLote) {
            await enviar(chatId, 'No se pudo generar el lote.');
            return;
          }
          
          if (lista.length <= 10) {
            await enviar(chatId, `<pre>${textoLote}</pre>`);
          }
          await enviarDocumento(chatId, `Genere ${lista.length} tarjetas`, nombreArchivo, 'sendDocument');
          
          log(`chat=${chatId} /lote archivo=${textoEntrada} cantidad=${lista.length}`);
          return;
        } catch (e) {
          await enviar(chatId, `Error al leer el archivo: ${e.message}`);
          return;
        }
      }
      
      // Procesar texto crudo
      const lista = parsearCards(textoEntrada);
      
      if (lista.length === 0) {
        await enviar(chatId, 'No se encontraron tarjetas válidas. Usá formato: numero|MM|YY|CVV o numeros separados por ;');
        return;
      }
      
      // Generar nombre de archivo
      const fecha = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const nombreArchivo = `lote-${fecha}.txt`;
      
      // Generar el lote (paginación para lotes grandes)
      const titulares = seleccionarTitulares(db, { cantidad: lista.length, saltar: 0 });
      const textoLote = generarLote(lista, { desde: 1, titulares });
      
      if (!textoLote) {
        await enviar(chatId, 'No se pudo generar el lote.');
        return;
      }
      
      if (lista.length <= 10) {
        await enviar(chatId, `<pre>${textoLote}</pre>`);
      }
      await enviarDocumento(chatId, `Genere ${lista.length} tarjetas`, nombreArchivo, 'sendDocument');
      
      log(`chat=${chatId} /lote texto cantidad=${lista.length}`);
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
    if (p.cmd === 'refresh') {
      const dni = normalizarDni(p.args.join(' '));
      if (!dni) {
        log(`chat=${chatId} /refresh invalido`);
        await enviar(chatId, 'DNI invalido.');
        return;
      }
      log(`chat=${chatId} /refresh dni=${dni}`);
      await responderFicha(chatId, dni, { forzar: true });
      return;
    }
    log(`chat=${chatId} comando desconocido=${p.cmd}`);
    await enviar(chatId, HELP);
    return;
  }

  if (p.tipo === 'dni') {
    log(`chat=${chatId} dni=${p.dni}`);
    await responderFicha(chatId, p.dni);
    return;
  }

  log(`chat=${chatId} texto sin DNI`);
  await enviar(chatId, 'Mandame un DNI de 7 u 8 digitos o /help');
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

  let offset = leerOffset();
  let primerPollOk = false;
  log(`bot iniciado offset=${offset} token=...${token.slice(-4)}`);

  while (true) {
    try {
      const updates = await getUpdates(offset);
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
      log(`ERROR loop: ${msg}; backoff 5s`);
      await sleep(5000);
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
