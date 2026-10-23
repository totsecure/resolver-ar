import fs from 'node:fs';
const env = fs.readFileSync('/Users/bunker/resolver/datos/server.env', 'utf8');
const TOKEN = ((env.match(/^RESOLVER_TOKEN=(.*)$/m) || [null, ''])[1] || '').trim().replace(/^["']|["']$/g, '');
const BASE = 'https://resolver-api.correonube.workers.dev/nosis?token=' + TOKEN;
const CUIT = '20307567893';
const URL = 'https://informes.nosis.com/Home/Buscar';

async function traer(u, o = {}) {
  const q = new URLSearchParams({ u });
  if (o.metodo) q.set('m', o.metodo);
  if (o.cuerpo) q.set('b', o.cuerpo);
  if (o.ct) q.set('ct', o.ct);
  try { const r = await fetch(BASE + '&' + q.toString()); return { status: r.status, texto: await r.text() }; }
  catch (e) { return { status: 0, texto: 'ERROR ' + e.message }; }
}

const pruebas = [
  { n: 'POST Busqueda.Texto', m: 'POST', b: 'Busqueda.Texto=' + CUIT, ct: 'application/x-www-form-urlencoded' },
  { n: 'POST con Localidad vacia', m: 'POST', b: 'Busqueda.Texto=' + CUIT + '&Busqueda.Localidad=', ct: 'application/x-www-form-urlencoded' },
  { n: 'GET con Busqueda.Texto', m: 'GET', b: null, ct: null, u: URL + '?Busqueda.Texto=' + CUIT },
  { n: 'POST JSON', m: 'POST', b: JSON.stringify({ 'Busqueda.Texto': CUIT, 'Busqueda.Localidad': '' }), ct: 'application/json' },
  { n: 'POST por apellido', m: 'POST', b: 'Busqueda.Texto=BUCCINO', ct: 'application/x-www-form-urlencoded' },
  { n: 'POST solo DNI', m: 'POST', b: 'Busqueda.Texto=30756789', ct: 'application/x-www-form-urlencoded' },
];

let mejor = null;
for (const p of pruebas) {
  const r = await traer(p.u || URL, { metodo: p.m, cuerpo: p.b, ct: p.ct });
  const hit = /BUCCINO|DOMICILIO|DENOMINACION|RAZON SOCIAL|CUIT/i.test(r.texto);
  console.log('--- ' + p.n);
  console.log('    status=' + r.status + '  bytes=' + r.texto.length + (hit ? '   <== TIENE DATOS' : ''));
  console.log('    ' + r.texto.replace(/\s+/g, ' ').slice(0, 420));
  if (r.status === 200 && hit && r.texto.length > 400) mejor = p;
}

console.log('\n===== VEREDICTO');
if (mejor) {
  console.log('FUNCIONA: ' + mejor.n);
  const r = await traer(mejor.u || URL, { metodo: mejor.m, cuerpo: mejor.b, ct: mejor.ct });
  fs.writeFileSync('/tmp/nosis-ok.txt', r.texto);
  console.log('respuesta completa en /tmp/nosis-ok.txt (' + r.texto.length + ' bytes)');
} else {
  console.log('ninguna variante trajo datos');
}
