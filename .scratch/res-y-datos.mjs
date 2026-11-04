import fs from 'node:fs';
const R = '/Users/bunker/resolver';
for (const a of ['datos/server.env', 'datos/bot.env']) {
  for (const l of fs.readFileSync(R + '/' + a, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const { base } = await import(R + '/lib/stock.js');
const cat = await import(R + '/lib/catalogo.js');
const r = cat.reservar(11, { bin: '477053', cantidad: 1 });
if (!r.ok) { console.log('ERROR ' + JSON.stringify(r)); process.exit(1); }
const f = base().prepare('SELECT c.codigo, r.id rid FROM cc c JOIN reservas r ON r.cc_id=c.id WHERE r.grupo=? LIMIT 1').get(r.grupo);
console.log(f.codigo);
