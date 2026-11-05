/* worker-repo.mjs — snapshot del repo en el KV del Worker (sin GH_TOKEN).
 *
 *   node scripts/worker-repo.mjs            # audita, sube y verifica
 *   node scripts/worker-repo.mjs --check    # compara local vs KV (exit 1 si difiere)
 *   node scripts/worker-repo.mjs --check --remoto   # compara via Worker (sin wrangler)
 *   node scripts/worker-repo.mjs --dry      # lista que subiria
 *
 * El repo de GitHub es privado y no queremos depender de un PAT. El Worker lee
 * /gh/<path> desde el binding KV `REPO`; este script lo llena con los archivos
 * trackeados por git + los nuevos de codigo (texto, <=1 MiB), borra los que ya
 * no existen y publica __manifest__.json con el hash de cada archivo.
 *
 * Auditoria de secretos automatica: si aparece una credencial, aborta.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const RAIZ = '/Volumes/Boveda/resolver';
const PROXY = path.join(RAIZ, 'proxy');
const TOML = path.join(PROXY, 'wrangler.toml');
const WORKER = 'https://resolver-api.correonube.workers.dev';
const LIMITE = 1024 * 1024; // 1 MiB por archivo
const MANIFIESTO = '__manifest__.json';
const DRY = process.argv.includes('--dry');
const CHECK = process.argv.includes('--check');
const REMOTO = process.argv.includes('--remoto');

const SECRETOS = [
  [/^RESOLVER_TOKEN[ \t]*=[ \t]*[A-Fa-f0-9]{32,}/m, 'RESOLVER_TOKEN'],
  [/^NOSIS_PASS[ \t]*=[ \t]*\S+/m, 'NOSIS_PASS'],
  [/^NGROK_PASS[ \t]*=[ \t]*\S+/m, 'NGROK_PASS'],
  [/^TELEGRAM_TOKEN[ \t]*=[ \t]*\d{6,}:[A-Za-z0-9_-]{20,}/m, 'TELEGRAM_TOKEN'],
  [/ghp_[A-Za-z0-9]{20,}/, 'PAT GitHub'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'PAT GitHub'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'clave privada'],
];

function env(k) {
  const txt = fs.readFileSync(path.join(RAIZ, 'datos', 'server.env'), 'utf8');
  return ((txt.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1] || '').trim().replace(/^["']|["']$/g, '');
}

function namespaceId() {
  const t = fs.readFileSync(TOML, 'utf8');
  const m = t.match(/binding\s*=\s*"REPO"[\s\S]*?id\s*=\s*"([^"]+)"/) || t.match(/id\s*=\s*"([^"]+)"[\s\S]*?binding\s*=\s*"REPO"/);
  if (!m) throw new Error('no encontre el id del namespace REPO en proxy/wrangler.toml');
  return m[1];
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: PROXY,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function temporario(nombre, contenido) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-kv-'));
  const p = path.join(dir, nombre);
  fs.writeFileSync(p, contenido);
  return p;
}

const huella = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

/* ------------------------------ snapshot local ---------------------------- */
const archivos = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], { cwd: RAIZ })
  .toString('utf8').split('\0').filter(Boolean);

/* Archivos nuevos todavia sin commitear (los que escribimos nosotros), sin
 * basura de backups ni nada de datos/. */
const SEGURO = /\.(js|mjs|md|json|sh|toml|txt|html|css|svg)$/i;
/* Archivos nuevos (sin commitear) que SI forman parte del snapshot. Lista
 * explicita para no publicar trabajo en curso de otras tandas (test-auth,
 * crear-usuario, paginas del panel, etc.). */
