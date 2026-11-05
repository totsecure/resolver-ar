/* importar-padron-idach.mjs — P4: carga el padrón IDACH 2017 del Chaco.
 *
 *   node scripts/importar-padron-idach.mjs [--dry] [--solo-m] [--solo-f]
 *
 * Fuente publica: Tribunal Electoral del Chaco, Padrón Definitivo IDACH 2017
 * (masculino y femenino), PDFs con Matrícula/DNI, apellido y nombre, domicilio,
 * localidad y año de nacimiento.
 *
 * Regla de precisión: el PDF solo da el AÑO -> precision=anio (nunca se inventa
 * día/mes). Se guarda en fuentes_personas con fuente PADRON_IDACH_CHACO.
 * Requiere pdftotext (poppler). Idempotente.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as fuentes from '../lib/fuentes-datos.js';

const RAIZ = '/Volumes/Boveda/resolver';
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');
const FUENTE = 'PADRON_IDACH_CHACO';
const DRY = process.argv.includes('--dry');
const SOLO_M = process.argv.includes('--solo-m');
const SOLO_F = process.argv.includes('--solo-f');

const PDFS = [
  { sexo: 'M', url: 'https://electoralchaco.gov.ar/archivos/idach2021/idach_PadronDefinitivoMasculinoIDACH%202017.pdf', archivo: '/tmp/idach-m.pdf' },
  { sexo: 'F', url: 'https://electoralchaco.gov.ar/archivos/idach2021/idach_PadronDefinitivoFemeninoIDACH%202017.pdf', archivo: '/tmp/idach-f.pdf' },
].filter((p) => (SOLO_M ? p.sexo === 'M' : true) && (SOLO_F ? p.sexo === 'F' : true));

async function bajar(p) {
  if (fs.existsSync(p.archivo) && fs.statSync(p.archivo).size > 100000) return;
  console.log('  bajando ' + p.url);
  const r = await fetch(p.url, { signal: AbortSignal.timeout(120000), headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('http ' + r.status);
  fs.writeFileSync(p.archivo, Buffer.from(await r.arrayBuffer()));
}

function limpiar(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
    .replace(/\s*(?:-\*+-|-DNI-|DNI\*?|DD\*?)\s*$/i, '')
    .trim();
}

const RE = /(\d{1,3})\s+([0-9][0-9.\s]{5,14}?)\s+(\d{1,4})\s+([A-ZÁÉÍÓÚÑÜ][^,]+),\s*([\s\S]*?)(?=\s{2,}\d{1,3}\s+\d{2}\.\d{3}\.\d{3}\s+\d{1,4}\s+|$)/g;

function parsearPagina(pagina, sexo) {
  const lineas = pagina.split('\n');
  const cab = lineas.slice(0, 8).join(' ');
  const loc = (cab.match(/LOCALIDAD\s+\d+\s+(.+?)(?:\s{2,}|$)/i) || [, ''])[1].trim();
  const etnia = (cab.match(/Etnia\s+\d+\s+([A-ZÁÉÍÓÚÑ ]+)/i) || [, ''])[1].trim();
  const out = [];
  for (const linea of lineas) {
    if (!/^\s*\d{1,3}\s+[0-9]/.test(linea) && !/\s{2,}\d{1,3}\s+\d{2}\.\d{3}\.\d{3}/.test(linea)) continue;
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(linea))) {
      const orden = Number(m[1]);
      const dniBruto = m[2].replace(/\D/g, '');
      const anio = Number(m[3]);
      const nombre = limpiar(m[4]);
      const domicilio = limpiar(m[5]);
      if (!dniBruto || dniBruto.length < 7 || dniBruto.length > 8) continue;
      if (!nombre || /^(APELLIDO|NOMBRE|MATRICULA|CLASE|VOTO|ORDEN)/i.test(nombre)) continue;
      const dni = dniBruto.padStart(8, '0');
      out.push({ orden, dni, nombreCompleto: nombre, domicilio, ciudad: loc || null, provincia: 'CHACO', sexo, anioNac: (anio >= 1900 && anio <= 2020) ? String(anio) : null, etnia: etnia || null });
    }
  }
  return out;
}

console.log('PADRON IDACH CHACO 2017 — ' + new Date().toISOString());
const todos = new Map();
for (const p of PDFS) {
  await bajar(p);
  const texto = execFileSync('pdftotext', ['-layout', p.archivo, '-'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const paginas = texto.split('\f');
  let n = 0;
  for (const pag of paginas) {
    for (const r of parsearPagina(pag, p.sexo)) {
      const prev = todos.get(r.dni);
      if (!prev || (r.domicilio && !prev.domicilio)) todos.set(r.dni, r);
      n++;
    }
  }
  console.log('  ' + p.sexo + ': paginas=' + paginas.length + ' registros=' + n + ' unicos_acum=' + todos.size);
}

const filas = [];
for (const r of todos.values()) {
  filas.push({ dni: r.dni, campo: 'nombreCompleto', valor: r.nombreCompleto });
  if (r.domicilio) filas.push({ dni: r.dni, campo: 'domicilio', valor: r.domicilio });
  if (r.ciudad) filas.push({ dni: r.dni, campo: 'ciudad', valor: r.ciudad });
  filas.push({ dni: r.dni, campo: 'provincia', valor: 'CHACO' });
  filas.push({ dni: r.dni, campo: 'sexo', valor: r.sexo });
  if (r.anioNac) filas.push({ dni: r.dni, campo: 'anioNac', valor: r.anioNac, precision: 'anio' });
}
console.log('filas=' + filas.length + ' dnis=' + todos.size);
if (DRY) {
  console.log('muestra:', JSON.stringify([...todos.values()].slice(0, 5), null, 2));
  process.exit(0);
}

const r = fuentes.guardar(filas, { fuente: FUENTE, archivo: 'idach_2017_m_f.pdf', lote: FUENTE + '-2017' });
console.log('OK fuente=' + r.fuente + ' lote=' + r.lote + ' filas=' + r.ok);

const db = new DatabaseSync(RUTA_DB);
const total = db.prepare('SELECT COUNT(*) n FROM fuentes_personas WHERE fuente = ?').get(FUENTE).n;
const dnis = db.prepare('SELECT COUNT(DISTINCT dni) n FROM fuentes_personas WHERE fuente = ?').get(FUENTE).n;
const cruzables = db.prepare('SELECT COUNT(*) n FROM (SELECT DISTINCT dni FROM fuentes_personas WHERE fuente = ?) f JOIN personas p ON p.dni = f.dni').get(FUENTE).n;
const conDomicilio = db.prepare("SELECT COUNT(*) n FROM fuentes_personas WHERE fuente = ? AND campo = 'domicilio'").get(FUENTE).n;
const conAnio = db.prepare("SELECT COUNT(*) n FROM fuentes_personas WHERE fuente = ? AND campo = 'anioNac'").get(FUENTE).n;
db.close();
console.log('MEDICION: filas=' + total + ' dnis=' + dnis + ' cruzables_con_personas=' + cruzables + ' con_domicilio=' + conDomicilio + ' con_anio=' + conAnio);
console.log('cobertura_sobre_personas=' + (100 * cruzables / 5664575).toFixed(4) + '%');
console.log('FIN');
