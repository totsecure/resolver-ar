import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const ST = '/Volumes/Boveda/resolver/bot/stock.js';
const TG = '/Volumes/Boveda/resolver/bot/telegram.js';
const notas = [];
let st = fs.readFileSync(ST, 'utf8');
let tg = fs.readFileSync(TG, 'utf8');

function aplicar(etiqueta, s, ancla, repl) {
  const n = s.split(ancla).length - 1;
  if (n !== 1) throw new Error(etiqueta + ': el ancla aparece ' + n + ' veces (esperaba 1)');
  notas.push('+ ' + etiqueta);
  return s.replace(ancla, repl);
}

try {
  if (st.includes('/* === atajos === */')) notas.push('= stock.js ya tenia los atajos');
  else {
    st = aplicar('mapa de alias + partesVenta + precioDe', st, 'export async function manejarStock(', [
      '/* === atajos === */',
      'const ALIAS = {',
      "  v: 'vender', venta: 'venta', c: 'cotizar', s: 'stock', b: 'bin', d: 'devolver',",
      "  x: 'baja', r: 'reservar', e: 'entrega', m: 'movs', p: 'precio', pl: 'precios',",
      "  al: 'alertas', st: 'stats', et: 'etiqueta', sa: 'saldo', bi: 'bininfo',",
      "  re: 'reentrega', ca: 'cargar', f: 'full', ex: 'exportar',",
      '};',
      "COMANDOS.add('cotizar');",
      "COMANDOS.add('venta');",
      '',
      'function partesVenta(args) {',
      '  const txt = (args || []).map((x) => String(x));',
      '  const nums = txt.filter((x) => /^[0-9]+$/.test(x));',
      '  const otros = txt.filter((x) => !/^[0-9]+$/.test(x));',
      '  const largo = nums.find((x) => x.length >= 6) || "";',
      '  const corto = nums.find((x) => x.length < 6) || "";',
      '  let n = corto ? Number(corto) : 0;',
      '  if (!n) n = largo ? 1 : 0;',
      '  return { n, bin: largo, comprador: otros.length ? otros[otros.length - 1] : "" };',
      '}',
      '',
      'async function precioDe(bin) {',
      '  if (!bin) return null;',
      '  try {',
      "    const pr = await pedir('/stock/precios');",
      '    const raw = pr && pr.precios;',
      '    if (!raw) return null;',
      '    let arr = [];',
      '    if (Array.isArray(raw)) arr = raw;',
      "    else if (typeof raw === 'object') arr = Object.entries(raw).map(([k, v]) => (v && typeof v === 'object') ? Object.assign({ bin: k }, v) : { bin: k, valor: v });",
      "    const hit = arr.find((p) => String(p.bin || p.BIN || '') === String(bin));",
      '    if (!hit) return null;',
      '    const valor = Number(hit.valor || hit.precio || hit.monto || 0) || 0;',
      '    if (!valor) return null;',
      "    return { valor, moneda: hit.moneda || '' };",
      '  } catch (_) { return null; }',
      '}',
      '/* === fin atajos === */',
      '',
      'export async function manejarStock(',
    ].join('\n'));

    st = aplicar('alias aplicado en el despacho', st,
      "  const c = String(cmd || '').toLowerCase();",
      "  const _raw = String(cmd || '').toLowerCase();\n  const c = ALIAS[_raw] || _raw;");

    st = aplicar('dispatch de cotizar', st,
      "    else if (c === 'bin') await cmdBin(chatId, args);",
      "    else if (c === 'bin') await cmdBin(chatId, args);\n    else if (c === 'cotizar') await cmdCotizar(chatId, args);");

    st = aplicar('vender con boton + venta directa', st,
      "    else if (c === 'vender') await cmdEntrega(chatId, args, quien, true);",
      "    else if (c === 'vender') await cmdVenderConBoton(chatId, args, quien);\n    else if (c === 'venta') await cmdEntrega(chatId, args, quien, true);");

    st = st + '\n' + [
      '/* === botones de venta === */',
      'const pendientes = new Map();',
      'let seqOp = 0;',
      '',
      'async function cmdCotizar(chatId, args) {',
      '  const { n, bin } = partesVenta(args);',
      '  const p = await precioDe(bin);',
      "  const L = ['<b>Cotizacion</b>', 'bin: ' + (bin || '-'), 'cantidad: ' + (n || '-')];",
      '  if (p) {',
      "    L.push('precio: ' + p.valor + ' ' + p.moneda + ' c/u');",
      "    if (n) L.push('<b>total: ' + (p.valor * n).toFixed(2) + ' ' + p.moneda + '</b>');",
      "  } else L.push('sin precio cargado para ese BIN');",
      "  await enviar(chatId, L.join('\\n'));",
      '}',
      '',
      'async function cmdVenderConBoton(chatId, args, quien) {',
      '  const { n, bin, comprador } = partesVenta(args);',
      '  const p = await precioDe(bin);',
      "  const L = ['<b>Confirmar venta</b>'];",
      "  if (n) L.push('cantidad: ' + n);",
      "  L.push('bin: ' + (bin || '-'));",
      "  if (comprador) L.push('comprador: ' + comprador);",
      '  if (p) {',
      "    L.push('precio: ' + p.valor + ' ' + p.moneda + ' c/u');",
      "    if (n) L.push('<b>total: ' + (p.valor * n).toFixed(2) + ' ' + p.moneda + '</b>');",
      "  } else L.push('sin precio cargado');",
      "  const id = 'o' + (++seqOp) + '-' + Date.now();",
      '  const norm = [];',
      '  if (n) norm.push(String(n));',
      '  if (bin) norm.push(bin);',
      '  if (comprador) norm.push(comprador);',
      "  pendientes.set(id, { tipo: 'vender', args: norm, ts: Date.now() });",
      "  await enviar(chatId, L.join('\\n'), { reply_markup: { inline_keyboard: [[{ text: 'Confirmar', callback_data: 'op|ok|' + id }, { text: 'Cancelar', callback_data: 'op|no|' + id }]] } });",
      '}',
      '',
      'export async function resolverOperacion(chatId, accion, id) {',
      '  const p = pendientes.get(id);',
      "  if (!p) return { texto: 'Esa operacion ya se resolvio o expiro.' };",
      '  pendientes.delete(id);',
      "  if (Date.now() - p.ts > 30 * 60 * 1000) return { texto: 'Expiro (mas de 30 min). Repetila.' };",
      "  if (accion === 'no') return { texto: 'Cancelada. No se toco el stock.' };",
      "  if (p.tipo === 'vender') {",
      '    await cmdEntrega(chatId, p.args, aliasDe(chatId), true);',
      "    return { texto: 'Vendida. El .txt va en el mensaje de abajo.' };",
      '  }',
      "  return { texto: 'Listo.' };",
      '}',
      '/* === fin botones de venta === */',
    ].join('\n') + '\n';
  }

  if (tg.includes('resolverOperacion')) notas.push('= telegram.js ya tenia el callback');
  else {
    tg = aplicar('import de resolverOperacion', tg,
      "import { manejarStock } from './stock.js';",
      "import { manejarStock, resolverOperacion } from './stock.js';");

    tg = aplicar('callback de operacion', tg,
      "    render = renderAmbig(db, Math.max(0, Number(partes[1]) || 0));",
      "    render = renderAmbig(db, Math.max(0, Number(partes[1]) || 0));\n  } else if (partes[0] === 'op') {\n    render = await resolverOperacion(chatId, partes[1], partes[2]);");

    tg = aplicar('atajos en el HELP', tg,
      "  '/exportar [csv|txt] | /movs [ref] | /stats | /alertas | /backup',",
      "  '/exportar [csv|txt] | /movs [ref] | /stats | /alertas | /backup',\n  '',\n  '<b>atajos</b>',\n  '/v &lt;bin&gt; &lt;n&gt; - venta con confirmacion por boton',\n  '/c &lt;bin&gt; &lt;n&gt; - cotizar sin vender',\n  '/s /b /d /r /x /e /m /p /pl /al /st - alias de stock, bin, devolver, reservar, baja, entrega, movs, precio, precios, alertas, stats',");
  }
} catch (e) {
  console.log('ABORTO: ' + e.message);
  console.log('no escribi nada');
  process.exit(1);
}

fs.copyFileSync(ST, ST + '.bak-atajos');
fs.copyFileSync(TG, TG + '.bak-atajos');
fs.writeFileSync(ST, st);
fs.writeFileSync(TG, tg);
console.log('escrito. backups .bak-atajos');
console.log(notas.join('\n'));

try {
  execFileSync('node', ['--check', ST], { stdio: 'inherit' });
  execFileSync('node', ['--check', TG], { stdio: 'inherit' });
  console.log('node --check: OK los dos');
} catch (e) { console.log('node --check: FALLO'); process.exit(1); }
