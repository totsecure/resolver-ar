/* cobertura-nosis.mjs — P8: qué porcentaje del padrón aparece en Nosis búsqueda.
 *
 *   node scripts/cobertura-nosis.mjs [n]
 *
 * Muestra aleatoria de DNIs de personas; consulta /Home/Buscar (público, sin
 * sesión) y mide cuántos tienen al menos una entidad (gente con CUIT).
 * Guarda progreso en /tmp/cobertura-nosis.json. Si Nosis pide captcha, corta
 * y reporta lo medido hasta ahí.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as nosis from '../lib/nosis.js';

const N = Math.max(1, Number(process.argv[2] || 1000));
const DELAY = Number((process.argv.find((a) => a.startsWith('--delay=')) || '').split('=')[1] || process.env.NOSIS_DELAY_MS || 3000);
const ESPERA = Number((process.argv.find((a) => a.startsWith('--espera=')) || '').split('=')[1] || 120000);
const RUTA_DB = process.env.RESOLVER_DB || '/Users/bunker/resolver/datos/padron.db';
const SALIDA = '/tmp/cobertura-nosis.json';
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new DatabaseSync(RUTA_DB);
const dnis = db.prepare(`SELECT DISTINCT dni FROM personas
  WHERE dni IS NOT NULL AND length(dni) = 8 AND dni GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
  ORDER BY RANDOM() LIMIT ?`).all(N).map((r) => r.dni);
db.close();

console.log('COBERTURA NOSIS — ' + new Date().toISOString());
console.log('muestra=' + dnis.length + ' (pedidas ' + N + ')');

const res = { fecha: new Date().toISOString(), pedidas: N, muestra: dnis.length, procesadas: 0, con: 0, sin: 0, error: 0, captcha: false, motivos: {}, ultimos: [] };
const guardar = () => { try { fs.writeFileSync(SALIDA, JSON.stringify(res, null, 2)); } catch (_) {} };

for (let i = 0; i < dnis.length; i++) {
  const dni = dnis[i];
  let j = null;
  let captchas = 0;
  while (captchas < 6) {
    try { j = await nosis.consultar(dni); } catch (_) { j = null; }
    if (j && j.ExigirCaptcha) {
      captchas++;
      res.captcha_intentos = (res.captcha_intentos || 0) + 1;
      console.log('  captcha en ' + dni + '; esperando ' + Math.round(ESPERA / 1000) + 's (intento ' + captchas + ')');
      await dormir(ESPERA);
      nosis.resetCaptcha();
      continue;
    }
    break;
  }
  if (!j || j.ExigirCaptcha) { res.captcha = true; res.motivos.captcha = (res.motivos.captcha || 0) + 1; break; }
  const ent = nosis.interpretarNosis(j);
  if (ent) {
    res.con++;
    if (res.ultimos.length < 20) res.ultimos.push({ dni, cuit: ent.cuit, nombre: ent.razonSocial });
  } else if (j && j.HayError) {
    res.error++;
    const m = j.motivo || 'HayError';
    res.motivos[m] = (res.motivos[m] || 0) + 1;
  } else {
    res.sin++;
  }
  res.procesadas++;
  if ((i + 1) % 50 === 0 || i === dnis.length - 1) {
    guardar();
    const pct = res.procesadas ? (100 * res.con / res.procesadas).toFixed(2) : '0';
    console.log('  ' + res.procesadas + '/' + dnis.length + ' con=' + res.con + ' sin=' + res.sin + ' error=' + res.error + ' => ' + pct + '%');
  }
  await dormir(DELAY);
}
guardar();
const pct = res.procesadas ? (100 * res.con / res.procesadas).toFixed(2) : '0';
console.log('\nRESULTADO: con=' + res.con + ' sin=' + res.sin + ' error=' + res.error + ' procesadas=' + res.procesadas + ' => ' + pct + '%');
if (res.captcha) console.log('CORTADO: Nosis pidió captcha');
console.log('guardado ' + SALIDA);
