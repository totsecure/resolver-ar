/* Manda un comando del vendedor al chat real, usando el mismo despacho del bot.
 * Uso: node scripts/prueba-bot-vendedor.mjs <chatId> /<cmd> [args...]
 * Importa bot/telegram.js (que carga los envs y arranca el poller: si el daemon
 * ya esta corriendo, este proceso pelea con 409 pero alcanza para probar).
 */
await import('/Users/bunker/resolver/bot/telegram.js');
const { manejarVendedor } = await import('/Users/bunker/resolver/bot/vendedor.js');

const [chat, cmd, ...args] = process.argv.slice(2);
const enviar = async (chatId, texto, extra = {}) => {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
  });
  return r.json();
};
const escapeHtml = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const manejado = await manejarVendedor(Number(chat), cmd.replace(/^\//, '').toLowerCase(), args, '', { enviar, escapeHtml });
console.log('manejado=' + manejado);
if (!manejado) console.log('manejarVendedor devolvio false: lo toma manejarStock.');
setTimeout(() => process.exit(0), 1200);
