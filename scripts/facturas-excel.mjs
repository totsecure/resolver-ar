#!/usr/bin/env node
/* Cruza el resultado de ARGOS (cuil.db) con clientes.csv de facturas billeteras
 * y escribe un Excel. Lo que importa va primero: nombre, DNI, CUIL, telefono, mail.
 * Detras van los montos facturados y el contexto que trajo ARGOS.
 *
 *   node facturas-excel.mjs [salida.xlsx]
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('/opt/resolver/node_modules/xlsx');

const DB = process.env.CUIL_DB || '/opt/resolver/datos/cuil.db';
const CLI = process.env.CLIENTES || '/opt/resolver/datos/facturas/clientes.csv';
const BASE_SIN_DOC = '/opt/resolver/datos/facturas/sin-documento-resuelto.csv';
const SALIDA = process.argv[2] || '/opt/resolver/datos/facturas/clientes-argos.xlsx';

/* CSV con separador ; — soporta campos entrecomillados o pelados, con BOM */
function partirLinea(l) {
  const out = [];
  let cur = '', comilla = false;
  for (let i = 0; i < l.length; i += 1) {
    const ch = l[i];
    if (ch === '"') {
      if (comilla && l[i + 1] === '"') { cur += '"'; i += 1; }
      else comilla = !comilla;
    } else if (ch === ';' && !comilla) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function leerCsv(ruta) {
  const txt = fs.readFileSync(ruta, 'utf8').replace(/^\ufeff/, '');
  const lineas = txt.split(/\r?\n/).filter((l) => l.trim());
  const cab = partirLinea(lineas[0]);
  return lineas.slice(1).map((l) => {
    const campos = partirLinea(l);
    const o = {};
    cab.forEach((c, i) => { o[c] = (campos[i] || '').trim(); });
    return o;
  });
}

/* el Excel de origen trae nombres tipo "ABIGAIL MACARENA,ROMAGNOLI" o "  PEPE  GOMEZ " */
function limpiaNombre(n) {
  let s = String(n || '').replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
  const m = s.match(/^([A-Za-zÁÉÍÓÚÑáéíóúñ' ]+), ?([A-Za-zÁÉÍÓÚÑáéíóúñ' ]+)$/);
  if (m) s = (m[2] + ' ' + m[1]).replace(/\s+/g, ' ').trim();
  return s;
}

/* clientes.csv puede traer la misma persona en varias filas (distinto ticket,
 * nombre escrito distinto): se unifica por DNI/CUIL y se suman los montos y
 * las billeteras, para que el Excel tenga una fila por cliente. */
function unifica(lista) {
  const porClave = new Map();
  const sinClave = new Map(); // por nombre: los sin documento no tienen DNI
  for (const c of lista) {
    const clave = (c.dni || '').trim() || (c.cuil || '').trim();
    const montos = new Set((c.montos_facturados || '').split(' / ').filter(Boolean));
    const bille = new Set([(c.billeteras || '').trim()].filter(Boolean));
    if (!clave) {
      const k = (c.nombre || '').trim().toUpperCase();
      const prev = sinClave.get(k);
      if (prev) { montos.forEach((m) => prev._montos.add(m)); bille.forEach((b) => prev._bille.add(b)); }
      else sinClave.set(k, { ...c, _montos: montos, _bille: bille });
      continue;
    }
    const prev = porClave.get(clave);
    if (prev) {
      montos.forEach((m) => prev._montos.add(m));
      bille.forEach((b) => prev._bille.add(b));
      if ((c.nombre || '').length > (prev.nombre || '').length) prev.nombre = c.nombre;
    } else {
      porClave.set(clave, { ...c, _montos: montos, _bille: bille });
    }
  }
  return [...porClave.values(), ...sinClave.values()].map((c) => ({
    ...c,
    montos_facturados: [...c._montos].sort((a, b) => Number(a) - Number(b)).join(' / '),
    billeteras: [...c._bille].join(' / '),
  }));
}

const clientes = unifica([
  ...leerCsv(CLI),
  /* los 376 sin documento: van igual (nombre y montos), sin DNI no se consultan */
  ...(fs.existsSync(BASE_SIN_DOC) ? leerCsv(BASE_SIN_DOC).filter((s) => s.nombre)
    .map((s) => ({ nombre: s.nombre, dni: '', cuil: '', montos_facturados: s.montos, billeteras: '' })) : []),
]);

const db = new DatabaseSync(DB, { readOnly: true });
const porDni = db.prepare('SELECT * FROM persona WHERE dni=?');
const porCuil = db.prepare("SELECT * FROM persona WHERE cuil=? AND cuil != ''");

const filas = [];
let conMail = 0, conTel = 0, sinDatos = 0, sinConsultar = 0, conFam = 0;
for (const c of clientes) {
  const dni = (c.dni || '').trim();
  const p = (dni ? porDni.get(dni) : null) || (c.cuil ? porCuil.get(c.cuil.trim()) : null);
  const ok = !!(p && p.estado === 'ok');
  if (ok) {
    if (p.mail) conMail += 1;
    if (p.tels) conTel += 1;
    if (p.familia) conFam += 1;
  } else if (p && p.estado === 'sin_datos') sinDatos += 1;
  else if (!p && dni) sinConsultar += 1;

  const nums = (c.montos_facturados || '').split(' / ').filter(Boolean);
  const tiene = (m) => (nums.includes(m) ? 1 : '');
  const montosTxt = nums.map((m) => '$' + Number(m).toLocaleString('es-AR')).join(' / ');

  const f = {
    'Apellido y nombre': limpiaNombre(c.nombre),
    'DNI': dni,
    'CUIL': c.cuil || '',
    'Telefono': ok ? (p.tels || '') : '',
    'Mail': ok ? (p.mail || '') : '',
    '$15.000': tiene('15000'),
    '$20.000': tiene('20000'),
    '$25.000': tiene('25000'),
    '$30.000': tiene('30000'),
    '$40.000': tiene('40000'),
    '$50.000': tiene('50000'),
    '$100.000': tiene('100000'),
    '$200.000': tiene('200000'),
    'Montos': montosTxt,
    'Cant. montos': nums.length,
    'Billeteras': c.billeteras || '',
    'Nacimiento': ok ? (p.nacimiento || '') : '',
    'Edad': ok && p.edad ? Number(p.edad) : '',
    'Sexo': ok ? (p.sexo || '') : '',
    'Direccion': ok ? (p.direccion || '') : '',
    'Localidad': ok ? (p.localidad || '') : '',
    'Provincia': ok ? (p.provincia || '') : '',
    'CP': ok ? (p.cp || '') : '',
    'Convivientes': ok && p.familia ? p.familia.split(' | ').length : '',
    'Grupo familiar (nombre, edad, parentesco, DNI)': ok ? (p.familia || '') : '',
    'Estado ARGOS': p ? p.estado : (dni ? 'no consultado' : 'sin DNI en la factura'),
  };
  filas.push({ f, c });
}

/* las 5 columnas que importan, en orden; un bloque por monto; y al final el contexto */
const CAB = ['Apellido y nombre', 'DNI', 'CUIL', 'Telefono', 'Mail',
  '$15.000', '$20.000', '$25.000', '$30.000', '$40.000', '$50.000', '$100.000', '$200.000',
  'Montos', 'Cant. montos', 'Billeteras',
  'Nacimiento', 'Edad', 'Sexo', 'Direccion',
  'Localidad', 'Provincia', 'CP', 'Convivientes', 'Grupo familiar (nombre, edad, parentesco, DNI)', 'Estado ARGOS'];

/* Orden de entrega: primero los montos mas altos; dentro de cada monto, los que
 * ya tienen telefono y mail (los vendibles) y despues por apellido. */
/* mayor peso = monto mas alto */
const PESO = ['15000', '20000', '25000', '30000', '40000', '50000', '100000', '200000'];
function pesoMonto(c) {
  const nums = (c.montos_facturados || '').split(' / ').filter(Boolean);
  if (!nums.length) return -1;
  return Math.max(...nums.map((n) => PESO.indexOf(n)));
}
filas.sort((a, b) => {
  const pa = pesoMonto(a.c), pb = pesoMonto(b.c);
  if (pa !== pb) return pb - pa;
  const ta = a.f.Telefono ? 1 : 0, tb = b.f.Telefono ? 1 : 0;
  if (ta !== tb) return tb - ta;
  const ma = a.f.Mail ? 1 : 0, mb = b.f.Mail ? 1 : 0;
  if (ma !== mb) return mb - ma;
  return a.f['Apellido y nombre'].localeCompare(b.f['Apellido y nombre'], 'es');
});
const total = clientes.length;
const filasArr = filas.map(({ f }) => CAB.map((k) => f[k]));
const hoja = XLSX.utils.aoa_to_sheet([CAB, ...filasArr]);
hoja['!cols'] = [34, 11, 13, 30, 38, 9, 9, 9, 9, 9, 9, 10, 10, 22, 8, 20, 11, 6, 5, 30, 20, 16, 8, 11, 90, 14]
  .map((w) => ({ wch: w }));
hoja['!freeze'] = { xSplit: 5, ySplit: 1 };
hoja['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: filasArr.length, c: CAB.length - 1 } }) };

const resumen = [
  ['RESUMEN DEL CRUCE', ''],
  ['Clientes unicos', total],
  ['Con telefono', conTel],
  ['Con mail', conMail],
  ['Con grupo familiar', conFam],
  ['Sin datos en ARGOS', sinDatos],
  ['Sin consultar todavia', sinConsultar],
  ['% con telefono', total ? Math.round((conTel / total) * 100) + '%' : '0%'],
  ['% con mail', total ? Math.round((conMail / total) * 100) + '%' : '0%'],
  ['Generado', new Date().toISOString().slice(0, 19).replace('T', ' ')],
];
const hojaR = XLSX.utils.aoa_to_sheet(resumen);
hojaR['!cols'] = [{ wch: 30 }, { wch: 24 }];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, hojaR, 'Resumen');
XLSX.utils.book_append_sheet(wb, hoja, 'Clientes');
XLSX.writeFile(wb, SALIDA);

/* SheetJS no escribe el congelado de panel: lo inyectamos en el XML de la hoja.
 * Sin esto, con 26 columnas no ves de quien es la fila al scrollear a la derecha. */
try {
  const { execFileSync } = require('node:child_process');
  execFileSync('/usr/bin/python3', ['/opt/resolver/scripts/congelar.py', SALIDA, 'Clientes', '5', '1'], { stdio: 'pipe' });
} catch (e) {
  console.error('no pude congelar el panel: ' + (e.stderr ? e.stderr.toString().trim() : e.message));
}

console.log('clientes: ' + total + ' | con mail: ' + conMail + ' | con telefono: ' + conTel + ' | con familia: ' + conFam);
console.log('sin datos: ' + sinDatos + ' | sin consultar: ' + sinConsultar);
console.log('archivo: ' + SALIDA);
