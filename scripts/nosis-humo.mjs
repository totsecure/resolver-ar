/* nosis-humo.mjs — humo de lib/nosis.js.
 *
 *   node scripts/nosis-humo.mjs
 *
 * Verifica:
 *   1) busqueda real de DNI 30756789 (nombre/provincia/CUIT)
 *   2) informe del titular -> DOMICILIO/NACIMIENTO (requiere sesion; si el login
 *      falla lo reporta como AVISO, no como crash)
 *   3) un DNI sin CUIT en Nosis (77777777) devuelve vacio sin explotar
 *   4) segunda corrida sale de cache: 0 requests al Worker
 */
import * as nosis from '../lib/nosis.js';

const DNI_OK = '30756789';
const DNI_SIN_CUIT = '77777777';

let llamadas = 0;
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (...args) => {
  llamadas += 1;
  return fetchOriginal(...args);
};

const OK = [];
const FAIL = [];
const AVISO = [];
const ok = (t, d = '') => { OK.push(t); console.log('  OK    ' + t + (d ? ' :: ' + d : '')); };
const fail = (t, d = '') => { FAIL.push(t); console.log('  FAIL  ' + t + (d ? ' :: ' + d : '')); };
const aviso = (t, d = '') => { AVISO.push(t); console.log('  AVISO ' + t + (d ? ' :: ' + d : '')); };

console.log('HUMO nosis — ' + new Date().toISOString());

/* El informe de este DNI se pide a la red solo si hay sesion. */
nosis.asegurar();

/* 1) Busqueda (forzada a red) */
console.log('\n1. busqueda DNI ' + DNI_OK);
const t0 = Date.now();
const json = await nosis.consultar(DNI_OK, { forzar: true });
const msRed = Date.now() - t0;
const ent = nosis.interpretarNosis(json);
const reqRed = llamadas;
if (ent && ent.cuit && ent.dni === DNI_OK && ent.razonSocial) {
  ok('busqueda', ent.razonSocial + ' | ' + ent.cuit + ' | ' + (ent.provincia || '-') + ' | ' + msRed + 'ms');
} else {
  fail('busqueda', JSON.stringify(json).slice(0, 240));
}
if (reqRed >= 1) ok('busqueda salio a la red', 'requests=' + reqRed);
else fail('busqueda no hizo request', 'requests=0');

/* 2) Informe (necesita sesion) */
console.log('\n2. informe CUIT ' + (ent ? ent.cuit : '-'));
let datos = {};
if (ent && ent.cuit) {
  const antes = llamadas;
  const html = await nosis.informe(ent.cuit, { forzar: true });
  if (html) {
    const p = nosis.parsearInforme(html);
    datos = p;
    const tiene = Boolean(p.domicilio || p.fechaNac || p.ciudad || p.provincia);
    if (tiene) ok('informe', 'domicilio=' + (p.domicilio || '-') + ' | nacimiento=' + (p.fechaNac || '-') + ' | ' + (p.ciudad || '-') + '/' + (p.provincia || '-'));
    else aviso('informe sin campos reconocibles', 'bytes=' + html.length);
    console.log('  requests del informe=' + (llamadas - antes));
  } else {
    aviso('informe no disponible (login Nosis)', 'no se pudo obtener sesion; ver T1');
  }
}

/* 3) Extraccion del DNI desde el CUIT (nunca usar Documento crudo) */
console.log('\n3. extraerDni');
if (nosis.extraerDni('20-30756789-0') === DNI_OK && nosis.extraerDni('20307567890') === DNI_OK) {
  ok('extraerDni', '20-30756789-0 -> ' + DNI_OK);
} else {
  fail('extraerDni', nosis.extraerDni('20-30756789-0'));
}

/* 4) DNI sin CUIT: vacio y sin explotar */
console.log('\n4. DNI sin CUIT ' + DNI_SIN_CUIT);
let sin = null;
try {
  const j = await nosis.consultar(DNI_SIN_CUIT, { forzar: true });
  sin = nosis.interpretarNosis(j);
  if (!sin) ok('sin CUIT devuelve vacio', 'EntidadesEncontradas=0');
  else aviso('el DNI ' + DNI_SIN_CUIT + ' tiene entidad', JSON.stringify(sin).slice(0, 160));
  const d = await nosis.datosDeDni(DNI_SIN_CUIT, { red: true });
  if (!d || !d.fuente) ok('datosDeDni sin CUIT no explota', '{}');
  else fail('datosDeDni sin CUIT devolvio datos', JSON.stringify(d).slice(0, 160));
} catch (e) {
  fail('sin CUIT lanzo excepcion', String(e && e.message));
}

/* 5) Cache: la segunda corrida no debe hacer NINGUN request */
console.log('\n5. cache');
const antesCache = llamadas;
const t1 = Date.now();
const j2 = await nosis.consultar(DNI_OK);
const msCache = Date.now() - t1;
const reqCache = llamadas - antesCache;
if (reqCache === 0) ok('busqueda desde cache', 'requests=0 ' + msCache + 'ms');
else fail('busqueda fue a la red', 'requests=' + reqCache);
if (JSON.stringify(j2) === JSON.stringify(json)) ok('cache devuelve el mismo JSON');
else fail('cache devuelve otro JSON');

if (ent && ent.cuit) {
  const antesInf = llamadas;
  const h2 = await nosis.informe(ent.cuit);
  const reqInf = llamadas - antesInf;
  if (h2) {
    if (reqInf === 0) ok('informe desde cache', 'requests=0');
    else fail('informe fue a la red', 'requests=' + reqInf);
  } else if (reqInf === 0) {
    ok('sin informe en cache: 0 requests', 'lo cachea solo cuando el login funcione');
  }
}

console.log('\nRESUMEN: ' + OK.length + ' OK / ' + FAIL.length + ' FAIL / ' + AVISO.length + ' AVISO');
if (AVISO.length) console.log('AVISOS: ' + AVISO.join(' | '));
process.exit(FAIL.length ? 1 : 0);
