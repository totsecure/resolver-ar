/* Manda un comando del vendedor al chat real, usando el mismo codigo del bot
 * (bot/vendedor.js) pero sin arrancar el poller.
 * Uso: node scripts/prueba-bot-vendedor.mjs <chatId> /<cmd> [args...]
 */
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = '/Users/bunker/resolver';
for (const archivo of ['datos/server.env', 'datos/bot.env']) {
  const ruta = path.join(RAIZ, archivo);
  if (!fs.existsSync(ruta)) continue;
  for (const linea of fs.readFileSync(ruta, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(linea.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { manejarVendedor } = await import(RAIZ + '/bot/vendedor.js');

const [chat, cmd, ...args] = process.argv.slice(2);
const enviar = async (chatId, texto, extra = {}) => {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
  });
  const j = await r.json();
  console.log('telegram ok=' + j.ok + (j.ok ? ' id=' + j.result.message_id : ' error=' + j.description));
  return j;
};
const escapeHtml = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const manejado = await manejarVendedor(Number(chat), cmd.replace(/^\//, '').toLowerCase(), args, '', { enviar, escapeHtml });
console.log('manejado=' + manejado);
if (!manejado) console.log('manejarVendedor devolvio false: lo toma manejarStock.');
process.exit(0);
