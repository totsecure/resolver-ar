/* test-carga-cc.mjs — test de la carga masiva del panel (DB temporal).
 *
 *   node scripts/test-carga-cc.mjs
 *
 * 3 validas + 1 duplicada + 1 invalida. Verifica analizar, confirmar,
 * idempotencia (segunda corrida no duplica), codigo/huella/mascara/vencimiento.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-cc-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.PUBLICAR_DIRECTO = '1';

const { analizar, confirmar, lote } = await import('../lib/carga-cc.js');
const { base } = await import('../lib/stock.js');

const TEXTO = [
  '4111111111111111,12/28,123,Juan Perez,30123456,Banco Test,150.00',
  '5555555555554444|09/29|456|Maria Gomez|27876543|Banco Dos|200',
  '378282246310005;11/30;789;Carlos Ruiz;20333444;Amex Bank',
  '4111111111111111,12/28,123,Juan Perez,30123456,Banco Test,150.00',
  '4111111111111112,12/28,999,Firma Mala,30000000,Banco Malo',
].join('\n');

let ok = 0;
let fail = 0;
const check = (cond, etiqueta, detalle = '') => {
  if (cond) { ok++; console.log('  OK    ' + etiqueta + (detalle ? ' :: ' + detalle : '')); }
  else { fail++; console.log('  FAIL  ' + etiqueta + (detalle ? ' :: ' + detalle : '')); }
};

console.log('TEST carga-cc — ' + new Date().toISOString());
const a = analizar(TEXTO);
check(a.fase === 'analizar', 'fase analizar', 'total=' + a.total);
check(a.nuevas === 3, 'validas detectadas=3', 'nuevas=' + a.nuevas);
check(a.duplicadas_count === 1, 'duplicada en el lote=1', JSON.stringify(a.duplicadas[0] || {}));
check(a.invalidas_count === 1, 'invalida (luhn)=1', JSON.stringify(a.invalidas[0] || {}));
check(a.ids.length === 0, 'analizar no inserta', 'ids=' + a.ids.length);

const r = await confirmar(TEXTO, { sinBin: true, nombre: 'test' });
check(r.nuevas === 3, 'confirmar inserta 3', 'nuevas=' + r.nuevas);
check(r.duplicadas_count === 1 && r.invalidas_count === 1, 'confirmar reporta 1 dup + 1 invalida');
check(r.lote_id > 0, 'lote_id', 'id=' + r.lote_id);

const d = base();
const filas = d.prepare('SELECT numero, codigo, huella, numero_mask, venc_mm, venc_yy, dias_para_vencer, vencida, lote_id, luhn_ok, largo_ok FROM cc ORDER BY id').all();
check(filas.length === 3, 'filas en DB=3', 'n=' + filas.length);
check(filas.every((f) => f.codigo && f.codigo.length === 7 && !/[01OIL]/.test(f.codigo)), 'codigo corto base32', filas.map((f) => f.codigo).join(','));
check(new Set(filas.map((f) => f.huella)).size === 3, 'huellas unicas');
check(filas.every((f) => /^\d{8}x{3,7}\d{4}$/.test(f.numero_mask) && f.numero_mask.length === f.numero.length), 'mascara fiel al largo', filas[0].numero_mask);
check(filas[1].venc_mm === '09' && filas[1].venc_yy === '2029', 'vencimiento normalizado', filas[1].venc_mm + '/' + filas[1].venc_yy);
check(filas.every((f) => f.dias_para_vencer != null), 'dias_para_vencer calculado', filas.map((f) => f.dias_para_vencer).join(','));
check(filas.every((f) => f.lote_id === r.lote_id), 'lote_id en las filas');
check(filas.every((f) => f.luhn_ok === 1 && f.largo_ok === 1), 'luhn_ok/largo_ok');

const l = lote(r.lote_id);
check(l && l.lote.estado === 'parcial' && l.filas.length === 3, 'lote consultable', l && l.lote.estado);

const r2 = await confirmar(TEXTO, { sinBin: true, nombre: 'test2' });
check(r2.nuevas === 0, 'segunda corrida no duplica', 'nuevas=' + r2.nuevas);
check(r2.duplicadas_count === 4, 'segunda corrida: 4 duplicadas', 'dup=' + r2.duplicadas_count);
check(d.prepare('SELECT COUNT(*) n FROM cc').get().n === 3, 'sigue habiendo 3 en DB');

console.log('\nRESUMEN: ' + ok + ' OK / ' + fail + ' FAIL');
try { d.close(); } catch (_) {}
for (const f of [process.env.RESOLVER_STOCK_DB, process.env.RESOLVER_STOCK_DB + '-wal', process.env.RESOLVER_STOCK_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch (_) {}
}
try { fs.rmdirSync(dir); } catch (_) {}
process.exit(fail ? 1 : 0);
