/* generar-lote.js — arma un lote de tarjetas argentinas listo para cargar.
 *
 * Salida: pipe de 13 campos, el mismo formato que ya entiende
 * lib/stock.js::parsearEntradaFlexible:
 *   NUMERO|VENC|CVV|TITULAR|DNI|NACIMIENTO|MAIL|TELEFONO|DIRECCION|CIUDAD|PROVINCIA|SALDO_DISP|SALDO_TOTAL
 * El titular va vacio a proposito: la ficha lo saca del padron/RENAPER por DNI
 * al momento de entregar (igual que el LOTE DE OCTUBRE que ya anda).
 *
 * Los BIN son argentinos reales (datos/bins.db) y los DNI salen del padron,
 * asi que cada tarjeta queda con dueño real y BIN creible.
 *
 * uso: node scripts/generar-lote.js [--cantidad 500] [--visa 250] [--pool 10]
 *                                   [--desde 0] [--salida datos/lotes/x.txt]
 *
 * --pool N: cuantos BIN distintos reparte el lote (default 10, bancos grandes).
 * Con un pool chico el stock queda agrupado por banco y se puede pedir por BIN.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const RAIZ = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const opt = (nombre, def) => {
  const i = argv.indexOf('--' + nombre);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def;
};
const cantidad = Math.max(1, Number(opt('cantidad', 500)));
const visa = Math.min(cantidad, Math.max(0, Number(opt('visa', Math.round(cantidad / 2)))));
const desde = Math.max(0, Number(opt('desde', 0)));
const pool = Math.max(1, Number(opt('pool', 10)));
const salida = opt('salida', path.join('datos', 'lotes', 'ar-' + cantidad + '.txt'));

/* ---------- azar ---------- */
let semilla = Number(opt('semilla', 0)) || 20261104;
function rnd() {
  /* xorshift32: lote reproducible entre corridas con la misma semilla. */
  semilla ^= semilla << 13; semilla >>>= 0;
  semilla ^= semilla >> 17;
  semilla ^= semilla << 5; semilla >>>= 0;
  return semilla / 4294967296;
}
const entre = (a, b) => a + Math.floor(rnd() * (b - a + 1));

function luhn(numero) {
  let suma = 0, doble = false;
  for (let i = numero.length - 1; i >= 0; i--) {
    let n = Number(numero[i]);
    if (doble) { n *= 2; if (n > 9) n -= 9; }
    suma += n;
    doble = !doble;
  }
  return suma % 10 === 0;
}
function conDigitoVerificador(base15) {
  for (let d = 0; d <= 9; d++) {
    const n = base15 + d;
    if (luhn(n)) return n;
  }
  return base15 + '0';
}

/* ---------- BINs argentinos reales ---------- */
const binsDb = new DatabaseSync(path.join(RAIZ, 'datos', 'bins.db'));
const binsAr = binsDb
  .prepare("SELECT bin, marca, banco FROM bins WHERE pais = 'Argentina' AND bin GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]' AND marca IN ('Visa','Master')")
  .all();
const visaBins = binsAr.filter((b) => b.bin[0] === '4' && /^4(?!1{5})/.test(b.bin) && !/^0/.test(b.bin));
const mcBins = binsAr.filter((b) => /^[25]/.test(b.bin) && !/^(5555|5165)/.test(b.bin));
if (!visaBins.length || !mcBins.length) throw new Error('sin BINs argentinos en datos/bins.db');

/* ---------- pool de BINs: pocos BIN de bancos grandes ---------- */
const GRANDES = ['GALICIA', 'NACION', 'PROVINCIA', 'SANTANDER', 'BBVA', 'MACRO', 'CREDICOOP', 'CIUDAD',
  'ICBC', 'SUPERVIELLE', 'PATAGONIA', 'COMAFI', 'HSBC', 'FRANCES', 'ITAU', 'COLUMBIA'];
