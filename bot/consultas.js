/* consultas.js (bot) — bot Telegram solo de consultas (padron + ARGOS).
 * Token propio de BotFather, offset propio. No toca stock, ventas ni outbox:
 * solo escucha y despacha contra las funciones de bot/stock.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { manejarStock } from './stock.js';

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_OFFSET = path.join(RAIZ, 'datos', 'consultas-offset.json');
const RUTA_LOG = path.join(RAIZ, 'datos', 'consultas.log');

/* Las mismas que despacha manejarStock, menos las de inventario. */
const COMANDOS = new Set([
  'randomargos', 'random', 'info', 'cuit', 'ar', 'familia', 'domicilios',
  'fallecido', 'nosis', 'local', 'renaper', 'argos', 'prewarm',
]);

const AYUDA = [
  '<b>Consultas</b> (padron)',
  '/scoring &lt;dni&gt; - scoring BCRA + situacion fiscal',
  '/info &lt;dni&gt; - datos del padron',
  '/cuit &lt;dni|cuit&gt; - CUIL',
  '/renaper &lt;dni&gt; - datos del renaper',
  '/ar &lt;dni&gt; - ARCA / afip',
  '/familia &lt;dni&gt; - grupo familiar',
  '/domicilios &lt;dni&gt; - domicilios',
  '/fallecido &lt;dni&gt; - si esta fallecido',
  '/nosis &lt;dni|cuit&gt; - nosis',
  '/local &lt;dni&gt; - datos locales',
  '/randomargos [n] - n personas al azar',
  '/random [n] - n personas al azar del padron',
  '/argos - estado del cache',
].join('\n');

function log(msg) {
  try { fs.appendFileSync(RUTA_LOG, new Date().toISOString() + ' consultas ' + msg + '\n'); } catch (_) {}
}

function api(metodo, cuerpo) {
  const url = 'https://api.telegram.org/bot' + (process.env.TELEGRAM_TOKEN || '') + '/' + metodo;
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo || {}),
  }).then((r) => r.json()).catch(() => null);
}

const enviar = (chat, texto) =>
  api('sendMessage', { chat_id: chat, text: texto, parse_mode: 'HTML', disable_web_page_preview: true });

const dueños = () =>
  String(process.env.TELEGRAM_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);

function permitido(chat) {
  const lista = dueños();
  return lista.length === 0 || lista.includes(Number(chat));
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function leerOffset() {
  try { return Number(JSON.parse(fs.readFileSync(RUTA_OFFSET, 'utf8')).offset) || 0; } catch (_) { return 0; }
}
function guardarOffset(n) {
  try { fs.writeFileSync(RUTA_OFFSET, JSON.stringify({ offset: n })); } catch (_) {}
}

export async function atender(msg) {
  const chat = msg.chat?.id;
  if (!chat) return;
  const texto = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!texto.startsWith('/')) return;

  const m = texto.match(/^\/([a-z0-9_]+)(?:@\w+)?\s*([\s\S]*)$/i);
  if (!m) return;
  const cmd = m[1].toLowerCase();
  const args = m[2].trim() ? m[2].trim().split(/\s+/) : [];

  if (!permitido(chat) && !permitido(msg.from?.id)) {
    /* En grupo el chat.id es negativo y no coincide con el del que escribe:
     * mostrar los dos para poder autorizar sin adivinar. */
    log(`rechazado chat=${chat} from=${msg.from?.id ?? '?'}`);
    await enviar(chat, 'No autorizado. chat id: <code>' + chat + '</code> / user id: <code>' + (msg.from?.id ?? '?') + '</code>');
    return;
  }

  if (cmd === 'start' || cmd === 'ayuda' || cmd === 'help') {
    log(`chat=${chat} /${cmd}`);
    await enviar(chat, AYUDA);
    return;
  }
  if (!COMANDOS.has(cmd)) {
    await enviar(chat, 'Comando desconocido: /' + cmd + '\n\n' + AYUDA);
    return;
  }

  log(`chat=${chat} /${cmd} ${args.join(' ')}`);
  await manejarStock(chat, cmd, args);
}

async function iniciar() {
  if (!process.env.TELEGRAM_TOKEN) throw new Error('falta TELEGRAM_TOKEN');
  let offset = leerOffset();
  log(`arrancado pid=${process.pid} offset=${offset} permitidos=${dueños().join(',') || 'todos'}`);

  /* Latido: el loop no loguea nada mientras nadie escribe, asi que un proceso
   * vivo pero trabado (deadlock) no dejaba rastro. Una linea cada 30s le da al
   * vigilar.sh externo una senal de frescura del log para detectar el cuelgue. */
  setInterval(() => log('latido'), 30000);
  for (;;) {
    const j = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
    if (!j || !j.ok) {
      if (j && j.error_code === 409) log('ERROR 409: otro poller con el mismo token');
      else if (j) log('ERROR getUpdates: ' + (j.description || j.error_code));
      await sleep(5000);
      continue;
    }
    for (const up of j.result || []) {
      offset = up.update_id + 1;
      guardarOffset(offset);
      try { await atender(up.message || {}); } catch (e) { log('ERROR atender: ' + (e?.message || e)); }
    }
  }
}

const esMain = process.argv[1]
  && import.meta.url === (await import('node:url')).pathToFileURL(path.resolve(process.argv[1])).href;

if (esMain) iniciar().catch((e) => { log('ERROR fatal: ' + (e?.message || e)); process.exit(1); });
