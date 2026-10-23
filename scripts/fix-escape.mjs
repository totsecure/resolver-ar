import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const ARCHIVOS = ['/Users/bunker/resolver/bot/telegram.js', '/Users/bunker/resolver/bot/stock.js'];
const REEMPLAZOS = [
  ['<refs>', '&lt;refs&gt;'],
  ['<ref>', '&lt;ref&gt;'],
  ['<bin>', '&lt;bin&gt;'],
  ['<min>', '&lt;min&gt;'],
  ['<codigo>', '&lt;codigo&gt;'],
  ['<valor>', '&lt;valor&gt;'],
  ['<disp>', '&lt;disp&gt;'],
  ['<txt>', '&lt;txt&gt;'],
];

for (const f of ARCHIVOS) {
  let s = fs.readFileSync(f, 'utf8');
  const antes = s;
  const detalle = [];
  for (const [de, a] of REEMPLAZOS) {
    const n = s.split(de).length - 1;
    if (n) { s = s.split(de).join(a); detalle.push(de + ' x' + n); }
  }
  if (s === antes) { console.log('= ' + f + ': sin cambios'); continue; }
  fs.copyFileSync(f, f + '.bak-escape');
  fs.writeFileSync(f, s);
  console.log('+ ' + f + ': ' + detalle.join(', '));
}

try {
  execFileSync('node', ['--check', ARCHIVOS[0]], { stdio: 'inherit' });
  execFileSync('node', ['--check', ARCHIVOS[1]], { stdio: 'inherit' });
  console.log('node --check: OK los dos');
} catch (e) { console.log('node --check: FALLO'); process.exit(1); }
