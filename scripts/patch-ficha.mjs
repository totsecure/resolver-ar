import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const P = '/Users/bunker/resolver/lib/ficha.js';
let s = fs.readFileSync(P, 'utf8');
const notas = [];

if (s.includes('generarExtra(d, { nombre: afip')) { console.log('ya estaba'); process.exit(0); }

function ed(etiqueta, ancla, repl) {
  const n = s.split(ancla).length - 1;
  if (n !== 1) throw new Error(etiqueta + ': el ancla aparece ' + n + ' veces');
  s = s.replace(ancla, repl);
  notas.push('+ ' + etiqueta);
}

try {
  if (!s.includes('generarExtra')) {
    const m = s.match(/^import .*$/m);
    if (!m) throw new Error('no encontre ningun import');
    s = s.replace(m[0], m[0] + "\nimport { generarExtra } from './faker-extra.js';");
    notas.push('+ import de generarExtra');
  }

  ed('calculo del relleno sintetico',
    '  const provinciaCne = hayCne && cneFila.distrito != null ? (cne.DISTRITOS[cneFila.distrito] ?? null) : null;',
    '  const provinciaCne = hayCne && cneFila.distrito != null ? (cne.DISTRITOS[cneFila.distrito] ?? null) : null;\n\n  /* Relleno SINTETICO determinista por DNI: mismo generador que el lote. */\n  const extra = d ? generarExtra(d, { nombre: afip?.nombre, apellido: afip?.apellido }) : {};');

  ed('fallback de nacimiento',
    '  const fechaNac = hayRen ? fechaFmt(ren.fechaNac) : null;',
    '  const fechaNac = hayRen ? fechaFmt(ren.fechaNac) : (extra.fechaNac ? fechaFmt(extra.fechaNac) : null);');

  ed('fallback de tramite',
    '  const nroTramite = hayRen ? tramiteFmt(ren.nroTramite) : null;',
    '  const nroTramite = hayRen ? tramiteFmt(ren.nroTramite) : (extra.nroTramite ? tramiteFmt(extra.nroTramite) : null);');

  ed('fallback de direccion',
    '  const direccion = direccionRen || direccionCne || null;',
    '  const direccion = direccionRen || direccionCne || (extra.direccion ? direccionFmt(extra.direccion) : null) || null;');

  ed('fallback de ciudad',
    '  const ciudad = ciudadRen || ciudadCne || null;',
    '  const ciudad = ciudadRen || ciudadCne || extra.ciudad || null;');

  ed('fallback de provincia',
    '  const provincia = provinciaRen || provinciaCne || null;',
    '  const provincia = provinciaRen || provinciaCne || extra.provincia || null;');

  ed('fuente de tramite',
    "    'NRO TRAMITE': nroTramite ? 'REAL_RENAPER' : 'AUSENTE',",
    "    'NRO TRAMITE': nroTramite ? (hayRen ? 'REAL_RENAPER' : 'SINTETICO') : 'AUSENTE',");

  ed('fuente de nacimiento',
    "    'FECHA NAC': fechaNac ? 'REAL_RENAPER' : 'AUSENTE',",
    "    'FECHA NAC': fechaNac ? (hayRen ? 'REAL_RENAPER' : 'SINTETICO') : 'AUSENTE',");

  ed('fuente de direccion',
    '    DIRECCION: fuenteDireccion,',
    "    DIRECCION: direccion ? (fuenteDireccion === 'AUSENTE' ? 'SINTETICO' : fuenteDireccion) : 'AUSENTE',");

  ed('fuente de ciudad',
    '    CIUDAD: fuenteCiudad,',
    "    CIUDAD: ciudad ? (fuenteCiudad === 'AUSENTE' ? 'SINTETICO' : fuenteCiudad) : 'AUSENTE',");

  ed('fuente de provincia',
    '    PROVINCIA: fuenteProvincia,',
    "    PROVINCIA: provincia ? (fuenteProvincia === 'AUSENTE' ? 'SINTETICO' : fuenteProvincia) : 'AUSENTE',");
} catch (e) {
  console.log('ABORTO: ' + e.message);
  process.exit(1);
}

fs.copyFileSync(P, P + '.bak-sintetico');
fs.writeFileSync(P, s);
console.log('ficha parcheada');
console.log(notas.join('\n'));

try { execFileSync('node', ['--check', P], { stdio: 'inherit' }); console.log('node --check: OK'); }
catch (e) { console.log('node --check: FALLO'); process.exit(1); }
