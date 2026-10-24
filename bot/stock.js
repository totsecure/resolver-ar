/* stock.js (bot) — comandos de inventario de CC para Telegram.
 * Habla con el server local por HTTP con token: no abre la base.
 */
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

const RUTA_LOG = path.join(import.meta.dirname, '..', 'datos', 'bot.log');

function log(msg) {
  try { fs.appendFileSync(RUTA_LOG, new Date().toISOString() + ' stock ' + msg + '\n'); } catch (_) {}
}

const baseUrl = () => process.env.RESOLVER_URL || ('http://127.0.0.1:' + (process.env.PORT || 3001));

async function pedir(ruta, params = {}, cuerpo = null) {
  const q = new URLSearchParams({ token: process.env.RESOLVER_TOKEN || '', ...params });
  const opciones = { method: cuerpo ? 'POST' : 'GET' };
  if (cuerpo) {
    opciones.headers = { 'content-type': 'application/json' };
    opciones.body = JSON.stringify(cuerpo);
  }
  const r = await fetch(baseUrl() + ruta + '?' + q, opciones);
  const texto = await r.text();
  try { return JSON.parse(texto); } catch (_) { return { error: texto.slice(0, 300) }; }
}

async function api(metodo, params) {
  const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN + '/' + metodo, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.ok) throw new Error('telegram ' + metodo + ' ' + (j?.description || r.status));
  return j.result;
}

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const enviar = (chat, texto, extra = {}) => api('sendMessage', { chat_id: chat, text: texto, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
async function enviarDoc(chat, nombre, contenido, caption = '') {
  const form = new FormData();
  form.append('chat_id', String(chat));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([contenido], { type: 'text/plain; charset=utf-8' }), nombre);
  const r = await pedirTelegram('https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN + '/sendDocument', { method: 'POST', body: form });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.ok) throw new Error('sendDocument ' + (j?.description || r.status));
}

async function enviarPre(chat, texto) {
  const lineas = String(texto === null || texto === undefined ? '' : texto).split('\n');
  let parte = '';
  for (const l of lineas) {
    const cand = parte ? parte + '\n' + l : l;
    if (cand.length > 3500 && parte) { await enviar(chat, '<pre>' + esc(parte) + '</pre>'); parte = l; }
    else parte = cand;
  }
  if (parte.trim()) await enviar(chat, '<pre>' + esc(parte) + '</pre>');
}

function fechaArchivo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function aliasDe(chatId) {
  const lista = String(process.env.TELEGRAM_VENDEDORES || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const par of lista) {
    const i = par.indexOf(':');
    if (i === -1) continue;
    if (par.slice(0, i).trim() === String(chatId)) return par.slice(i + 1).trim() || 'vendedor';
  }
  if (String(process.env.TELEGRAM_ADMIN || '') === String(chatId)) return 'admin';
  return 'chat' + chatId;
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const refsDe = (args) => args.join(' ').split(/[\s,] /).filter(Boolean);
const umbral = () => num(process.env.STOCK_UMBRAL, 2);

function avisoBajo(j) {
  const al = (j && j.alertas) || [];
  return al.length ? 'Stock bajo: ' + al.map((a) => a.bin + '(' + a.n + ')').join(' ') : '';
}
async function cmdCargar(chat, args, payload, quien) {
  const texto = String(payload || '').trim();
  if (!texto) {
    await enviar(chat, 'Uso: pegá las líneas junto al comando, o mandá el .txt con la leyenda <code>/cargar</code>.');
    return;
  }
  const etiqueta = args.join(' ').trim() || undefined;
  const r = await pedir('/stock/cargar', {}, { texto, etiqueta, usuario: quien, chat_id: String(chat) });
  if (r.error) { await enviar(chat, 'Error: ' + esc(r.error)); return; }
  const dups = (r.duplicadas || []).length;
  const inv = (r.invalidas || []).length;
  log('cargar chat=' + chat + ' nuevas=' + r.nuevas + ' dups=' + dups + ' inv=' + inv);
  await enviar(chat, 'Cargadas <b>' + r.nuevas + '</b>' + (dups ? ' · ya estaban ' + dups : '') + (inv ? ' · inválidas ' + inv : '') + (etiqueta ? ' · etiqueta ' + esc(etiqueta) : ''));
  if (r.avisos.length) await enviarPre(chat, 'AVISOS largo: ' + r.avisos.map(function(x){return x.numero + ' ' + x.motivo}).join(' ')); if (inv) await enviarPre(chat, 'INVALIDAS\n' + r.invalidas.map((i) => i.numero + ' ' + i.motivo).join('\n'));
}

async function cmdStock(chat) {
  const j = await pedir('/stock', { umbral: String(umbral()) });
  if (j.error) { await enviar(chat, 'Error: ' + esc(j.error)); return; }
  const lineas = (j.resumen || []).map((b) => b.bin + ' ' + (b.etiqueta || '') + ' disp ' + b.disp + ' res ' + b.res + ' vend ' + b.vend + ' baja ' + b.baja + ' saldo ' + (b.saldo || 0));
  await enviarPre(chat, 'STOCK por BIN\n' + (lineas.join('\n') || '(vacio)') + '\n\ntotal ' + j.total + ' · ventas ' + j.ventas);
  const a = avisoBajo(j);
  if (a) await enviar(chat, esc(a));
}

async function cmdBin(chat, args) {
  const bin = String(args[0] || '').replace(/\D/g, '');
  if (!bin) { await enviar(chat, 'Uso: /bin 516585'); return; }
  const j = await pedir('/stock/bin/' + bin);
  if (!j.texto) { await enviar(chat, 'Sin disponibles para BIN ' + bin); return; }
  if (j.texto.length < 3400) await enviarPre(chat, j.texto);
  else await enviarDoc(chat, 'bin-' + bin + '-' + fechaArchivo() + '.txt', j.texto + '\n', 'BIN ' + bin);
  const info = await pedir('/bininfo/' + bin);
  const desc = [info.marca, info.tipo, info.banco, info.pais].filter(Boolean).join(' · ');
  if (desc) await enviar(chat, 'BIN ' + bin + ': ' + esc(desc));
}

async function cmdSaldeadas(chat, args) {
  const todo = (args || []).some((x) => String(x).toLowerCase() === 'todo');
  const j = await pedir('/stock/saldeadas', todo ? { todo: '1' } : {});
  const texto = (j && j.texto) || '';
  if (!texto || /^Sin stock disponible/.test(texto)) { await enviar(chat, 'No hay saldeadas disponibles.'); return; }
  if (texto.length < 3400) await enviarPre(chat, texto);
  else await enviarDoc(chat, 'saldeadas-' + fechaArchivo() + '.txt', texto + '\n', 'Saldeadas');
}

/* /pedir N — envía la tarjeta N (igual que /saldeadas) completa y la marca VENDIDA. */
async function cmdPedir(chat, args, quien) {
  const primero = String((args || [])[0] || '').trim();
  /* /pedir sin número (o "saldeadas"): lista como /saldeadas. */
  if (!/^\d+$/.test(primero)) return cmdSaldeadas(chat, args);
  const n = Number(primero);
  if (!Number.isFinite(n) || n < 1) { await enviar(chat, 'Uso: /pedir <numero>  (mirá la lista con /saldeadas)'); return; }
  const j = await pedir('/stock/pedir', {}, { n: String(n), usuario: quien, chat_id: String(chat), comprador: '' });
  if (j && j.error === 'no_encontrada') { await enviar(chat, 'No existe la #' + n + '. Mirá /saldeadas.'); return; }
  if (j && j.error) { await enviar(chat, 'No se pudo pedir la #' + n + ': ' + esc(j.error)); return; }
  await enviarDoc(chat, 'tarjeta-' + n + '.txt', (j.bloque || '') + '\n', 'Venta ' + (j.codigo || ''));
  await enviar(chat, '✅ #' + n + ' enviada y marcada <b>VENDIDA</b>' + (j.codigo ? ' (' + esc(j.codigo) + ')' : '') +
    '.\nEl cliente tiene 5 min para chequear.\nSi se queja: /revisar ' + n + ' (o solo /revisar dentro de los 5 min).\nSi está OK: no hacés nada.');
}

/* /revisar [N] — el cliente se quejó: la saca de la venta y la manda a REVISION.
 * Sin N, revisa la última tarjeta vendida por este chat (ventana de 5 min). */
async function cmdRevisar(chat, args, quien) {
  const arg = String((args || [])[0] || '').trim();
  const cuerpo = { usuario: quien, chat_id: String(chat) };
  if (/^\d+$/.test(arg)) cuerpo.n = arg;
  else if (arg) cuerpo.ref = arg;
  const j = await pedir('/stock/revisar', {}, cuerpo);
  if (j && j.error === 'no_encontrada') { await enviar(chat, 'No encontré la tarjeta (poné el número o /saldeadas).'); return; }
  if (j && j.error) { await enviar(chat, 'No se pudo enviar a revisión: ' + esc(j.error)); return; }
  await enviar(chat, '🔎 ' + (cuerpo.n ? '#' + cuerpo.n + ' ' : '') + 'enviada a REVISION (salida de la venta). La revisás en la web.');
}

async function cmdFull(chat) {
  const j = await pedir('/stock/listado', { refs: '1' });
  if (!j.texto) { await enviar(chat, 'No hay CC disponibles.'); return; }
  if (j.texto.length < 3400) await enviarPre(chat, j.texto);
  else await enviarDoc(chat, 'stock-' + fechaArchivo() + '.txt', j.texto + '\n', 'Stock disponible (con #ref)');
}
async function cmdCc(chat, args) {
  const ref = args[0];
  if (!ref) { await enviar(chat, 'Uso: /cc <ref|numero|ultimos4>'); return; }
  const j = await pedir('/stock/cc/' + encodeURIComponent(ref));
  if (!j.ccs || !j.ccs.length) { await enviar(chat, 'No encontrada.'); return; }
  const lineas = j.ccs.map((x) => '#' + x.ref + ' ' + x.numero + ' ' + x.mes + '/' + x.anio + ' ' + x.cvv + ' · ' + x.estado + ' · ' + x.etiqueta + ' · ' + (x.saldo_disp || '-') + '/' + (x.saldo_total || '-') + (x.codigo_venta ? ' · ' + x.codigo_venta + ' ' + (x.vendido_a || '') : ''));
  await enviarPre(chat, lineas.join('\n'));
}

async function cmdMovs(chat, args) {
  const j = args[0] ? await pedir('/stock/movs/' + encodeURIComponent(args[0])) : await pedir('/stock/movs', { n: '40' });
  const lineas = [];
  const bloques = (j.movs || []).filter((m) => m && m.cc);
  if (bloques.length) {
    for (const b of bloques) for (const m of b.movs) lineas.push('#' + b.cc.ref + ' ' + String(m.fecha).slice(0, 16) + ' ' + m.accion + ' ' + (m.usuario || '') + ' ' + (m.detalle || ''));
  } else {
    for (const m of j.movs || []) lineas.push('#' + m.ref + ' ' + String(m.fecha).slice(0, 16) + ' ' + m.accion + ' ' + (m.usuario || '') + ' ' + (m.detalle || ''));
  }
  await enviarPre(chat, lineas.length ? lineas.join('\n') : 'sin movimientos');
}

async function cmdEntrega(chat, args, quien, esVenta) {
  const formato = args.find((a) => /^(bloques|compacto|listado)$/.test(a)) || (esVenta ? 'compacto' : 'bloques');
  const bin = args.find((a) => /^\d{6}$/.test(a)) || undefined;
  const cantidad = num(args.find((a) => /^\d{1,3}$/.test(a)), 1);
  const comprador = args.filter((a) => !/^\d+$/.test(a) && !/^(bloques|compacto|listado)$/.test(a)).join(' ').trim() || undefined;
  const j = await pedir('/stock/entrega', { bin, cantidad: String(cantidad), comprador, formato, usuario: quien, chat_id: String(chat), desde: '1' });
  if (j.error) { await enviar(chat, 'Error: ' + esc(j.error)); return; }
  if (!j.codigo) { await enviar(chat, 'No hay CC disponibles' + (bin ? ' en ' + bin : '') + '.'); return; }
  log('entrega chat=' + chat + ' codigo=' + j.codigo + ' n=' + j.n + ' formato=' + formato);
  if (formato !== 'bloques' && j.texto.length < 3800) await enviarPre(chat, j.texto);
  else await enviarDoc(chat, 'venta_' + j.codigo + '_completo.txt', j.texto + '\n', 'Entrega ' + j.codigo + ' · ' + j.n + ' CC');
  await enviar(chat, 'Código <b>' + esc(j.codigo) + '</b> · ' + j.n + ' CC' + (comprador ? ' → ' + esc(comprador) : ''));
  const st = await pedir('/stock', { umbral: String(umbral()) });
  const a = avisoBajo(st);
  if (a) await enviar(chat, esc(a));
}

async function cmdReentrega(chat, args) {
  if (!args[0]) { await enviar(chat, 'Uso: /reentrega V-20261022-001 [bloques|compacto]'); return; }
  const formato = args.find((a) => /^(bloques|compacto|listado)$/.test(a)) || 'bloques';
  const j = await pedir('/stock/reentrega', { codigo: args[0], formato });
  if (!j.codigo) { await enviar(chat, 'Código no encontrado.'); return; }
  if (formato !== 'bloques' && j.texto.length < 3800) await enviarPre(chat, j.texto);
  else await enviarDoc(chat, 'venta_' + j.codigo + '_completo.txt', j.texto + '\n', 'Reentrega ' + j.codigo + ' · ' + j.n + ' CC');
}

async function cmdDevolver(chat, args, quien) {
  const refs = refsDe(args);
  if (!refs.length) { await enviar(chat, 'Uso: /devolver 12 15 22'); return; }
  const j = await pedir('/stock/devolver', { refs: refs.join(','), usuario: quien, chat_id: String(chat) });
  const hechas = j.refs || [];
  await enviar(chat, hechas.length ? 'Devueltas a disponible: ' + esc(hechas.join(' ')) : 'Ninguna estaba VENDIDA.');
}

async function cmdBaja(chat, args, quien) {
  const refs = refsDe(args);
  if (!refs.length) { await enviar(chat, 'Uso: /baja 12 15'); return; }
  const j = await pedir('/stock/baja', { refs: refs.join(','), usuario: quien, chat_id: String(chat) });
  const hechas = j.refs || [];
  await enviar(chat, hechas.length ? 'Dadas de baja: ' + esc(hechas.join(' ')) : 'Nada para dar de baja.');
}

async function cmdReservar(chat, args, quien) {
  const minutos = num(args[0], 30);
  const refs = refsDe(args.slice(1));
  if (!refs.length) { await enviar(chat, 'Uso: /reservar <minutos> <refs...>'); return; }
  const j = await pedir('/stock/reservar', { refs: refs.join(','), quien, minutos: String(minutos), usuario: quien, chat_id: String(chat) });
  await enviar(chat, 'Reservadas ' + (j.refs || []).length + ' hasta ' + String(j.hasta || '').slice(11, 16) + ' UTC');
}

async function cmdExpirar(chat) {
  const j = await pedir('/stock/expirar');
  await enviar(chat, 'Reservas vencidas liberadas: ' + (j.liberadas || []).length);
}
async function cmdSaldo(chat, args, quien) {
  const ref = args[0];
  if (!ref || !args[1]) { await enviar(chat, 'Uso: /saldo &lt;ref&gt; <disponible> [total]'); return; }
  const j = await pedir('/stock/saldo', { ref, disp: args[1], total: args[2] || args[1], usuario: quien, chat_id: String(chat) });
  if (!j || j.error) { await enviar(chat, 'Error: ' + esc(j?.error || 'no encontrada')); return; }
  await enviar(chat, '#' + j.ref + ' saldo actualizado: ' + j.disp + '/' + j.total);
}

async function cmdEtiqueta(chat, args, quien) {
  const ref = args[0];
  const valor = args.slice(1).join(' ').trim();
  if (!ref || !valor) { await enviar(chat, 'Uso: /etiqueta &lt;ref&gt; <texto>'); return; }
  const j = await pedir('/stock/etiqueta', { ref, valor, usuario: quien, chat_id: String(chat) });
  if (!j || j.error) { await enviar(chat, 'Error: ' + esc(j?.error || 'no encontrada')); return; }
  await enviar(chat, '#' + j.ref + ' etiqueta: ' + esc(j.etiqueta));
}

async function cmdPrecio(chat, args) {
  const bin = String(args[0] || '').replace(/\D/g, '');
  const valor = num(args[1], null);
  if (!bin || valor === null) { await enviar(chat, 'Uso: /precio 516585 3500'); return; }
  const j = await pedir('/stock/precio', { bin, valor: String(valor) });
  await enviar(chat, 'Precio BIN ' + bin + ': ' + (j.precio || valor));
}

async function cmdPrecios(chat) {
  const j = await pedir('/stock/precios');
  const lineas = (j.precios || []).map((p) => p.bin + ' = ' + p.precio + ' ' + (p.moneda || ''));
  await enviarPre(chat, lineas.length ? lineas.join('\n') : 'sin precios cargados');
}

async function cmdExportar(chat, args) {
  const formato = args[0] === 'txt' ? 'txt' : 'csv';
  const estado = args.map((a) => a.toUpperCase()).find((a) => ['DISPONIBLE', 'RESERVADA', 'VENDIDA', 'BAJA'].includes(a));
  const j = await pedir('/stock/exportar', { formato, estado });
  if (j.texto.length < 3400) await enviarPre(chat, j.texto);
  else await enviarDoc(chat, 'stock-' + fechaArchivo() + '.txt', j.texto + '\n', 'Stock disponible (con #ref)');
}

async function cmdAlertas(chat) {
  const j = await pedir('/stock/alertas', { umbral: String(umbral()) });
  const al = j.alertas || [];
  await enviar(chat, al.length ? 'Stock bajo: ' + al.map((a) => a.bin + '(' + a.n + ')').join(' ') : 'Sin alertas (umbral ' + umbral() + ')');
}

async function cmdStats(chat) {
  const j = await pedir('/stock/stats');
  const lineas = (j.porEstado || []).map((e) => e.estado + ': ' + e.n + ' · saldo ' + (e.saldo || 0));
  await enviarPre(chat, 'Total ' + j.total + ' · ventas ' + j.ventas + '\n' + lineas.join('\n'));
}

async function cmdBackup(chat) {
  const j = await pedir('/stock/backup');
  await enviar(chat, 'Backup: <code>' + esc(j.archivo) + '</code>');
}

async function cmdPurgar(chat, args) {
  const dias = num(args[0], 30);
  const j = await pedir('/stock/purgar', { dias: String(dias) });
  await enviar(chat, 'Archivadas ' + j.archivadas + ' vendidas' + (j.archivo ? ' en ' + esc(j.archivo) : ''));
}

async function cmdBinInfo(chat, args) {
  const bin = String(args[0] || '').replace(/\D/g, '');
  if (!bin) { await enviar(chat, 'Uso: /bininfo 516585'); return; }
  const j = await pedir('/bininfo/' + bin, { forzar: '1' });
  const lineas = ['BIN ' + bin, 'marca: ' + (j.marca || '-'), 'tipo: ' + (j.tipo || '-'), 'banco: ' + (j.banco || '-'), 'pais: ' + (j.pais || '-'), 'moneda: ' + (j.moneda || '-'), 'fuente: ' + (j.fuente || 'local')];
  await enviarPre(chat, lineas.join('\n'));
}

const COMANDOS = new Set(['cargar', 'stock', 'bins', 'resumen', 'bin', 'full', 'cc', 'movs', 'vender', 'entrega', 'reentrega', 'devolver', 'baja', 'reservar', 'expirar', 'saldo', 'etiqueta', 'precio', 'precios', 'exportar', 'alertas', 'stats', 'backup', 'purgar', 'bininfo', 'saldeadas', 'pedir', 'revisar']);

/* === atajos === */
const ALIAS = {
  v: 'vender', venta: 'venta', c: 'cotizar', s: 'stock', b: 'bin', d: 'devolver',
  x: 'baja', r: 'reservar', e: 'entrega', m: 'movs', p: 'precio', pl: 'precios',
  al: 'alertas', st: 'stats', et: 'etiqueta', sa: 'saldo', bi: 'bininfo',
  re: 'reentrega', ca: 'cargar', f: 'full', ex: 'exportar',
  sal: 'saldeadas', sd: 'saldeadas',
  q: 'pedir', pd: 'pedir', rv: 'revisar', dead: 'revisar', queja: 'revisar',
};
COMANDOS.add('cotizar');
COMANDOS.add('venta');

function partesVenta(args) {
  const txt = (args || []).map((x) => String(x));
  const nums = txt.filter((x) => /^[0-9]+$/.test(x));
  const otros = txt.filter((x) => !/^[0-9]+$/.test(x));
  const largo = nums.find((x) => x.length >= 6) || "";
  const corto = nums.find((x) => x.length < 6) || "";
  let n = corto ? Number(corto) : 0;
  if (!n) n = largo ? 1 : 0;
  return { n, bin: largo, comprador: otros.length ? otros[otros.length - 1] : "" };
}

async function precioDe(bin) {
  if (!bin) return null;
  try {
    const pr = await pedir('/stock/precios');
    const raw = pr && pr.precios;
    if (!raw) return null;
    let arr = [];
    if (Array.isArray(raw)) arr = raw;
    else if (typeof raw === 'object') arr = Object.entries(raw).map(([k, v]) => (v && typeof v === 'object') ? Object.assign({ bin: k }, v) : { bin: k, valor: v });
    const hit = arr.find((p) => String(p.bin || p.BIN || '') === String(bin));
    if (!hit) return null;
    const valor = Number(hit.valor || hit.precio || hit.monto || 0) || 0;
    if (!valor) return null;
    return { valor, moneda: hit.moneda || '' };
  } catch (_) { return null; }
}
/* === fin atajos === */

export async function manejarStock(chatId, cmd, args = [], payload = '') {
  const _raw = String(cmd || '').toLowerCase();
  const c = ALIAS[_raw] || _raw;
  if (!COMANDOS.has(c)) return false;
  const quien = aliasDe(chatId);
  try {
    if (c === 'cargar') await cmdCargar(chatId, args, payload, quien);
    else if (c === 'stock' || c === 'bins' || c === 'resumen') await cmdStock(chatId);
    else if (c === 'bin') await cmdBin(chatId, args);
    else if (c === 'cotizar') await cmdCotizar(chatId, args);
    else if (c === 'full') await cmdFull(chatId);
    else if (c === 'saldeadas') await cmdSaldeadas(chatId, args);
    else if (c === 'pedir') await cmdPedir(chatId, args, quien);
    else if (c === 'revisar') await cmdRevisar(chatId, args, quien);
    else if (c === 'cc') await cmdCc(chatId, args);
    else if (c === 'movs') await cmdMovs(chatId, args);
    else if (c === 'vender') await cmdVenderConBoton(chatId, args, quien);
    else if (c === 'venta') await cmdEntrega(chatId, args, quien, true);
    else if (c === 'entrega') await cmdEntrega(chatId, args, quien, false);
    else if (c === 'reentrega') await cmdReentrega(chatId, args);
    else if (c === 'devolver') await cmdDevolver(chatId, args, quien);
    else if (c === 'baja') await cmdBaja(chatId, args, quien);
    else if (c === 'reservar') await cmdReservar(chatId, args, quien);
    else if (c === 'expirar') await cmdExpirar(chatId);
    else if (c === 'saldo') await cmdSaldo(chatId, args, quien);
    else if (c === 'etiqueta') await cmdEtiqueta(chatId, args, quien);
    else if (c === 'precio') await cmdPrecio(chatId, args);
    else if (c === 'precios') await cmdPrecios(chatId);
    else if (c === 'exportar') await cmdExportar(chatId, args);
    else if (c === 'alertas') await cmdAlertas(chatId);
    else if (c === 'stats') await cmdStats(chatId);
    else if (c === 'backup') await cmdBackup(chatId);
    else if (c === 'purgar') await cmdPurgar(chatId, args);
    else if (c === 'bininfo') await cmdBinInfo(chatId, args);
  } catch (e) {
    log('ERROR chat=' + chatId + ' cmd=' + c + ': ' + (e?.message || e));
    await enviar(chatId, 'Error en /' + c + ': ' + esc(e?.message || e)).catch(() => {});
  }
  return true;
}

async function pedirTelegram(url, opciones, intentos = 3) {
  let ultimo = null;
  for (let i = 1; i <= intentos; i  ) {
    try {
      const r = await fetch(url, opciones);
      if (r.status >= 500 && i < intentos) { await new Promise((res) => setTimeout(res, 2000)); continue; }
      return r;
    } catch (e) {
      ultimo = e;
      if (i < intentos) await new Promise((res) => setTimeout(res, 2000));
    }
  }
  throw ultimo || new Error('telegram sin respuesta');
}

async function apiFirme(metodo, params, intentos = 3) {
  let ultimo = null;
  for (let i = 1; i <= intentos; i  ) {
    try { return await api(metodo, params); }
    catch (e) {
      ultimo = e;
      if (i < intentos) await new Promise((res) => setTimeout(res, 2000));
    }
  }
  throw ultimo;
}

api = apiFirme;

const conTimeout = async (fn, ms) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fn(ctrl.signal); } finally { clearTimeout(t); }
};

async function pedirFirme(ruta, params = {}, cuerpo = null) {
  return conTimeout(async (signal) => {
    const q = new URLSearchParams({ token: process.env.RESOLVER_TOKEN || '', ...params });
    const opciones = { method: cuerpo ? 'POST' : 'GET', signal };
    if (cuerpo) { opciones.headers = { 'content-type': 'application/json' }; opciones.body = JSON.stringify(cuerpo); }
    const r = await fetch(baseUrl() + ruta + '?' + q, opciones);
    const texto = await r.text();
    try { return JSON.parse(texto); } catch (_) { return { error: texto.slice(0, 300) }; }
  }, 25000);
}
pedir = pedirFirme;

async function apiFirme2(metodo, params, intentos = 3) {
  let ultimo = null;
  for (let i = 1; i <= intentos; i  ) {
    try {
      return await conTimeout(async (signal) => {
        const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN + '/' + metodo, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.ok) throw new Error('telegram ' + metodo + ' ' + (j?.description || r.status));
        return j.result;
      }, 20000);
    } catch (e) { ultimo = e; if (i < intentos) await new Promise((r) => setTimeout(r, 2000)); }
  }
  throw ultimo;
}
api = apiFirme2;

