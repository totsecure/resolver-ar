import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const P = '/Users/bunker/resolver/lib/renaper.js';
let s = fs.readFileSync(P, 'utf8');
const notas = [];

if (s.includes('RENAPER_TTL_FALLA_DIAS')) { console.log('ya estaba'); process.exit(0); }

function ed(etiqueta, ancla, repl) {
  const n = s.split(ancla).length - 1;
  if (n !== 1) throw new Error(etiqueta + ': el ancla aparece ' + n + ' veces');
  s = s.replace(ancla, repl);
  notas.push('+ ' + etiqueta);
}

try {
  ed('provincia derivada del municipio (el servicio no la manda)',
    "    provincia: (dom ? texto(dom.provincia) : null) || texto(j.provincia),",
    "    provincia: (dom ? texto(dom.provincia) : null) || texto(j.provincia) || (texto(j.municipio) ? String(j.municipio).replace(/_+/g, ' ').replace(/ CAPITAL$/, '').trim() : null),");

  ed('cache corto para servicio caido',
    '  return ausente(r.motivo, r.http, enCache);',
    "  /* 200 con error adentro, o 5xx: cache corto para no colgar cada ficha\n   * mientras el servicio esta caido. */\n  if (r.http === 200 || (Number(r.http) >= 500)) {\n    try {\n      guardar(d, { fuente: 'AUSENTE' }, {\n        crudo: { error: r.motivo || 'falla' },\n        ttlDias: Number(process.env.RENAPER_TTL_FALLA_DIAS || 1),\n        fuente: 'AUSENTE',\n        genero: null,\n      });\n    } catch (_) {}\n  }\n  return ausente(r.motivo, r.http, enCache);");

  ed('timeout mas corto para no colgar el chat',
    "const TIMEOUT_MS = Number(process.env.RENAPER_TIMEOUT_MS || 60000);",
    "const TIMEOUT_MS = Number(process.env.RENAPER_TIMEOUT_MS || 25000);");
} catch (e) { console.log('ABORTO: ' + e.message); process.exit(1); }

fs.copyFileSync(P, P + '.bak-falla');
fs.writeFileSync(P, s);
console.log('renaper parcheado (2)');
console.log(notas.join('\n'));

try { execFileSync('node', ['--check', P], { stdio: 'inherit' }); console.log('node --check: OK'); }
catch (e) { console.log('node --check: FALLO'); process.exit(1); }
