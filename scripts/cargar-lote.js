/* cargar-lote.js — carga masiva de tarjetas al stock desde la terminal.
 *
 * Usa el MISMO camino que el panel (lib/carga-cc.js -> lib/stock.js::cargar),
 * asi que valen las mismas reglas: Luhn, largo, dedupe por huella/numero,
 * BIN derivado del numero y enriquecido con bininfo.
 *
 * Primero analiza (dry-run, no escribe) y muestra el resumen. Recien con --si
 * confirma e inserta. Por defecto publica directo: las tarjetas quedan
 * DISPONIBLE y salen a la venta. Con --revision quedan en REVISION.
 *
 * Formatos aceptados: bloques TARJETA #.../DATOS TARJETA, pipe de 11-13 campos
 * y los lotes viejos de 4-6 campos. Ver lib/stock.js::parsearEntradaFlexible.
 *
 * uso: node scripts/cargar-lote.js <archivo> [--nombre "LOTE X"] [--si] [--revision]
 */
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const archivo = argv.find((a) => !a.startsWith('--'));
if (!archivo) {
  console.error('uso: node scripts/cargar-lote.js <archivo> [--nombre "LOTE X"] [--si] [--revision]');
  process.exit(1);
}
const valor = (nombre) => {
  const i = argv.indexOf('--' + nombre);
  return i >= 0 ? argv[i + 1] : undefined;
};
const confirmarCarga = argv.includes('--si');
const revision = argv.includes('--revision');

process.env.RESOLVER_STOCK_DB = process.env.RESOLVER_STOCK_DB || path.join(RAIZ, 'datos', 'stock.db');
process.env.PUBLICAR_DIRECTO = revision ? '0' : '1';

const ruta = path.resolve(archivo);
const texto = fs.readFileSync(ruta, 'utf8');
const nombre = valor('nombre') || path.basename(ruta).replace(/\.[^.]+$/, '');

const { analizar, confirmar } = await import('../lib/carga-cc.js');

const resumen = (r) => {
  console.log('  lineas leidas: ' + r.total);
  console.log('  validas nuevas: ' + r.nuevas);
  console.log('  duplicadas: ' + r.duplicadas.length);
  console.log('  invalidas: ' + r.invalidas.length);
  const motivos = {};
  for (const x of r.invalidas) motivos[x.motivo] = (motivos[x.motivo] || 0) + 1;
  for (const [m, n] of Object.entries(motivos)) console.log('    - ' + m + ': ' + n);
  for (const d of r.duplicadas.slice(0, 5)) console.log('    dup ' + d.numero_mask + ' (' + (d.motivo || '') + ')');
};

console.log('analizando ' + ruta + ' como "' + nombre + '"' + (revision ? ' (a REVISION)' : ''));
const dry = analizar(texto, { nombre, archivo: path.basename(ruta) });
resumen(dry);
if (!dry.nuevas) { console.log('nada para cargar.'); process.exit(0); }
if (!confirmarCarga) { console.log('\ndry-run. Volve a correr con --si para confirmar.'); process.exit(0); }

console.log('\nconfirmando...');
const res = await confirmar(texto, { nombre, archivo: path.basename(ruta) });
resumen(res);
console.log('lote_id: ' + res.lote_id + ' | estado: ' + res.estado);
console.log('BINs nuevos enriquecidos: ' + (res.binsEnriquecidos || 0));
console.log('LISTO: ' + res.nuevas + ' tarjetas cargadas');
