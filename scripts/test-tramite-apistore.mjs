/* test-tramite-apistore.mjs — P2: ¿el id_tramite_principal sirve como trámite?
 *
 *   node scripts/test-tramite-apistore.mjs \
 *     --dnis=30756789,38418216 \
 *     --tramites=30756789:00744230016,38418216:00000000000
 *
 * Requiere credenciales de apistore en datos/server.env:
 *   APISTORE_USER=...   APISTORE_PASS=...
 *
 * Flujo real (documentado en https://apistore.pcnt.io):
 *   POST /v1/login/jwt {username,password} -> {token}
 *   GET  /v1/information/person-renaper/{dni}/gender/{M|F}
 *        -> id_tramite_principal (9 digitos), fecha_nacimiento, domicilio...
 *   POST /v1/information/barcode (foto DNI) -> procedure_number (11 digitos)
 *
 * Veredicto: compara padStart(11,'0') del id contra el trámite conocido.
 * Si no hay credenciales, sale 2 con BLOQUEADO.
 */
import fs from 'node:fs';

const ENV = '/Users/bunker/resolver/datos/server.env';
const env = (() => {
  const out = {};
  try {
    for (const l of fs.readFileSync(ENV, 'utf8').split('\n')) {
      const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return out;
})();
const val = (k) => process.env[k] || env[k] || '';
const arg = (k, def = '') => {
  const p = process.argv.find((a) => a.startsWith('--' + k + '='));
  return p ? p.split('=').slice(1).join('=') : def;
};

const USER = val('APISTORE_USER') || val('PERSONA_API_USER');
const PASS = val('APISTORE_PASS') || val('PERSONA_API_PASS');
const BASE = (val('APISTORE_URL') || 'https://apistore.pcnt.io').replace(/\/+$/, '');
const DNIS = arg('dnis', '30756789,38418216').split(',').map((s) => s.trim()).filter(Boolean);
const TRAMITES = Object.fromEntries(arg('tramites', '').split(',').filter(Boolean).map((p) => {
  const [d, t] = p.split(':');
  return [d.trim(), String(t || '').replace(/\D/g, '')];
}));

if (!USER || !PASS) {
  console.log('BLOQUEADO: faltan APISTORE_USER / APISTORE_PASS en datos/server.env.');
  console.log('Sin credenciales no se puede hacer P2 (no hay forma de leer id_tramite_principal).');
  console.log('Cuando las tengas: node scripts/test-tramite-apistore.mjs --tramites=DNI:tramite,...');
  process.exit(2);
}

async function json(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (_) {}
  return { status: r.status, body: j, texto: txt };
}

console.log('APISTORE P2 — ' + new Date().toISOString());
const login = await json(BASE + '/v1/login/jwt', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
console.log('login: http=' + login.status + ' token=' + (login.body && login.body.token ? 'SI' : 'NO') + ' ' + login.texto.slice(0, 120));
if (!login.body || !login.body.token) {
  console.log('VEREDICTO: BLOQUEADO (login fallo)');
  process.exit(2);
}
const token = login.body.token;
const auth = { accept: 'application/json', authorization: 'JWT ' + token };

const informe = [];
for (const dni of DNIS) {
  let fila = null;
  for (const g of ['M', 'F']) {
    const r = await json(BASE + '/v1/information/person-renaper/' + dni + '/gender/' + g, { headers: auth });
    if (r.status === 200 && r.body) { fila = r.body; break; }
    if (r.status !== 409) console.log('  ' + dni + '/' + g + ': http=' + r.status + ' ' + r.texto.slice(0, 100));
  }
  if (!fila) { informe.push({ dni, ok: false, motivo: 'sin respuesta' }); continue; }
  const id = String(fila.id_tramite_principal || '').replace(/\D/g, '');
  const pad = id ? id.padStart(11, '0') : '';
  const conocido = TRAMITES[dni] || '';
  const igual = Boolean(conocido && pad === conocido);
  informe.push({ dni, id, pad, conocido, igual, nacimiento: fila.fecha_nacimiento || null, calle: fila.calle || null, numero: fila.numero || null });
  console.log('  ' + dni + ': id=' + (id || '-') + ' pad11=' + (pad || '-') + ' conocido=' + (conocido || '-') + ' => ' + (igual ? 'IGUAL' : 'DISTINTO'));
}

const conTramite = informe.filter((x) => x.conocido);
const todosIgual = conTramite.length > 0 && conTramite.every((x) => x.igual);
console.log('\nVEREDICTO: ' + (conTramite.length === 0
  ? 'FALTA DATO: pasar --tramites=DNI:tramite para comparar'
  : (todosIgual ? 'SIRVE (padStart(11) coincide)' : 'NO SIRVE (el id de 9 digitos no es el tramite impreso)')));
process.exit(todosIgual ? 0 : 1);
