import fs from 'node:fs';

const DNI = process.argv[2] || '30756789';
const BASE = 'https://informes.nosis.com';
const WORKER = 'https://resolver-api.correonube.workers.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let jar = '';
const limpio = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function req(u, opt = {}) {
  const h = { 'user-agent': UA, 'accept': '*/*', 'accept-language': 'es-AR,es;q=0.9' };
  if (jar) h.cookie = jar;
  Object.assign(h, opt.headers || {});
  let r;
  try { r = await fetch(u, { ...opt, headers: h, redirect: 'follow' }); }
  catch (e) { return { status: 0, texto: 'ERR ' + e.message, url: u }; }
  const sc = r.headers.get('set-cookie');
  if (sc) {
    const partes = sc.split(/,(?=[^;=]+=)/).map((c) => c.split(';')[0].trim()).filter(Boolean);
    if (partes.length) jar = partes.join('; ');
  }
  return { status: r.status, texto: await r.text(), url: r.url };
}

console.log('=== 0. HOME (cookies)');
const h0 = await req(BASE + '/');
console.log('status=' + h0.status + '  cookies=' + (jar ? jar.length + ' chars' : 'ninguna'));

console.log('\n=== 1. BUSCAR por DNI');
const b = await req(BASE + '/Home/Buscar', {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'x-requested-with': 'XMLHttpRequest',
    referer: BASE + '/',
  },
  body: 'Busqueda.Texto=' + encodeURIComponent(DNI),
});
console.log('status=' + b.status + '  bytes=' + b.texto.length);
let ent = null;
try { ent = (JSON.parse(b.texto).EntidadesEncontradas || [])[0] || null; } catch {}
if (!ent) { console.log('sin entidades para ' + DNI); console.log(b.texto.slice(0, 600)); process.exit(0); }
console.log('  -> ' + ent.RazonSocial + ' | ' + ent.Documento + ' | ' + ent.Provincia);
const doc = String(ent.Documento || '').replace(/\D/g, '');
const urlInf = BASE + String(ent.UrlInforme || '').replace(/\\u0026/g, '&');

console.log('\n=== 2. DETALLE');
const cands = [
  ['UrlInforme', urlInf],
  ['doc', BASE + '/InformacionDisponible?source=SITIONOSIS&documento=' + doc],
  ['Home', BASE + '/Home/InformacionDisponible?documento=' + doc],
];
let mejor = null;
for (const [n, u] of cands) {
  const r = await req(u);
  const hit = /DOMICILIO|NACIMIENTO|APELLIDO|DENOMINACION|RAZON|CUIT|ESTADO CIVIL|SEXO|FECHA/i.test(r.texto);
  console.log('  ' + n + ' status=' + r.status + ' bytes=' + r.texto.length + (hit ? '  <== DATOS' : ''));
  if (r.status === 200 && r.texto.length > 500 && hit) mejor = { n, r };
}

if (!mejor) { console.log('\nsin detalle. mando el crudo de la ultima:'); console.log(limpio(cands[cands.length - 1] ? '' : '')); process.exit(0); }
fs.writeFileSync('/tmp/nosis-detalle.html', mejor.r.texto);
console.log('\nGuardado /tmp/nosis-detalle.html');
const lineas = mejor.r.texto.split('\n').filter((l) => /DOMICILIO|NACIMIENTO|APELLIDO|NOMBRE|DENOMINACION|CUIT|DOCUMENTO|ESTADO CIVIL|SEXO|FECHA/i.test(l));
console.log('\nLineas con campos (' + lineas.length + '):');
lineas.slice(0, 40).forEach((l) => console.log('   ' + limpio(l).slice(0, 170)));
if (!lineas.length) { console.log('(nada por linea, texto plano:)'); console.log(limpio(mejor.r.texto).slice(0, 1400)); }

console.log('\n=== 3. WORKER /nosis');
const w1 = await req(WORKER + '/nosis/Home/Buscar', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
  body: 'Busqueda.Texto=' + encodeURIComponent(DNI),
});
console.log('  /nosis/Home/Buscar status=' + w1.status + ' bytes=' + w1.texto.length);
console.log('  ' + w1.texto.slice(0, 160));
