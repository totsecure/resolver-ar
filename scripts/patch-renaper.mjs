import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const P = '/Volumes/Boveda/resolver/lib/renaper.js';
let s = fs.readFileSync(P, 'utf8');
const notas = [];

if (s.includes('apirnpr.onrender.com')) { console.log('ya estaba'); process.exit(0); }

function ed(etiqueta, ancla, repl) {
  const n = s.split(ancla).length - 1;
  if (n !== 1) throw new Error(etiqueta + ': el ancla aparece ' + n + ' veces');
  s = s.replace(ancla, repl);
  notas.push('+ ' + etiqueta);
}

try {
  ed('host correcto',
    "export const BASE = process.env.RENAPER_BASE || 'https://renaperservice.onrender.com';",
    "export const BASE = process.env.RENAPER_BASE || 'https://apirnpr.onrender.com';");

  ed('path correcto',
    "const CAMINO = process.env.RENAPER_PATH || '/api/personas/{dni}?genero={genero}';",
    "const CAMINO = process.env.RENAPER_PATH || '/renaper/{dni}/{genero}';");

  ed('desenvuelve respuesta + error por codigoError', `  if (!j || typeof j !== 'object') return vacio;

  const errorFlag = j.error === true
    || (typeof j.error === 'string' && j.error !== '' && j.error.toLowerCase() !== 'false');
  const motivoError = texto(j.descripcionError)
    || texto(j.message)
    || texto(j.mensaje)
    || (typeof j.error === 'string' ? texto(j.error) : null)
    || (errorFlag ? 'error del servicio' : null);
  if (motivoError) return { ...vacio, motivo: motivoError };

  const dom = j.domicilio;
  const calle = (dom && typeof dom === 'object') ? texto(dom.calle) : null;
  const numero = (dom && typeof dom === 'object') ? texto(dom.numero) : null;`, `  if (!j || typeof j !== 'object') return vacio;

  /* Formato nuevo: la data viene envuelta en respuesta. */
  if (j.respuesta && typeof j.respuesta === 'object') {
    const env = j;
    j = Object.assign({}, env.respuesta);
    if (j.error === undefined) j.error = env.error;
    if (j.mensaje === undefined) j.mensaje = env.mensaje;
  }

  const cod = Number(j.codigoError);
  const errorFlag = j.error === true
    || (typeof j.error === 'string' && j.error !== '' && j.error.toLowerCase() !== 'false');
  /* descripcionError viene SIEMPRE ('DNI/PAS Firmado'): solo es error si codigoError != 200. */
  const motivoError = (Number.isFinite(cod) && cod !== 200 ? (texto(j.descripcionError) || 'codigoError ' + cod) : null)
    || (errorFlag ? (texto(j.mensaje) || texto(j.message) || 'error del servicio') : null);
  if (motivoError) return { ...vacio, motivo: motivoError };

  const dom = (j.domicilio && typeof j.domicilio === 'object') ? j.domicilio : null;
  const calle = (dom ? texto(dom.calle) : null) || texto(j.calle);
  const numero = (dom ? texto(dom.numero) : null) || texto(j.numeroCalle);`);

  ed('tramite ignora el 0',
    "    nroTramite: texto(j.idTramitePrincipal ?? j.nroTramite),",
    "    nroTramite: texto(j.nroTramite) || (Number(j.idTramitePrincipal) > 0 ? String(j.idTramitePrincipal) : null),");

  ed('direccion tambien con calle plana',
    "    direccion: componerDireccion(dom),",
    "    direccion: componerDireccion(dom) || (calle ? [calle, numero].filter(Boolean).join(' ') : null),");

  ed('ciudad plana',
    "    ciudad: (dom && typeof dom === 'object') ? texto(dom.localidad) : null,",
    "    ciudad: (dom ? texto(dom.localidad) : null) || texto(j.ciudad) || texto(j.municipio),");

  ed('provincia plana',
    "    provincia: (dom && typeof dom === 'object') ? texto(dom.provincia) : null,",
    "    provincia: (dom ? texto(dom.provincia) : null) || texto(j.provincia),");

  ed('cpostal plano',
    "    cpostal: (dom && typeof dom === 'object') ? texto(dom.codigoPostal) : null,",
    "    cpostal: (dom ? texto(dom.codigoPostal) : null) || texto(j.cpostal),");

  ed('TTL del cache negativo configurable',
    '        ttlDias: 30,',
    "        ttlDias: Number(process.env.RENAPER_TTL_AUSENTE_DIAS || 2),");
} catch (e) { console.log('ABORTO: ' + e.message); process.exit(1); }

fs.copyFileSync(P, P + '.bak-renaper');
fs.writeFileSync(P, s);
console.log('renaper parcheado');
console.log(notas.join('\n'));

try { execFileSync('node', ['--check', P], { stdio: 'inherit' }); console.log('node --check: OK'); }
catch (e) { console.log('node --check: FALLO'); process.exit(1); }
