/* stock.js (bot) — comandos de inventario de CC para Telegram.
 * Habla con el server local por HTTP con token: no abre la base.
 */
import fs from 'node:fs';
import path from 'node:path';

const RUTA_LOG = path.join(import.meta.dirname, '..', 'datos', 'bot.log');

function log(msg) {
  try { fs.appendFileSync(RUTA_LOG, new Date().toISOString() + ' stock ' + msg + '\n'); } catch (_) {}
}

const baseUrl = () => process.env.RESOLVER_URL || ('http://localhost:' + (process.env.PORT || 3001));

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
  const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN + '/sendDocument', { method: 'POST', body: form });
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
  if (inv) await enviarPre(chat, 'INVALIDAS\n' + r.invalidas.map((i) => i.numero + ' ' + i.motivo).join('\n'));
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
  await enviarDoc(chat, 'bin-' + bin + '-' + fechaArchivo() + '.txt', j.texto + '\n', 'BIN ' + bin);
  const info = await pedir('/bininfo/' + bin);
  const desc = [info.marca, info.tipo, info.banco, info.pais].filter(Boolean).join(' · ');
  if (desc) await enviar(chat, 'BIN ' + bin + ': ' + esc(desc));
}

async function cmdFull(chat) {
  const j = await pedir('/stock/listado', { refs: '1' });
  if (!j.texto) { await enviar(chat, 'No hay CC disponibles.'); return; }
  await enviarDoc(chat, 'stock-' + fechaArchivo() + '.txt', j.texto + '\n', 'Stock disponible (con #ref)');
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
  if (!ref || !args[1]) { await enviar(chat, 'Uso: /saldo <ref> <disponible> [total]'); return; }
  const j = await pedir('/stock/saldo', { ref, disp: args[1], total: args[2] || args[1], usuario: quien, chat_id: String(chat) });
  if (!j || j.error) { await enviar(chat, 'Error: ' + esc(j?.error || 'no encontrada')); return; }
  await enviar(chat, '#' + j.ref + ' saldo actualizado: ' + j.disp + '/' + j.total);
}

async function cmdEtiqueta(chat, args, quien) {
  const ref = args[0];
  const valor = args.slice(1).join(' ').trim();
  if (!ref || !valor) { await enviar(chat, 'Uso: /etiqueta <ref> <texto>'); return; }
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
  await enviarDoc(chat, 'stock-' + fechaArchivo() + '.' + formato, (j.texto || '') + '\n', 'Export ' + formato + (estado ? ' ' + estado : ''));
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

const COMANDOS = new Set(['cargar', 'stock', 'bins', 'resumen', 'bin', 'full', 'cc', 'movs', 'vender', 'entrega', 'reentrega', 'devolver', 'baja', 'reservar', 'expirar', 'saldo', 'etiqueta', 'precio', 'precios', 'exportar', 'alertas', 'stats', 'backup', 'purgar', 'bininfo']);

export async function manejarStock(chatId, cmd, args = [], payload = '') {
  const c = String(cmd || '').toLowerCase();
  if (!COMANDOS.has(c)) return false;
  const quien = aliasDe(chatId);
  try {
    if (c === 'cargar') await cmdCargar(chatId, args, payload, quien);
    else if (c === 'stock' || c === 'bins' || c === 'resumen') await cmdStock(chatId);
    else if (c === 'bin') await cmdBin(chatId, args);
    else if (c === 'full') await cmdFull(chatId);
    else if (c === 'cc') await cmdCc(chatId, args);
    else if (c === 'movs') await cmdMovs(chatId, args);
    else if (c === 'vender') await cmdEntrega(chatId, args, quien, true);
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
