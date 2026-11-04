#!/usr/bin/env node
/* test-fix1-fix2.mjs — trámite pendiente fuera de todos los caminos + teléfono. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-fix12-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.MOSTRAR_TRAMITE_PENDIENTE = '0';
process.env.NACIMIENTO_SINTETICO = 'coherente';

const padron = new DatabaseSync(process.env.RESOLVER_DB);
padron.exec('CREATE TABLE IF NOT EXISTS personas(dni TEXT, apellido TEXT, nombre TEXT, cuit TEXT)');
padron.prepare('INSERT INTO personas VALUES(?,?,?,?)').run('39466006', 'GOMEZ', 'NALE MARINA', '27394660065');
const renaper = await import('../lib/renaper.js');
renaper.guardar('30756789', { nroTramite: '00744230016', fechaNac: '25/04/1984' }, { fuente: 'MANUAL', crudo: { fuente: 'manual' } });

const { fichaDetalle } = await import('../lib/ficha.js');
const { armarBloque } = await import('../lib/lote.js');
const { generarExtra, areasDeCiudad } = await import('../lib/faker-extra.js');
const { formatearTelefono, telefonoDigitos } = await import('../lib/faker-ar.js');
const catalogo = await import('../lib/catalogo.js');
const stock = await import('../lib/stock.js');
const base = stock.base();

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }
const valor = (texto, etiqueta) => {
  const l = String(texto).split('\n').find((x) => x.startsWith(etiqueta + ' '));
  return l ? l.slice(etiqueta.length + 1) : null;
};

const fPend = (await fichaDetalle('39466006', { red: false })).texto;
check('ficha sin trámite pendiente', valor(fPend, 'NRO TRAMITE') === null && fPend.split('\n').length === 9, fPend.replace(/\n/g, ' | '));
const fReal = (await fichaDetalle('30756789', { red: false })).texto;
check('ficha conserva trámite real', valor(fReal, 'NRO TRAMITE') === '00744230016' && fReal.split('\n').length === 10, valor(fReal, 'NRO TRAMITE'));

const lotePend = armarBloque({ dni: '39466006', apellido: 'GOMEZ', nombre: 'NALE MARINA' }, null, null);
check('lote sin trámite pendiente', valor(lotePend, 'NRO TRAMITE') === null && lotePend.split('\n').length === 12);
const loteReal = armarBloque({ dni: '30756789', nroTramite: '00744230016' }, null, null);
check('lote conserva trámite real', valor(loteReal, 'NRO TRAMITE') === '00744230016');

const id = base.prepare('INSERT INTO cc(numero,mes,anio,cvv,bin,marca,estado,creado,nro_tramite,fecha_nac,verif_estado) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run('4111111111111111', '12', '2028', '123', '411111', 'Visa', 'DISPONIBLE', new Date().toISOString(), '(pendiente)', '(pendiente)', 'sin_verificar').lastInsertRowid;
const detPend = catalogo.detalle(base, Number(id));
check('web/catálogo sin trámite pendiente', detPend.nro_tramite === null, JSON.stringify(detPend.nro_tramite));
base.prepare("UPDATE cc SET nro_tramite='00744230016' WHERE id=?").run(id);
const detReal = catalogo.detalle(base, Number(id));
check('web/catálogo conserva trámite real', detReal.nro_tramite === '00744230016');

check('teléfono separado 3541', formatearTelefono('35410227087') === '3541 0227087', formatearTelefono('35410227087'));
check('teléfono ya separado', formatearTelefono('3541 0227087') === '3541 0227087');

let malos = 0, sinArea = 0;
for (let i = 0; i < 20; i++) {
  const dni = String(30000000 + i * 137);
  const e = generarExtra(dni);
  const tel = formatearTelefono(telefonoDigitos(dni));
  const partes = tel.split(' ');
  if (partes.length !== 2 || !partes[1]) malos++;
  const areas = areasDeCiudad(e.ciudad).map((x) => x.area);
  if (!areas.includes(partes[0]) || partes[0] !== e.area) sinArea++;
  if (partes[0] === '3541' && tel !== '3541 ' + partes[1]) malos++;
}
check('20 teléfonos con un solo espacio', malos === 0, 'malos=' + malos);
check('20 áreas coherentes con ciudad', sinArea === 0, 'sinArea=' + sinArea);
const bloques = armarBloque({ dni: '39466006' }, null, null);
check('teléfono en bloque con un espacio', /^TELEFONO \d{2,4} \d{6,8}$/m.test(bloques), valor(bloques, 'TELEFONO'));

padron.close();
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(FAIL === 0 ? 0 : 1);
