import fs from 'node:fs';

const env = fs.readFileSync('/Users/bunker/resolver/datos/server.env', 'utf8');
const TOKEN = ((env.match(/^RESOLVER_TOKEN=(.*)$/m) || [null, ''])[1] || '').trim().replace(/^["']|["']$/g, '');
const W = 'https://resolver-api.correonube.workers.dev/nosis?token=' + encodeURIComponent(TOKEN);
const DNI = process.argv[2] || '30756789';

const PALABRAS = /DOMICILIO|NACIMIENTO|APELLIDO|NOMBRE|DENOMINACION|RAZON SOCIAL|CUIT|DOCUMENTO|ESTADO CIVIL|FECHA DE|SEXO|LOCALIDAD|PROVINCIA|SITUACION/i;
const limpio = (s) => s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function pedir(u, o = {}) {
  const q = new URLSearchParams({ u });
  if (o.m) q.set('m', o.m);
  if (o.b) q.set('b', o.b);
  if (o.ct) q.set('ct', o.ct);
  if (o.cookie) q.set('cookie', o.cookie);
  try {
    const r = await fetch(W + '&' + q.toString());
    const h = {};
    r.headers.forEach((v, k) => { h[k] = v; });
    return { status: r.status, h, texto: await r.text() };
  } catch (e) {
    return { status: 0, h: {}, texto: 'ERR ' + ((e && e.cause && e.cause.code) || (e && e.message)) };
  }
}

function resume(t, n) {
  const lineas = t.split('\n').map(limpio).filter((l) => l && PALABRAS.test(l));
  lineas.slice(0, n).forEach((l) => console.log('     > ' + l.slice(0, 150)));
  if (!lineas.length) console.log('     > (plano) ' + limpio(t).slice(0, 400));
}

console.log('0. HOME');
const home = await pedir('https://informes.nosis.com/');
console.log('   status=' + home.status + ' bytes=' + home.texto.length);
console.log('   headers=' + JSON.stringify(home.h).slice(0, 500));

console.log('1. BUSCAR ' + DNI);
const buscar = await pedir('https://informes.nosis.com/Home/Buscar', {
  m: 'POST',
  ct: 'application/x-www-form-urlencoded',
  b: 'Busqueda.Texto=' + DNI,
});
console.log('   status=' + buscar.status + ' bytes=' + buscar.texto.length);
console.log('   ' + buscar.texto.slice(0, 300));

let ent = null;
try { ent = JSON.parse(buscar.texto).EntidadesEncontradas[0] || null; } catch {}
if (!ent) { console.log('SIN ENTIDAD'); process.exit(0); }

const cuit = String(ent.Documento).replace(/\D/g, '');
const dni8 = cuit.slice(2, 10);
console.log('2. ENTIDAD ' + ent.Documento + ' | ' + ent.RazonSocial + ' | ' + ent.Provincia);
console.log('   UrlInforme ' + ent.UrlInforme);

const rutas = [
  ['asis', 'https://informes.nosis.com' + ent.UrlInforme],
  ['doc=dni8', 'https://informes.nosis.com/InformacionDisponible?source=SITIONOSIS&documento=' + dni8],
  ['doc=cuit', 'https://informes.nosis.com/InformacionDisponible?source=SITIONOSIS&documento=' + cuit],
  ['sin-query', 'https://informes.nosis.com/InformacionDisponible'],
];

let mejor = null;
for (const [n, u] of rutas) {
  const r = await pedir(u);
  const ok = r.status === 200 && r.texto.length > 1500 && PALABRAS.test(r.texto);
  console.log('3. ' + n + ' status=' + r.status + ' bytes=' + r.texto.length + (ok ? '  <== TIENE DATOS' : ''));
  console.log('   headers=' + JSON.stringify(r.h).slice(0, 400));
  if (r.status === 200) resume(r.texto, 12);
  if (ok && (!mejor || r.texto.length > mejor.r.texto.length)) mejor = { n, r, u };
}

if (mejor) {
  fs.writeFileSync('/tmp/nosis-detalle.html', mejor.r.texto);
  console.log('');
  console.log('GUARDADO /tmp/nosis-detalle.html via ' + mejor.n);
}
console.log('FIN');
