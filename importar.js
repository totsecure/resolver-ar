import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { cuitValido, separarNombre, normalizarDni } from './lib/validar.js';

const RUTA = process.argv[2];
if (!RUTA) { console.error('uso: node importar.js <archivo>'); process.exit(1); }

const DIR = path.join(import.meta.dirname, 'datos');
fs.mkdirSync(DIR, { recursive: true });
const db = new DatabaseSync(path.join(DIR, 'padron.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('DROP TABLE IF EXISTS personas');
db.exec(`CREATE TABLE personas (
  cuit TEXT PRIMARY KEY, dni TEXT, apellido TEXT, nombre TEXT, denominacion TEXT,
  sucesion INTEGER, ganancias TEXT, iva TEXT, monotributo TEXT,
  integrante_soc TEXT, empleador TEXT, actividad TEXT)`);
db.exec('CREATE INDEX idx_dni ON personas(dni)');

const ins = db.prepare('INSERT INTO personas VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
const PREF = new Set(['20','23','24','27']);

let leidas = 0, guardadas = 0, lote = 0;
let juridicas = 0, invalidas = 0, sinDenom = 0, largas = 0;

db.exec('BEGIN');
const rl = readline.createInterface({ input: fs.createReadStream(RUTA, { encoding: 'latin1' }), crlfDelay: Infinity });

for await (const linea of rl) {
  leidas++;
  if (linea.length !== 51) largas++;
  if (linea.length < 41) { invalidas++; continue; }

  const cuit = linea.slice(0, 11);
  if (!PREF.has(cuit.slice(0, 2))) { juridicas++; continue; }
  if (!cuitValido(cuit)) { invalidas++; continue; }

  const denom = linea.slice(11, 41).replace(/\x00/g, '').trim();
  if (!denom) { sinDenom++; continue; }

  const dni = normalizarDni(cuit.slice(2, 10));
  if (!dni) { invalidas++; continue; }

  const s = separarNombre(denom);
  ins.run(cuit, dni, s.apellido, s.nombre, denom, s.sucesion ? 1 : 0,
    linea.slice(41,43), linea.slice(43,45), linea.slice(45,47),
    linea.slice(47,48), linea.slice(48,49), linea.slice(49,51));

  guardadas++; lote++;
  if (lote >= 20000) { db.exec('COMMIT'); db.exec('BEGIN'); lote = 0; }
  if (leidas % 1000000 === 0) console.log(leidas + ' leidas / ' + guardadas + ' guardadas');
}
db.exec('COMMIT');

console.log('LISTO: ' + guardadas + ' fisicas | ' + juridicas + ' juridicas | ' +
  invalidas + ' invalidas | ' + sinDenom + ' sin denominacion | ' + largas + ' con largo != 51');

const pref = db.prepare('SELECT substr(cuit,1,2) p, COUNT(*) n FROM personas GROUP BY p ORDER BY n DESC').all();
console.log('prefijos en DB (solo fisicas):', pref.map(r => r.p + '=' + r.n).join(' '));

if (invalidas > 0) { console.error('FALLA: ' + invalidas + ' lineas de persona fisica invalidas'); process.exitCode = 1; }
if (largas > 0)    { console.error('FALLA: ' + largas + ' lineas con largo != 51'); process.exitCode = 1; }
