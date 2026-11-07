#!/usr/bin/env node
/* Los que vinieron sin DNI/CUIL en una factura pero SI tienen documento en otra:
 * se los empareja por nombre exacto normalizado (sin orden, sin acentos) y se
 * escribe el DNI que les falta en sin-documento-resuelto.csv.
 *
 *   node emparejar-sin-doc.mjs
 */
import fs from 'node:fs';

const BASE = '/Volumes/Boveda/resolver/datos/facturas-billeteras';
const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^A-Z ]/g, ' ')
  .split(/\s+/).filter(Boolean).sort().join(' ');

function leerCsv(ruta) {
  const txt = fs.readFileSync(ruta, 'utf8').replace(/^\ufeff/, '');
  const lineas = txt.split(/\r?\n/).filter((l) => l.trim());
  const cab = partirLinea(lineas[0]);
  return lineas.slice(1).map((l) => {
    const c = partirLinea(l);
    const o = {};
    cab.forEach((k, i) => { o[k] = (c[i] || '').trim(); });
    return o;
  });
}

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

/* indice: nombre normalizado -> [filas con documento]
 * clientes.csv ya incluye a los sin-documento (con dni/cuil vacios), asi que
 * hay que indexar solo los que SI tienen documento; si no, cada uno se
 * encuentra a si mismo y devuelve vacio. */
const conDoc = leerCsv(BASE + '/clientes.csv').filter((c) => c.dni || c.cuil);
const idx = new Map();
for (const c of conDoc) {
  const k = norm(c.nombre);
  if (!k) continue;
  if (!idx.has(k)) idx.set(k, []);
  idx.get(k).push(c);
}

const sin = leerCsv(BASE + '/sin-documento.csv');
const resueltos = [], huerfanos = [], ambiguos = [];
for (const s of sin) {
  const k = norm(s.nombre);
  const m = idx.get(k) || [];
  if (m.length === 1) resueltos.push({ nombre: s.nombre, dni: m[0].dni, cuil: m[0].cuil, montos: s.montos });
  else if (m.length > 1) ambiguos.push({ nombre: s.nombre, candidatos: m.map((x) => x.dni).join(' / '), montos: s.montos });
  else huerfanos.push({ nombre: s.nombre, montos: s.montos });
}

const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const falla = (nom, filas, cab) => fs.writeFileSync(BASE + '/' + nom,
  '\ufeff' + cab.join(';') + '\n' + filas.map((f) => f.map(esc).join(';')).join('\n') + '\n');

if (resueltos.length) falla('sin-documento-resuelto.csv', resueltos.map((r) => [r.nombre, r.dni, r.cuil, r.montos]), ['nombre', 'dni', 'cuil', 'montos']);
if (ambiguos.length) falla('sin-documento-ambiguo.csv', ambiguos.map((r) => [r.nombre, r.candidatos, r.montos]), ['nombre', 'candidatos', 'montos']);
if (huerfanos.length) falla('sin-documento-huerfano.csv', huerfanos.map((r) => [r.nombre, r.montos]), ['nombre', 'montos']);

console.log('sin documento: ' + sin.length);
console.log('emparejados 1 a 1 (ya tienen DNI de otro ticket): ' + resueltos.length);
console.log('ambiguos: ' + ambiguos.length + ' | sin match: ' + huerfanos.length);
console.log('DNI unicos nuevos a consultar: ' + new Set(resueltos.map((r) => r.dni)).size);
console.log('(los "sin match" no van a ARGOS: solo se sabe el nombre)');