async function pedirTelegram2(url, opciones, intentos = 3) {
  let ultimo = null;
  for (let i = 1; i <= intentos; i  ) {
    try { return await conTimeout((signal) => fetch(url, { ...opciones, signal }), 60000); }
    catch (e) { ultimo = e; if (i < intentos) await new Promise((r) => setTimeout(r, 2000)); }
  }
  throw ultimo;
}
pedirTelegram = pedirTelegram2;

let outboxOn=false;
const outboxIntentos=new Map();
async function revisarOutbox(){
  let j;
  try{ j=await pedir('/outbox/pendientes',{n:5}); }catch(_){ return; }
  const lista=(j&&j.pendientes)||[];
  for(const p of lista){
    const chat=p.chat_id||process.env.TELEGRAM_ALLOW;
    try{
      if(p.tipo==='archivo') await enviarDoc(chat,p.nombre||'archivo.txt',p.contenido||'');
      else await enviarPre(chat,p.contenido||'');
      await pedir('/outbox/marcar',{},{id:p.id});
      outboxIntentos.delete(p.id);
      log('outbox enviado id='+p.id+' tipo='+p.tipo);
    }catch(e){
      const n=(outboxIntentos.get(p.id)||0)+1;
      outboxIntentos.set(p.id,n);
      log('outbox fallo id='+p.id+' intento='+n+': '+(e&&e.message?e.message:e));
      if(n>=5){ try{ await pedir('/outbox/marcar',{},{id:p.id,error:String(e&&e.message?e.message:e)}); }catch(_){} outboxIntentos.delete(p.id); }
    }
  }
}
export function iniciarOutbox(ms){
  if(outboxOn)return;
  outboxOn=true;
  setInterval(()=>{ revisarOutbox().catch(()=>{}); }, ms||3000);
  log('outbox poller activo');
}
if(process.env.BOT_NO_OUTBOX!=='1') setTimeout(()=>iniciarOutbox(3000),5000);

