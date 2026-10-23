import fs from 'node:fs';

const env = fs.readFileSync('/Users/bunker/resolver/datos/server.env', 'utf8');
const TOKEN = ((env.match(/^RESOLVER_TOKEN=(.*)$/m) || [null, ''])[1] || '').trim().replace(/^["']|["']$/g, '');
const BASE = 'https://resolver-api.correonube.workers.dev/nosis?token=' + TOKEN;

const CUIT = '20307567893';
const DNI = '30756789';
const NOMBRE = 'BUCCINO';

async function traer(url, opts = {}) {
  const q = new URLSearchParams({ u: url });
  if (opts.metodo) q.set('m', opts.metodo);
  if (opts.cuerpo) q.set('b', opts.cuerpo);
  if (opts.ct) q.set('ct', opts.ct);
  try {
    const r = await fetch(BASE + '&' + q.toString());
    return { status: r.status, texto: await r.text() };
  } catch (e) {
    return { status: 0, texto: 'ERROR: ' + e.message };
  }
}

const titulo = (t) => (t.match(/<title>([^<]*)<\/title>/i) || [null, ''])[1].trim();
const limpio = (t) => t.replace(/\s+/g, ' ').slice(0, 220);
const tieneDatos = (t) => new RegExp(NOMBRE, 'i').test(t) || /DENOMINACION|RAZON SOCIAL|DOMICILIO/i.test(t);

console.log('=========== 1. LA HOME DE INFORMES');
const r0 = await traer('https://informes.nosis.com/');
console.log('status:', r0.status, '| bytes:', r0.texto.length, '| title:', titulo(r0.texto));

console.log('\n=========== 2. FORMULARIOS');
const forms = [...r0.texto.matchAll(/<form[\s\S]{0,400}?<\/form>/gi)].map((m) => m[0]);
if (!forms.length) console.log('  (no hay <form>, la busqueda es por JS)');
forms.forEach((f, i) => {
  console.log('  --- form', i, '---');
  const tag = (f.match(/<form[^>]*>/i) || [''])[0];
  console.log('   ', limpio(tag));
  [...f.matchAll(/<input[^>]*>/gi)].map((m) => m[0]).forEach((x) => console.log('     ', limpio(x)));
  [...f.matchAll(/<select[^>]*>/gi)].map((m) => m[0]).forEach((x) => console.log('     ', limpio(x)));
});

console.log('\n=========== 3. INPUTS SUELTOS');
[...r0.texto.matchAll(/<input[^>]*>/gi)].map((m) => m[0]).slice(0, 30)
  .forEach((x) => console.log('  ', limpio(x)));

console.log('\n=========== 4. SCRIPTS EXTERNOS');
[...r0.texto.matchAll(/<script[^>]*src="([^"]+)"/gi)].map((m) => m[1])
  .forEach((s) => console.log('  ', s));

console.log('\n=========== 5. JS INLINE CON PISTAS');
const inlines = [...r0.texto.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
let n = 0;
inlines.forEach((s) => {
  const hit = s.split('\n').filter((l) => /buscar|cuit|dni|ajax|\.post|\.get|action|href\s*=/i.test(l));
  if (hit.length) { n++; console.log('  --- inline', n, '---'); console.log(hit.slice(0, 12).map((l) => '   ' + l.trim()).join('\n')); }
});
if (!n) console.log('  (ninguno)');

console.log('\n=========== 6. CANDIDATOS GET');
const getCands = [
  `https://informes.nosis.com/${CUIT}`,
  `https://informes.nosis.com/informe/${CUIT}`,
  `https://informes.nosis.com/Home/Buscar?q=${CUIT}`,
  `https://informes.nosis.com/buscar?q=${CUIT}`,
  `https://informes.nosis.com/?q=${CUIT}`,
  `https://www.nosis.com/es/informes-comerciales/${CUIT}`,
  `https://www.nosis.com/es/informes-comerciales/consulta?cuit=${CUIT}`,
];
const ganadores = [];
for (const u of getCands) {
  const r = await traer(u);
  const datos = tieneDatos(r.texto);
  console.log('  ' + r.status + (datos ? ' DATOS' : '     ') + ' | ' + r.texto.length + 'b | ' + u.replace('https://', ''));
  if (datos && r.status === 200) { ganadores.push(u); fs.writeFileSync('/tmp/nosis-ok.html', r.texto); }
}

console.log('\n=========== 7. CANDIDATOS POST');
const postCands = [];
for (const f of forms) {
  const acc = (f.match(/action="([^"]*)"/i) || [null, ''])[1];
  if (acc) postCands.push({ url: new URL(acc, 'https://informes.nosis.com/').toString(), campos: [...f.matchAll(/name="([^"]+)"/gi)].map((m) => m[1]) });
}
if (!postCands.length) postCands.push({ url: 'https://informes.nosis.com/', campos: ['cuit'] }, { url: 'https://informes.nosis.com/', campos: ['q'] });
for (const c of postCands) {
  for (const campo of (c.campos.length ? c.campos : ['cuit'])) {
    for (const valor of [CUIT, DNI]) {
      const cuerpo = new URLSearchParams({ [campo]: valor }).toString();
      const r = await traer(c.url, { metodo: 'POST', cuerpo });
      const datos = tieneDatos(r.texto);
      console.log('  ' + r.status + (datos ? ' DATOS' : '     ') + ' | ' + r.texto.length + 'b | POST ' + c.url.replace('https://', '') + '  ' + campo + '=' + valor);
      if (datos && r.status === 200) { ganadores.push('POST ' + c.url + ' ' + campo + '=' + valor); fs.writeFileSync('/tmp/nosis-ok.html', r.texto); }
    }
  }
}

console.log('\n=========== VEREDICTO');
if (ganadores.length) {
  console.log('FUNCIONA. Guarde la mejor respuesta en /tmp/nosis-ok.html');
  ganadores.forEach((g) => console.log('  OK -> ' + g));
  console.log('\nPrimeras lineas con datos:');
  const h = fs.readFileSync('/tmp/nosis-ok.html', 'utf8');
  h.split('\n').filter((l) => l.trim() && /CUIT|DNI|DOMICILIO|DENOMINACION|RAZON|APELLIDO|NOMBRE/i.test(l))
    .slice(0, 15).forEach((l) => console.log('   ' + limpio(l)));
} else {
  console.log('Ningun candidato devolvio datos. Mando la home y los forms crudos para seguir.');
  fs.writeFileSync('/tmp/nosis-home.html', r0.texto);
  console.log('Home guardada en /tmp/nosis-home.html (' + r0.texto.length + ' bytes)');
}
