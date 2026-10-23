#!/usr/bin/env node
/* test-b9-reactivar.mjs — duplicadas BAJA se pueden reactivar; activas no. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-b9-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.PUBLICAR_DIRECTO = '1';
process.env.NACIMIENTO_SINTETICO = 'coherente';

const stock = await import('../lib/stock.js');
const base = stock.base();

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }

const n1 = stock.demoNumero('411111', 16);
const texto = (titular, precio, venc = '12/28') =>
  `numero,venc,cvv,titular,dni,banco,precio\n${n1},${venc},123,${titular},30111222,Banco,${precio}\n`;

const c1 = stock.cargar(texto('TITULAR VIEJO', 100), { flexible: true, fase: 'confirmar', nombre: 'b9' });
const row1 = base.prepare('SELECT id,ref,estado,titular,precio_num,mes,anio FROM cc WHERE numero=?').get(n1);
stock.baja([row1.ref], 'test', null, 'baja para prueba');
const baja = base.prepare('SELECT estado FROM cc WHERE id=?').get(row1.id).estado;

const prev = stock.cargar(texto('TITULAR NUEVO', 200), { flexible: true, fase: 'analizar', nombre: 'b9' });
check('BAJA se marca reactivable en preview', prev.filas[0].puede_reactivar === true && prev.reactivadas_count === 0, JSON.stringify(prev.filas[0]));
check('confirmar sin flag no toca BAJA', (() => {
  const r = stock.cargar(texto('TITULAR NUEVO', 200), { flexible: true, fase: 'confirmar', nombre: 'b9' });
  return r.nuevas === 0 && r.reactivadas_count === 0 && base.prepare('SELECT estado FROM cc WHERE id=?').get(row1.id).estado === 'BAJA';
})(), 'estado=' + baja);

const prevR = stock.cargar(texto('TITULAR NUEVO', 200, '11/29'), { flexible: true, fase: 'analizar', nombre: 'b9', reactivar: true });
check('preview con flag muestra reactivada', prevR.filas[0].estado === 'reactivada' && prevR.reactivadas_count === 1, JSON.stringify(prevR.filas[0]));
const confR = stock.cargar(texto('TITULAR NUEVO', 200, '11/29'), { flexible: true, fase: 'confirmar', nombre: 'b9', reactivar: true });
const rowR = base.prepare('SELECT estado,titular,precio_num,mes,anio FROM cc WHERE id=?').get(row1.id);
check('reactivar deja REVISION con datos nuevos', confR.reactivadas_count === 1 && rowR.estado === 'REVISION' && rowR.titular === 'TITULAR NUEVO' && rowR.precio_num === 200 && rowR.mes === '11' && rowR.anio === '2029', JSON.stringify(rowR));

stock.publicar([row1.ref], 'test');
const activa = stock.cargar(texto('OTRO NOMBRE', 300), { flexible: true, fase: 'analizar', nombre: 'b9', reactivar: true });
check('duplicada activa no se reactiva', activa.filas[0].puede_reactivar === false && activa.reactivadas_count === 0, JSON.stringify(activa.filas[0]));
const activaC = stock.cargar(texto('OTRO NOMBRE', 300), { flexible: true, fase: 'confirmar', nombre: 'b9', reactivar: true });
check('activa sigue salteada', activaC.nuevas === 0 && activaC.reactivadas_count === 0 && base.prepare('SELECT titular FROM cc WHERE id=?').get(row1.id).titular === 'TITULAR NUEVO');

const n2 = stock.demoNumero('411111', 16);
const pipe = (dni) => `${n2}|12/28|123|INVENTADO|${dni}|01/01/1990|x@x.com|111|CALLE FALSA 0|CORDOBA|CORDOBA`;
stock.cargar(pipe('30111222'), { flexible: true, fase: 'confirmar', nombre: 'b9pipe' });
const row2 = base.prepare('SELECT id,ref,estado FROM cc WHERE numero=?').get(n2);
stock.baja([row2.ref], 'test');
const confP = stock.cargar(pipe('39466006'), { flexible: true, fase: 'confirmar', nombre: 'b9pipe', reactivar: true });
const rowP = base.prepare('SELECT estado,dni,titular,precio_num,mail,ciudad FROM cc WHERE id=?').get(row2.id);
check('reactivar pipe actualiza solo DNI', confP.reactivadas_count === 1 && rowP.estado === 'REVISION' && rowP.dni === '39466006' && rowP.titular === null && rowP.precio_num === null && rowP.mail === null && rowP.ciudad === null, JSON.stringify(rowP));
const movs = base.prepare("SELECT COUNT(*) n FROM movs WHERE cc_id=? AND accion='REACTIVAR'").get(row1.id).n;
check('movimiento REACTIVAR', movs === 1);

console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(FAIL === 0 ? 0 : 1);
