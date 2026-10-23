/* nosis-entrar.mjs — login automatico en Nosis + informe del titular.
 *
 *   node scripts/nosis-entrar.mjs [usuario] [clave]
 *
 * Pasos (criterio de aceptacion de T1):
 *   1) descubre el login que pide informes.nosis.com
 *   2) hace login por la API de la SPA (POST /ui/login -> /ui/login-pwd)
 *   3) deja datos/nosis-session.json con cookie no vacia
 *   4) pide el informe del titular y muestra DOMICILIO/NACIMIENTO
 *
 * Sale 0 solo si el informe tiene campos. Todo el trafico va por el Worker.
 */
import fs from 'node:fs';
import * as nosis from '../lib/nosis.js';

const CUIT = process.argv[4] || '20307567890';
const URLIN = 'https://informes.nosis.com/InformacionDisponible?source=SITIONOSIS&documento=' + CUIT;

const limpio = (s) => String(s).replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const titulo = (s) => (((String(s).match(/<title>([^<]*)<\/title>/i) || [, ''])[1] || '').trim());

console.log('0. asegurar tablas de cache');
console.log('   ' + (nosis.asegurar() ? 'ok' : 'FALLO'));

console.log('\n1. descubrir login');
const a = await nosis.pedir(URLIN, { manual: true });
console.log('   status=' + a.status + '  x-location=' + (a.headers['x-location'] || '(vacio)'));

console.log('\n2. login automatico');
const cd = nosis.cooldown();
if (cd) console.log('   cooldown previo: ' + (cd.activo ? 'ACTIVO hasta ' + cd.hasta : 'vencido (' + cd.hasta + ')'));
let cookie = '';
try {
  cookie = await nosis.login({
    usuario: process.argv[2] || undefined,
    clave: process.argv[3] || undefined,
    urlRetorno: URLIN,
  });
  console.log('   OK cookie=' + cookie.slice(0, 120) + (cookie.length > 120 ? '...' : ''));
} catch (e) {
  console.log('   FALLO: ' + String(e && e.message));
  const c = nosis.cooldown();
  if (c && c.activo) console.log('   cooldown hasta ' + c.hasta + ' (archivo datos/nosis-cooldown.json)');
  console.log('\n=> Nosis rechaza las credenciales de datos/server.env (NOSIS_USER/NOSIS_PASS).');
  console.log('   Reset: auth.nosis.com -> "Olvidé mi contraseña" -> mail a ' + (process.argv[2] || 'NOSIS_USER'));
  console.log('   Luego: actualizar NOSIS_PASS y repetir este script.');
  console.log('   No se reintenta mas para no bloquear la cuenta. FIN');
  process.exit(1);
}

console.log('\n3. sesion guardada');
const s = nosis.leerSesion();
console.log('   archivo=' + JSON.stringify({ cookie: s && s.cookie ? s.cookie.slice(0, 60) + '...' : '(vacia)', cuando: s && s.cuando }));
if (!s || !s.cookie) { console.log('   FALLO: cookie vacia'); process.exit(1); }

console.log('\n4. informe con sesion');
const inf = await nosis.informe(CUIT, { forzar: true });
if (!inf) {
  console.log('   FALLO: Nosis devolvio login o no se pudo leer el informe');
  process.exit(1);
}
const conCampos = /DOMICILIO|NACIMIENTO|APELLIDO|CUIT|DOCUMENTO|FECHA DE/i.test(inf);
console.log('   status=200 bytes=' + inf.length + ' title=' + titulo(inf) + (conCampos ? '  <== TIENE CAMPOS' : ''));
fs.writeFileSync('/tmp/nosis-informe.html', inf);
inf.split('\n').map(limpio).filter((l) => l && /DOMICILIO|NACIMIENTO|APELLIDO|CUIT|DOCUMENTO|FECHA DE|LOCALIDAD|PROVINCIA/i.test(l))
  .slice(0, 30).forEach((l) => console.log('   > ' + l.slice(0, 150)));

const p = nosis.parsearInforme(inf);
console.log('   parseado: ' + JSON.stringify(p));
console.log('   guardado /tmp/nosis-informe.html');
console.log('\nFIN' + (conCampos ? ' (T1 OK)' : ' (sin campos)'));
process.exit(conCampos ? 0 : 1);
