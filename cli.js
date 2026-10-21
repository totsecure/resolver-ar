import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { resolver } from './lib/resolver.js';
import { renderizar } from './lib/informe.js';
import { consultarBcra, consultarCne } from './lib/fuentes.js';

const [cmd, arg, ...flags] = process.argv.slice(2);
const db = new DatabaseSync(path.join(import.meta.dirname, 'datos', 'padron.db'));

if (cmd === 'probar') {
  const r = resolver(db, arg);
  const fuentes = (r.encontrado && !flags.includes('--offline')) ? await consultarBcra(r.cuit) : null;
  console.log(renderizar(r, fuentes));
} else if (cmd === 'cne') {
  console.log(JSON.stringify(await consultarCne(arg), null, 2));
} else if (cmd === 'buscar') {
  console.table(db.prepare('SELECT dni, apellido, nombre FROM personas WHERE apellido LIKE ? OR nombre LIKE ? LIMIT 20').all('%'+arg+'%','%'+arg+'%'));
} else if (cmd === 'stats') {
  const n = db.prepare('SELECT COUNT(*) n FROM personas').get().n;
  const amb = db.prepare('SELECT COUNT(*) n FROM (SELECT dni FROM personas GROUP BY dni HAVING COUNT(*)>1)').get().n;
  const pref = db.prepare('SELECT substr(cuit,1,2) p, COUNT(*) n FROM personas GROUP BY p ORDER BY n DESC').all();
  console.log('filas:', n, '| dni ambiguos:', amb);
  console.log('prefijos:', pref.map(x => x.p + '=' + x.n).join(' '));
} else {
  console.log('uso: node cli.js probar <dni> [--offline] | cne <dni> | buscar <texto> | stats');
}