const revolver = (l) => {
  const c = l.slice();
  for (let i = c.length - 1; i > 0; i--) {
    const j = entre(0, i);
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c;
};
function acotar(lista, n) {
  if (n >= lista.length) return lista;
  const grandes = revolver(lista.filter((b) => b.banco && GRANDES.some((g) => String(b.banco).toUpperCase().includes(g))));
  const resto = revolver(lista.filter((b) => !grandes.includes(b)));
  return grandes.concat(resto).slice(0, n);
}
const mitad = Math.max(1, Math.ceil(pool / 2));
const paletaVisa = acotar(visaBins, mitad);
const paletaMc = acotar(mcBins, mitad);

/* ---------- DNIs reales del padron ---------- */
const padron = new DatabaseSync(path.join(RAIZ, 'datos', 'padron.db'), { readOnly: true });
const personas = padron
  .prepare('SELECT dni FROM personas WHERE orden IS NOT NULL AND dni IS NOT NULL ORDER BY orden LIMIT ? OFFSET ?')
  .all(cantidad, desde);
padron.close();

/* ---------- saldos ---------- */
const miles = (n) => Math.round(n / 1000) * 1000;
function saldoDisp() {
  const r = rnd();
  if (r < 0.15) return miles(entre(150000, 800000));
  if (r < 0.75) return miles(entre(1000000, 9000000));
  if (r < 0.95) return miles(entre(10000000, 30000000));
  return miles(entre(30000000, 100000000));
}

/* ---------- numeros usados ---------- */
const stock = new DatabaseSync(path.join(RAIZ, 'datos', 'stock.db'), { readOnly: true });
const usados = new Set(stock.prepare('SELECT numero FROM cc').all().map((r) => r.numero));
stock.close();

/* ---------- lote ---------- */
const marcas = [];
for (let i = 0; i < cantidad; i++) marcas.push(i < visa ? 'visa' : 'master');

const lineas = [];
const stats = { visa: 0, master: 0, saldoTotal: 0, saldoMin: Infinity, saldoMax: 0 };
const porBin = new Map();
for (let i = 0; i < cantidad; i++) {
  const marca = marcas[i];
  const lista = marca === 'visa' ? paletaVisa : paletaMc;
  const elegido = lista[entre(0, lista.length - 1)];
  const bin = elegido.bin;
  let numero;
  do {
    const resto = String(entre(0, 999999999)).padStart(9, '0').slice(0, 15 - bin.length);
    numero = conDigitoVerificador(bin + resto);
  } while (usados.has(numero));
  usados.add(numero);

  const mes = String(entre(1, 12)).padStart(2, '0');
  const anio = String(entre(27, 32));
  const cvv = String(entre(100, 999));
  const disp = saldoDisp();
  const total = miles(disp * (1 + entre(5, 60) / 100));
  const dni = personas[i] ? personas[i].dni : String(entre(20000000, 46000000));

  /* NUMERO|VENC|CVV|TITULAR|DNI|NACIMIENTO|MAIL|TELEFONO|DIRECCION|CIUDAD|PROVINCIA|SALDO_DISP|SALDO_TOTAL */
  lineas.push([numero, mes + '/' + anio, cvv, '', dni, '', '', '', '', '', '', disp, total].join('|'));

  stats[marca] += 1;
  porBin.set(bin + ' ' + (elegido.banco || '') + ' ' + marca, (porBin.get(bin + ' ' + (elegido.banco || '') + ' ' + marca) || 0) + 1);
  stats.saldoTotal += disp;
  stats.saldoMin = Math.min(stats.saldoMin, disp);
  stats.saldoMax = Math.max(stats.saldoMax, disp);
}

const destino = path.resolve(RAIZ, salida);
fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.writeFileSync(destino, lineas.join('\n') + '\n');

const m = (n) => '$' + Math.round(n).toLocaleString('es-AR');
console.log('lote: ' + destino);
console.log('tarjetas: ' + cantidad + ' (' + stats.visa + ' visa / ' + stats.master + ' mastercard)');
console.log('saldos: min ' + m(stats.saldoMin) + ' | max ' + m(stats.saldoMax) + ' | suma ' + m(stats.saldoTotal));
console.log('lineas unicas: ' + new Set(lineas.map((l) => l.split('|')[0])).size);
for (const [k, n] of [...porBin].sort((a, b) => b[1] - a[1])) console.log('  ' + String(n).padStart(4) + '  ' + k);
