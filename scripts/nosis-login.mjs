import fs from 'node:fs';

const env = fs.readFileSync('/Users/bunker/resolver/datos/server.env', 'utf8');
const TOKEN = ((env.match(/^RESOLVER_TOKEN=(.*)$/m) || [null, ''])[1] || '').trim().replace(/^["']|["']$/g, '');
const W = 'https://resolver-api.correonube.workers.dev/nosis?token=' + encodeURIComponent(TOKEN);
const B = 'https://informes.nosis.com';

async function pedir(u, o = {}) {
  const q = new URLSearchParams({ u });
  if (o.m) q.set('m', o.m);
  if (o.b) q.set('b', o.b);
  if (o.ct) q.set('ct', o.ct);
  if (o.cookie) q.set('cookie', o.cookie);
  try {
    const r = await fetch(W + '&' + q.toString());
    return { status: r.status, h: [...r.headers.entries()].map(([k, v]) => k + ': ' + v), texto: await r.text() };
  } catch (e) {
    return { status: 0, h: [], texto: 'ERR ' + ((e && e.cause && e.cause.code) || (e && e.message)) };
  }
}

const home = await pedir(B + '/');
console.log('0. HOME status=' + home.status + ' bytes=' + home.texto.length);
console.log('   HEADERS COMPLETOS:');
home.h.forEach((x) => console.log('     ' + x.slice(0, 300)));
console.log('   LINKS con acceso/login/cuenta:');
const links = new Set();
for (const m of home.texto.matchAll(/(?:href|action)="([^"]*)"/g)) {
  if (/cceso|ogin|ngresar|uenta|egistr|alir/i.test(m[1])) links.add(m[1]);
}
[...links].slice(0, 40).forEach((l) => console.log('     ' + l));

const cands = ['/Acceso', '/Home/Acceso', '/Cuenta/Acceso', '/Home/Login', '/Login', '/Cuenta/Login', '/Home/Ingresar', '/Home/Cuenta'];
console.log('1. PAGINAS DE LOGIN');
for (const c of cands) {
  const r = await pedir(B + c);
  const t = ((r.texto.match(/<title>([^<]*)<\/title>/i) || [, ''])[1] || '').trim();
  const action = (r.texto.match(/<form[^>]*action="([^"]*)"/i) || [, ''])[1];
  const inputs = [...r.texto.matchAll(/<input[^>]*>/gi)].map((m) => m[0].replace(/\s+/g, ' ')).slice(0, 10);
  console.log('   ' + c + '  status=' + r.status + '  bytes=' + r.texto.length + '  title=' + t + '  action=' + action);
  inputs.forEach((i) => console.log('       ' + i.slice(0, 170)));
}
console.log('FIN');