const NUEVOS = new Set([
  'HANDOFF.md',
  'ESTADO-DATOS.md', 'LEEME.txt',
  'lib/nosis.js', 'lib/persona.js', 'lib/fuentes-datos.js', 'lib/persona-api.js', 'lib/carga-cc.js',
  /* Fase 1-4: auth, vendedores, saldo, catalogo y bot unificado. */
  'lib/auth.js', 'lib/wallet.js', 'lib/vendedores.js', 'lib/recargas.js', 'lib/catalogo.js',
  'lib/vinculacion.js', 'lib/notificaciones.js', 'lib/reclamos.js', 'lib/vendedor-bot.js',
  'lib/precios.js', 'lib/metricas.js', 'lib/checker.js',
  'bot/vendedor.js',
  'panel/login.html', 'panel/mi.html', 'panel/registro.html', 'panel/catalogo.html', 'panel/vendedores.html', 'panel/admin.html',
  'scripts/crear-usuario.mjs',
  'scripts/test-auth.mjs', 'scripts/test-auth-http.mjs',
  'scripts/test-fase2.mjs', 'scripts/test-fase2-http.mjs',
  'scripts/test-fase3.mjs', 'scripts/test-fase3-http.mjs',
  'scripts/test-fase4.mjs', 'scripts/test-fase4-http.mjs',
  'scripts/test-fase5.mjs', 'scripts/test-fase5-http.mjs',
  'scripts/test-fase6.mjs', 'scripts/test-fase6-http.mjs',
  'scripts/test-b4-config.mjs', 'scripts/test-b6-lotes.mjs', 'scripts/test-b7-pipe.mjs',
  'scripts/test-b9-reactivar.mjs', 'scripts/test-a1-a5.mjs', 'scripts/test-fix1-fix2.mjs', 'scripts/test-b1-b4.mjs', 'scripts/test-concurrencia.mjs', 'scripts/test-conc-http-real.mjs', 'scripts/test-c1-c4.mjs', 'scripts/test-d1-d4.mjs', 'scripts/test-e1-e5.mjs', 'scripts/test-f1-f4.mjs', 'scripts/test-g1-g4.mjs', 'scripts/alertar.sh', 'scripts/limpiar-tests.mjs', 'scripts/test-h1-h2.mjs', 'scripts/test-fix6.mjs', 'docs/CHECKER.md', 'lib/operacion.js', 'lib/precio-corto.js', 'scripts/test-precio-par.mjs', 'lib/pedidos.js', 'lib/metricas.js',
  'docs/MAIL-APISTORE.txt', 'docs/SOLICITUD-SISA.txt', 'docs/SOLICITUD-SID-RENAPER.txt',
  'scripts/backup-dbs.sh', 'scripts/server-foreground.sh',
  'scripts/nosis-entrar.mjs', 'scripts/nosis-humo.mjs', 'scripts/worker-repo.mjs',
  'scripts/importar-fuente.mjs', 'scripts/test-carga-cc.mjs', 'scripts/sondas.mjs',
  'lib/config.js',
  'scripts/importar-padron-idach.mjs', 'scripts/cobertura-nosis.mjs', 'scripts/test-tramite-apistore.mjs',
  'scripts/diag-join-idach.mjs',
  'docs/SOLICITUD-SISA.txt', 'docs/SOLICITUD-SID-RENAPER.txt', 'docs/MAIL-APISTORE.txt',
]);
const esSeguro = (r) => SEGURO.test(r)
  && !r.startsWith('_bak/')
  && !r.includes('.bak')
  && !r.includes('.prefix')
  && !/(^|\/)datos\//.test(r)
  && NUEVOS.has(r);
const otros = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z'], { cwd: RAIZ })
  .toString('utf8').split('\0').filter(Boolean).filter(esSeguro);
const todos = [...new Set([...archivos, ...otros])];

