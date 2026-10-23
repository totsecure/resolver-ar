/* importar-fuente.mjs — cargador generico de padrones/fuentes publicas.
 *
 *   node scripts/importar-fuente.mjs --archivo padron.csv --fuente PADRON_CHACO \
 *     --mapa dni=DNI,apellido=APELLIDO,nombre=NOMBRE,anioNac="AÑO NAC",domicilio=DOMICILIO
 *
 *   --dry                 no escribe, solo cuenta y muestra
 *   --sep ,               fuerza separador (, ; tab |)
 *   --sin-cabecera        la primera fila es dato; el mapa usa indices 0,1,2...
 *   --lote nombre         identificador de lote (default fuente-fecha)
 *
 * Idempotente: (dni, campo, fuente) es unico. Se puede recargar el mismo archivo.
 * Nunca aborta el archivo entero por una fila: informa invalidas/sin DNI.
 *
 * Fuentes sugeridas: PADRON_<PROV>, AFIP_CONSTANCIA, RENABAP, CNE, etc.
 * Campos validos: dni, apellido, nombre, nombreCompleto, fechaNac, anioNac,
 * domicilio, ciudad, provincia, cpostal, sexo, cuit, nroTramite, telefono, mail.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as fuentes from '../lib/fuentes-datos.js';

function arg(nombre, def = null) {
  const i = process.argv.indexOf('--' + nombre);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const DRY = process.argv.includes('--dry');
const SIN_CABECERA = process.argv.includes('--sin-cabecera');
const ARCHIVO = arg('archivo');
const FUENTE = arg('fuente');
const LOTE = arg('lote', null);
const SEP_FORZADO = arg('sep', null);
const MAPA_ARG = arg('mapa', null);

if (!ARCHIVO || !FUENTE) {
  console.error('Uso: node scripts/importar-fuente.mjs --archivo <csv> --fuente <NOMBRE> --mapa dni=DNI,apellido=APELLIDO,...');
  process.exit(2);
}
if (!MAPA_ARG) {
  console.error('Falta --mapa (ej: dni=DNI,apellido=APELLIDO,nombre=NOMBRE)');
  process.exit(2);
}

const norm = (s) => String(s || '').trim().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/* Mapa: "campo=COLUMNA,campo2=COLUMNA2" o JSON. */
function parseMapa(txt) {
  const out = {};
  const t = String(txt).trim();
  if (t.startsWith('{')) {
    const j = JSON.parse(t);
    for (const [campo, col] of Object.entries(j)) out[campo] = String(col);
    return out;
  }
  for (const par of t.split(',')) {
    const i = par.indexOf('=');
    if (i < 1) throw new Error('mapa invalido: ' + par);
    out[par.slice(0, i).trim()] = par.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/* Parser CSV con comillas dobles. */
function parsearLinea(linea, sep) {
  const out = [];
  let actual = '';
  let enComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (enComillas) {
      if (c === '"' && linea[i + 1] === '"') { actual += '"'; i++; }
      else if (c === '"') enComillas = false;
      else actual += c;
    } else if (c === '"') enComillas = true;
    else if (c === sep) { out.push(actual); actual = ''; }
    else actual += c;
  }
  out.push(actual);
  return out.map((x) => x.trim());
}

function detectarSep(linea) {
  const cands = ['\t', ';', '|', ','];
  let mejor = ',';
  let max = -1;
  for (const s of cands) {
    const n = linea.split(s).length - 1;
    if (n > max) { max = n; mejor = s; }
  }
  return max > 0 ? mejor : /\s{2,}/.test(linea) ? '  ' : ' ';
}

const texto = fs.readFileSync(path.resolve(String(ARCHIVO)), 'utf8').replace(/^\uFEFF/, '');
const lineas = texto.split(/\r?\n/).filter((l) => l.trim() !== '');
if (!lineas.length) { console.error('archivo vacio'); process.exit(2); }
const sep = SEP_FORZADO ? (SEP_FORZADO === '\\t' ? '\t' : String(SEP_FORZADO)) : detectarSep(lineas[0]);
const mapa = parseMapa(MAPA_ARG);

const camposMapa = Object.entries(mapa).map(([campo, col]) => ({ campo: String(campo).trim(), col: String(col).trim() }));
const invalidos = camposMapa.filter((m) => !fuentes.CAMPOS.includes(m.campo));
if (invalidos.length) {
  console.error('campos desconocidos: ' + invalidos.map((m) => m.campo).join(', '));
  console.error('validos: ' + fuentes.CAMPOS.join(', '));
  process.exit(2);
}

let cabecera = null;
let idx = {};
if (!SIN_CABECERA) {
  cabecera = parsearLinea(lineas[0], sep).map(norm);
  for (const m of camposMapa) {
    const buscado = norm(m.col);
    const i = cabecera.indexOf(buscado);
    if (i < 0) {
      console.error('columna no encontrada: "' + m.col + '" para ' + m.campo);
      console.error('cabecera detectada: ' + cabecera.join(', '));
      process.exit(2);
    }
    idx[m.campo] = i;
  }
} else {
  for (const m of camposMapa) idx[m.campo] = Number(m.col);
}

const filas = [];
let saltadas = 0;
for (let n = SIN_CABECERA ? 0 : 1; n < lineas.length; n++) {
  const cols = parsearLinea(lineas[n], sep);
  const fila = {};
  for (const [campo, i] of Object.entries(idx)) {
    const valor = fuentes.normalizarCampo(campo, cols[i]);
    if (valor != null) fila[campo] = valor;
  }
  if (!fila.dni) { saltadas++; continue; }
  for (const [campo, valor] of Object.entries(fila)) {
    if (campo === 'dni') continue;
    filas.push({ dni: fila.dni, campo, valor });
  }
}

const conteo = {};
for (const f of filas) conteo[f.campo] = (conteo[f.campo] || 0) + 1;
console.log('archivo=' + path.basename(String(ARCHIVO)) + '  fuente=' + FUENTE + '  sep=' + JSON.stringify(sep));
console.log('lineas=' + lineas.length + '  datos=' + (lineas.length - (SIN_CABECERA ? 0 : 1)) + '  con_dni=' + (lineas.length - (SIN_CABECERA ? 0 : 1) - saltadas) + '  sin_dni=' + saltadas);
console.log('campos: ' + Object.entries(conteo).map(([c, n]) => c + '=' + n).join(' '));
if (filas.length) console.log('muestra: ' + JSON.stringify(filas.slice(0, 6)));

const r = fuentes.guardar(filas, { fuente: FUENTE, lote: LOTE || undefined, archivo: path.basename(String(ARCHIVO)), dry: DRY });
console.log((DRY ? 'DRY ' : 'OK  ') + 'fuente=' + r.fuente + ' lote=' + r.lote + ' filas=' + r.total + ' ok=' + r.ok + ' invalidas=' + r.invalidas + ' sin_dni=' + r.sinDni);
if (DRY) process.exit(0);
const st = fuentes.stats();
console.log('total_fuentes_personas=' + st.total + ' dnis=' + st.dnis);
console.log('FIN');
