/* diag-join-idach.mjs — A5: verificar el join del padrón IDACH contra personas.
 *
 *   node scripts/diag-join-idach.mjs [n]
 *
 * Toma n DNIs al azar de fuentes_personas (PADRON_IDACH_CHACO) y prueba
 * candidatos contra el índice de personas.dni:
 *   - tal cual
 *   - sin ceros a la izquierda
 *   - con ceros a 8
 *   - como entero (string sin ceros)
 *   - como texto (mismo que tal cual)
 * No usa CAST(p.dni) porque escanea 5,6 M de filas.
 */
import { DatabaseSync } from 'node:sqlite';

const DB = process.env.RESOLVER_DB || '/Volumes/Boveda/resolver/datos/padron.db';
const FUENTE = 'PADRON_IDACH_CHACO';
const N = Math.max(1, Number(process.argv[2] || 50));
const d = new DatabaseSync(DB);

const muestra = d.prepare('SELECT DISTINCT dni FROM fuentes_personas WHERE fuente = ? ORDER BY RANDOM() LIMIT ?').all(FUENTE, N).map((r) => r.dni);
console.log('DIAG JOIN IDACH — ' + new Date().toISOString());
console.log('muestra=' + muestra.length + ' fuente=' + FUENTE);

const buscar = d.prepare('SELECT dni FROM personas WHERE dni = ? LIMIT 1');
const variantes = ['tal_cual', 'sin_ceros', 'con_ceros_8', 'como_entero', 'como_texto'];
const conteo = Object.fromEntries(variantes.map((v) => [v, 0]));
const detalle = [];

for (const dni of muestra) {
  const sin = String(dni).replace(/^0+/, '');
  const pad = String(dni).padStart(8, '0');
  const num = String(Number(dni));
  const candidatos = {
    tal_cual: [String(dni)],
    sin_ceros: [sin],
    con_ceros_8: [pad],
    como_entero: [num],
    como_texto: [String(dni)],
  };
  const fila = { dni, match: {} };
  for (const v of variantes) {
    for (const c of candidatos[v]) {
      const r = buscar.get(c);
      if (r) { conteo[v]++; fila.match[v] = r.dni; break; }
    }
  }
  detalle.push(fila);
}

console.log('\nVARIANTE                     MATCH/50');
for (const v of variantes) console.log(v.padEnd(28) + conteo[v] + '/' + muestra.length);
console.log('\nDETALLE (los que matchean por alguna variante):');
for (const f of detalle) {
  const m = Object.entries(f.match).map(([k, v]) => k + '->' + v);
  if (m.length) console.log('  ' + f.dni + ' :: ' + m.join(', '));
}
const sinNada = detalle.filter((f) => !Object.keys(f.match).length).length;
console.log('  sin match en ninguna variante: ' + sinNada + '/' + muestra.length);

/* Totales sobre todo el padrón, sin CAST sobre personas. */
const total = d.prepare('SELECT COUNT(DISTINCT dni) n FROM fuentes_personas WHERE fuente = ?').get(FUENTE).n;
const totales = {
  'join_actual (texto)': 'SELECT COUNT(*) n FROM (SELECT DISTINCT dni FROM fuentes_personas WHERE fuente = ?) f JOIN personas p ON p.dni = f.dni',
  'join_sin_ceros': "SELECT COUNT(*) n FROM (SELECT DISTINCT dni FROM fuentes_personas WHERE fuente = ?) f JOIN personas p ON p.dni = ltrim(f.dni, '0')",
  'join_con_ceros_8': 'SELECT COUNT(*) n FROM (SELECT DISTINCT dni FROM fuentes_personas WHERE fuente = ?) f JOIN personas p ON p.dni = printf(\'%08d\', CAST(f.dni AS INTEGER))',
};
console.log('\nTOTAL PADRÓN (' + total + ' DNIs):');
for (const [k, sql] of Object.entries(totales)) {
  const n = d.prepare(sql).get(FUENTE).n;
  console.log('  ' + k.padEnd(24) + n + '  (' + (100 * n / total).toFixed(2) + '%)');
}

/* Muestra de largos de personas (sin escanear 5,6 M). */
console.log('\nLARGOS DE dni EN personas (muestra de 200.000):');
const largos = d.prepare('SELECT length(dni) l, COUNT(*) n FROM (SELECT dni FROM personas LIMIT 200000) GROUP BY 1 ORDER BY 1').all();
for (const r of largos) console.log('  len=' + r.l + ' n=' + r.n);
d.close();
