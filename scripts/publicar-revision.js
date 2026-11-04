/* publicar-revision.js — pasa a DISPONIBLE las CC que quedaron en REVISION.
 *
 * Sin argumentos publica todas; con `--lote <id>` solo las de ese lote.
 * Usa catalogo.transicion para dejar el movimiento de auditoria.
 *
 *   node scripts/publicar-revision.js [--lote <id>]
 */
import { base } from '../lib/stock.js';
import { transicion } from '../lib/catalogo.js';

const args = process.argv.slice(2);
const i = args.indexOf('--lote');
const loteId = i >= 0 ? Math.trunc(Number(args[i + 1])) : null;

const d = base();
const filtro = "estado = 'REVISION'" + (loteId ? ' AND lote_id = ' + loteId : '');
const filas = d.prepare('SELECT id, bin, ref, lote_id FROM cc WHERE ' + filtro + ' ORDER BY id').all();

let n = 0;
for (const f of filas) {
  try {
    transicion(d, f.id, 'REVISION', 'DISPONIBLE', { detalle: 'publicacion' + (loteId ? ' lote=' + loteId : '') });
    n++;
    console.log('id ' + f.id + '  bin ' + f.bin + '  ref ' + f.ref + '  lote ' + f.lote_id + '  -> DISPONIBLE');
  } catch (e) {
    console.log('id ' + f.id + '  ERROR ' + (e && e.message ? e.message : e));
  }
}
console.log(n + '/' + filas.length + ' publicadas');