const pares = [];
const salteados = [];
const vistos = new Set([MANIFIESTO]);
for (const ruta of todos) {
  if (ruta.includes('..') || ruta.startsWith('/')) { salteados.push([ruta, 'ruta invalida']); continue; }
  if (ruta.startsWith('datos/')) { salteados.push([ruta, 'datos/ excluido']); continue; }
  const abs = path.join(RAIZ, ruta);
  let st;
  try { st = fs.statSync(abs); } catch (_) { salteados.push([ruta, 'no existe']); continue; }
  if (!st.isFile()) { salteados.push([ruta, 'no es archivo']); continue; }
  if (st.size > LIMITE) { salteados.push([ruta, ' > 1 MiB (' + st.size + ')']); continue; }
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) { salteados.push([ruta, 'binario']); continue; }
  vistos.add(ruta);
  pares.push({ key: ruta, value: buf.toString('utf8') });
}

/* ---------------------------- auditoria de secretos ----------------------- */
const hallazgos = [];
for (const p of pares) {
  for (const [re, nombre] of SECRETOS) {
    if (re.test(p.value)) hallazgos.push(p.key + ' :: ' + nombre);
  }
  if (p.key.startsWith('datos/')) hallazgos.push(p.key + ' :: ruta datos/');
}
if (hallazgos.length) {
  console.error('AUDITORIA DE SECRETOS: FALLO');
  hallazgos.forEach((h) => console.error('  ' + h));
  console.error('Se aborta: no se sube nada al KV.');
  process.exit(1);
}

const manifiesto = {
  version: 1,
  fecha: new Date().toISOString(),
  archivos: Object.fromEntries(pares.map((p) => [p.key, huella(p.value)])),
};

console.log('trackeados=' + archivos.length + '  nuevos=' + otros.length + '  a subir=' + pares.length + '  salteados=' + salteados.length + '  secretos=0');

/* -------------------------------- --check -------------------------------- */
if (CHECK) {
  const id = namespaceId();
  const leerRemoto = async () => {
    if (REMOTO) {
      const r = await fetch(WORKER + '/gh/' + MANIFIESTO + '?token=' + encodeURIComponent(env('RESOLVER_TOKEN')) + '&t=' + Date.now());
      if (r.status !== 200) throw new Error('http=' + r.status);
      return JSON.parse(await r.text());
    }
    const salida = wrangler(['kv', 'key', 'get', MANIFIESTO, '--namespace-id=' + id, '--remote']);
    return JSON.parse(salida.slice(salida.indexOf('{')));
  };

  const comparar = (remoto) => {
    const a = manifiesto.archivos;
    const b = (remoto && remoto.archivos) || {};
    return {
      faltan: Object.keys(a).filter((k) => !(k in b)),
      sobran: Object.keys(b).filter((k) => !(k in a)),
      cambiados: Object.keys(a).filter((k) => k in b && a[k] !== b[k]),
    };
  };

  let remoto = null;
  let diff = null;
  try {
    remoto = await leerRemoto();
    diff = comparar(remoto);
    /* KV es eventualmente consistente: si acabamos de subir, reintentar 1 vez. */
    if (REMOTO && (diff.faltan.length || diff.sobran.length || diff.cambiados.length)) {
      await new Promise((r) => setTimeout(r, 1500));
      remoto = await leerRemoto();
      diff = comparar(remoto);
    }
  } catch (e) {
    console.error('CHECK FALLO: no pude leer el manifiesto remoto: ' + String(e.message).slice(0, 200));
    process.exit(1);
  }

  if (!diff.faltan.length && !diff.sobran.length && !diff.cambiados.length) {
    console.log('CHECK OK: KV al dia (' + Object.keys(manifiesto.archivos).length + ' archivos)');
    process.exit(0);
  }
  console.log('CHECK DESACTUALIZADO: faltan=' + diff.faltan.length + ' sobran=' + diff.sobran.length + ' cambiados=' + diff.cambiados.length);
  diff.faltan.slice(0, 10).forEach((k) => console.log('  FALTA    ' + k));
  diff.cambiados.slice(0, 10).forEach((k) => console.log('  CAMBIO   ' + k));
  diff.sobran.slice(0, 10).forEach((k) => console.log('  SOBRA    ' + k));
  console.log('Correr: node scripts/worker-repo.mjs');
  process.exit(1);
}