/* === botones de venta === */
const pendientes = new Map();
let seqOp = 0;

async function cmdCotizar(chatId, args) {
  const { n, bin } = partesVenta(args);
  const p = await precioDe(bin);
  const L = ['<b>Cotizacion</b>', 'bin: ' + (bin || '-'), 'cantidad: ' + (n || '-')];
  if (p) {
    L.push('precio: ' + p.valor + ' ' + p.moneda + ' c/u');
    if (n) L.push('<b>total: ' + (p.valor * n).toFixed(2) + ' ' + p.moneda + '</b>');
  } else L.push('sin precio cargado para ese BIN');
  await enviar(chatId, L.join('\n'));
}

async function cmdVenderConBoton(chatId, args, quien) {
  const { n, bin, comprador } = partesVenta(args);
  const p = await precioDe(bin);
  const L = ['<b>Confirmar venta</b>'];
  if (n) L.push('cantidad: ' + n);
  L.push('bin: ' + (bin || '-'));
  if (comprador) L.push('comprador: ' + comprador);
  if (p) {
    L.push('precio: ' + p.valor + ' ' + p.moneda + ' c/u');
    if (n) L.push('<b>total: ' + (p.valor * n).toFixed(2) + ' ' + p.moneda + '</b>');
  } else L.push('sin precio cargado');
  const id = 'o' + (++seqOp) + '-' + Date.now();
  const norm = [];
  if (n) norm.push(String(n));
  if (bin) norm.push(bin);
  if (comprador) norm.push(comprador);
  pendientes.set(id, { tipo: 'vender', args: norm, ts: Date.now() });
  await enviar(chatId, L.join('\n'), { reply_markup: { inline_keyboard: [[{ text: 'Confirmar', callback_data: 'op|ok|' + id }, { text: 'Cancelar', callback_data: 'op|no|' + id }]] } });
}

export async function resolverOperacion(chatId, accion, id) {
  const p = pendientes.get(id);
  if (!p) return { texto: 'Esa operacion ya se resolvio o expiro.' };
  pendientes.delete(id);
  if (Date.now() - p.ts > 30 * 60 * 1000) return { texto: 'Expiro (mas de 30 min). Repetila.' };
  if (accion === 'no') return { texto: 'Cancelada. No se toco el stock.' };
  if (p.tipo === 'vender') {
    await cmdEntrega(chatId, p.args, aliasDe(chatId), true);
    return { texto: 'Vendida. El .txt va en el mensaje de abajo.' };
  }
  return { texto: 'Listo.' };
}
/* === fin botones de venta === */
