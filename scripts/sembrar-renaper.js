/* sembrar-renaper.js - carga datos REALES a mano en la cache.
 * Uso: node scripts/sembrar-renaper.js
 * Agregar entradas al objeto DATOS (copiadas de RENAPER).
 */
import * as renaper from '../lib/renaper.js';

const DATOS = {
  '30756789': {
    fechaNac: '25/04/1984',
    nroTramite: '00744230016',
    direccion: 'CONDE 1526 PISO 5 DEPTO J',
    ciudad: 'COLEGIALES',
    provincia: 'CIUDAD DE BUENOS AIRES',
    cpostal: '1426',
  },
};

let n = 0;
for (const [dni, d] of Object.entries(DATOS)) {
  const r = renaper.guardar(dni, d, { fuente: 'TEXTO_REFERENCIA', crudo: { fuente: 'manual', dni: dni } });
  console.log(dni, r ? 'ok' : 'error');
  n += 1;
}
console.log('sembrados', n);
