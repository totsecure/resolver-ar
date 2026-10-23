import fs from 'node:fs';

const BASE = 'https://informes.nosis.com';
const WORKER = 'https://resolver-api.correonube.workers.dev';
const DNI = process.argv[2] || '30756789';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const jar = new Map();

function guardarCookies(res) {
  let lista = [];
  if (typeof res.headers.getSetCookie === 'function') {
    lista = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) lista = raw.split(/,(?=[^;]+=)/);
  }
  for (const c of lista) {
    const par = c.split(';')[0];
    const i = par.indexOf('=');
    if (i > 0) jar.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
}

async function pedir(url, opts = {}) {
  const { sinCookie = false, ...resto } = opts;
  const headers = { 'user-agent': UA, accept: '*/*', ...(resto.headers || {}) };
  if (!sinCookie && jar.size && !headers.cookie) headers.cookie = cookieHeader();
  try {
    const r = await fetch(url, { ...resto, headers, redirect: 'follow' });
    guardarCookies(r);
    const t = await r.text();
    return { status: r.status, final: r.url, texto: t };
  } catch (e) {
    return { status: 0, final: url, texto: 'ERR ' + ((e && e.cause && e.cause.code) || (e && e.message)) };
  }
}

const PALABRAS = /DOMICILIO|NACIMIENTO|APELLIDO|NOMBRE|DENOMINACION|RAZON SOCIAL|CUIT|DOCUMENTO|ESTADO CIVIL|FECHA DE|SEXO|LOCALIDAD|PROVINCIA/i;
const limpio = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

const home = await pedir(BASE + '/');
console.log('0. HOME status=' + home.status + ' bytes=' + home.texto.length + ' cookies=' + jar.size);

const buscar = await pedir(BASE + '/Home/Buscar', {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'x-requested-with': 'XMLHttpRequest',
    referer: BASE + '/',
  },
  body: 'Busqueda.Texto=' + encodeURIComponent(DNI),
});
console.log('1. BUSCAR status=' + buscar.status + ' bytes=' + buscar.texto.length);
console.log('   ' + buscar.texto.slice(0, 400));

let ent = null;
try { ent = JSON.parse(buscar.texto).EntidadesEncontradas[0] || null; } catch {}
if (!ent) { console.log('SIN ENTIDAD. FIN'); process.exit(0); }

const cuit = String(ent.Documento).replace(/\D/g, '');
const dni8 = cuit.slice(2, 10);
console.log('2. ENTIDAD ' + ent.Documento + ' | ' + ent.RazonSocial + ' | ' + ent.Provincia);
console.log('   UrlInforme ' + ent.UrlInforme);
console.log('   cuit=' + cuit + '  dni8=' + dni8);

const pruebas = [
  ['asis+cookie', ent.UrlInforme, false],
  ['asis-sincookie', ent.UrlInforme, true],
  ['doc=dni8', '/InformacionDisponible?source=SITIONOSIS&documento=' + dni8, false],
  ['doc=cuit', '/InformacionDisponible?source=SITIONOSIS&documento=' + cuit, false],
  ['sin-query', '/InformacionDisponible', false],
];

let mejor = null;
for (const [nombre, ruta, sinCookie] of pruebas) {
  const url = ruta.startsWith('http') ? ruta : BASE + ruta;
  const r = await pedir(url, { sinCookie, headers: { referer: BASE + ent.UrlInforme } });
  const ok = r.status === 200 && PALABRAS.test(r.texto) && r.texto.length > 800;
  console.log('3. ' + nombre + ' status=' + r.status + ' bytes=' + r.texto.length + (ok ? '  <== TIENE DATOS' : ''));
  if (r.status !== 200) console.log('   ' + limpio(r.texto).slice(0, 200));
  if (ok && (!mejor || r.texto.length > mejor.r.texto.length)) mejor = { nombre, r, url };
}

if (mejor) {
  fs.writeFileSync('/tmp/nosis-detalle.html', mejor.r.texto);
  const lineas = mejor.r.texto.split('\n').map(limpio).filter((l) => l && PALABRAS.test(l));
  console.log('');
  console.log('=== CAMPOS (' + mejor.nombre + ') guardado en /tmp/nosis-detalle.html');
  lineas.slice(0, 45).forEach((l) => console.log('   ' + l.slice(0, 160)));
  if (!lineas.length) console.log(limpio(mejor.r.texto).slice(0, 1500));
} else {
  console.log('');
  console.log('=== ningun candidato trajo datos (ver Worker abajo)');
}

console.log('');
console.log('4. WORKER /nosis');
const w1 = await pedir(WORKER + '/nosis/Home/Buscar', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
  body: 'Busqueda.Texto=' + encodeURIComponent(DNI),
});
console.log('   POST /nosis/Home/Buscar status=' + w1.status + ' bytes=' + w1.texto.length);
console.log('   ' + w1.texto.slice(0, 200));

const w2 = await pedir(WORKER + '/nosis/InformacionDisponible?source=SITIONOSIS&documento=' + cuit);
console.log('   GET /nosis/InformacionDisponible status=' + w2.status + ' bytes=' + w2.texto.length);
console.log('   ' + w2.texto.slice(0, 200));
if (w2.status === 200 && PALABRAS.test(w2.texto)) {
  fs.writeFileSync('/tmp/nosis-detalle-worker.html', w2.texto);
  console.log('   guardado /tmp/nosis-detalle-worker.html');
}
console.log('');
console.log('FIN');