const resumen = pares.map((p) => '  ' + p.key + ' (' + Buffer.byteLength(p.value) + ' b)');
if (DRY) {
  resumen.forEach((l) => console.log(l));
  salteados.forEach(([r, m]) => console.log('  SKIP ' + r + ' :: ' + m));
  process.exit(0);
}

/* --------------------------------- subir --------------------------------- */
const id = namespaceId();
const subida = [...pares, { key: MANIFIESTO, value: JSON.stringify(manifiesto) }];
const tmpPut = temporario('put.json', JSON.stringify(subida));

console.log('1. subiendo snapshot al KV REPO (' + id + ')');
try {
  const salida = wrangler(['kv', 'bulk', 'put', tmpPut, '--namespace-id=' + id, '--remote']);
  const linea = salida.split('\n').filter((l) => /Success|Uploaded|wrote|inserted/i.test(l)).slice(-2).join(' ');
  console.log('   ' + (linea || 'ok'));
} catch (e) {
  console.error('   FALLO wrangler bulk put:\n' + String(e.stderr || e.message).slice(0, 1200));
  process.exit(1);
}

/* El bulk put no es atomico: el manifiesto puede leerse viejo por unos segundos.
 * Esperar a que la API de KV devuelva el manifiesto que acabamos de subir. */
console.log('1b. esperando propagacion del manifiesto');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let manifiestoOk = false;
for (let i = 0; i < 15; i++) {
  await dormir(800);
  try {
    const salida = wrangler(['kv', 'key', 'get', MANIFIESTO, '--namespace-id=' + id, '--remote']);
    const rem = JSON.parse(salida.slice(salida.indexOf('{')));
    const a = manifiesto.archivos;
    const b = (rem && rem.archivos) || {};
    const igual = Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
    if (igual) { manifiestoOk = true; break; }
  } catch (_) {}
}
console.log(manifiestoOk ? '   manifiesto al dia' : '   AVISO: el manifiesto sigue propagando');

/* Borrar del KV las claves que ya no estan en el repo. */
console.log('2. limpiando claves viejas');let viejas = [];
try {
  const salida = wrangler(['kv', 'key', 'list', '--namespace-id=' + id, '--remote']);
  const lista = JSON.parse(salida.slice(salida.indexOf('[')));
  viejas = lista.map((k) => k.name).filter((k) => k && !vistos.has(k));
} catch (e) {
  console.log('   AVISO no pude listar claves: ' + String(e.message).slice(0, 200));
}
if (viejas.length) {
  const tmpDel = temporario('del.json', JSON.stringify(viejas));
  try {
    wrangler(['kv', 'bulk', 'delete', tmpDel, '--namespace-id=' + id, '--remote', '--force']);
    console.log('   borradas=' + viejas.length + ' :: ' + viejas.slice(0, 8).join(', '));
  } catch (e) {
    console.log('   AVISO no pude borrar: ' + String(e.stderr || e.message).slice(0, 300));
  }
} else {
  console.log('   nada que borrar');
}

/* Verificacion real contra el Worker. */
console.log('3. verificando /gh/package.json');
const token = env('RESOLVER_TOKEN');
const esperado = fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8');
const r = await fetch(WORKER + '/gh/package.json?token=' + encodeURIComponent(token) + '&t=' + Date.now());
const texto = await r.text();
const ok = r.status === 200 && texto === esperado;
console.log('   status=' + r.status + ' origen=' + (r.headers.get('x-origen') || '-') + ' igual=' + (texto === esperado));
if (!ok) {
  console.log('   recibido: ' + texto.replace(/\s+/g, ' ').slice(0, 200));
  process.exit(1);
}
console.log('OK snapshot en KV (' + pares.length + ' archivos + manifiesto)');
