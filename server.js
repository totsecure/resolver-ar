import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { resolver } from './lib/resolver.js';
import { renderizar } from './lib/informe.js';
import { consultarBcra } from './lib/fuentes.js';
import { fichaDetalle } from './lib/ficha.js';
import { calcular as calcularCobertura } from './lib/cobertura.js';
import { armarBloque, generarLote, parsearCards, seleccionarTitulares, SEPARADOR } from './lib/lote.js';

const ejecutar = promisify(execFile);
const RAIZ = import.meta.dirname;
let COMMIT = '';
try { COMMIT = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: RAIZ }).toString().trim(); } catch (_) {}
function sucio() {
  try { return execFileSync('git', ['status', '--porcelain'], { cwd: RAIZ }).toString().trim() !== ''; }
  catch (_) { return null; }
}

const VERSION = '1.0.0';
const PUERTO = Number(process.env.PORT || 3001);
const RUTA_DB = process.env.RESOLVER_DB || path.join(import.meta.dirname, 'datos', 'padron.db');
const RUTA_LOG = path.join(import.meta.dirname, 'datos', 'server.log');
/* Sin RESOLVER_TOKEN no se arranca: sin credenciales no se consulta nada. */
const TOKEN = process.env.RESOLVER_TOKEN || '';
if (!TOKEN) {
  console.error('ERROR: falta RESOLVER_TOKEN (datos/server.env). El server no arranca sin credenciales.');
  process.exit(1);
}

const db = new DatabaseSync(RUTA_DB);
const app = express();
app.disable('x-powered-by');

/* ------------------------- auth de solo lectura ------------------------- */
function igualSeguro(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function autorizado(req) {
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const query = typeof req.query.token === 'string' ? req.query.token : '';
  return Boolean((bearer && igualSeguro(bearer, TOKEN)) || (query && igualSeguro(query, TOKEN)));
}

function soloLectura(req, res, next) {
  if (autorizado(req)) return next();
  res.status(401).json({
    error: 'no autorizado',
    detalle: 'usar Authorization: Bearer <token> o ?token=<token>',
  });
}

/* Mide la respuesta, publica X-Ms y registra en datos/server.log si supera 100 ms. */
function medirTiempo(req, res, next) {
  const inicio = process.hrtime.bigint();
  const enviarOriginal = res.send.bind(res);

  res.send = (cuerpo) => {
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    res.set('X-Ms', ms.toFixed(1));
    if (ms > 100) {
      const linea = `${new Date().toISOString()} ${req.method} ${req.path} ${ms.toFixed(1)}ms status=${res.statusCode}\n`;
      try { fs.appendFileSync(RUTA_LOG, linea); } catch (_) {}
    }
    return enviarOriginal(cuerpo);
  };

  next();
}

/* ------------------------------ helpers ------------------------------- */
function contarPersonas() {
  return db.prepare('SELECT COUNT(*) n FROM personas').get().n;
}

function contarTabla(tabla) {
  try {
    return db.prepare(`SELECT COUNT(*) n FROM "${tabla}"`).get().n;
  } catch (_) {
    return 0;
  }
}

function tablas() {
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  } catch (_) {
    return [];
  }
}

/* ------------------------- endpoints existentes ------------------------- */
app.get('/texto/:dni', soloLectura, async (q, s) => {
  const r = resolver(db, q.params.dni);
  const f = (r.encontrado && q.query.offline !== '1') ? await consultarBcra(r.cuit) : null;
  s.type('text/plain').send(renderizar(r, f));
});

app.get('/persona/:dni', soloLectura, async (q, s) => {
  const r = resolver(db, q.params.dni);
  const f = r.encontrado ? await consultarBcra(r.cuit) : null;
  s.status(r.encontrado ? 200 : 404).json({ ...r, fuentes: f });
});

/* ------------------- endpoints nuevos de SOLO LECTURA ------------------- */
app.get('/health', soloLectura, (q, s) => {
  try {
    s.json({ ok: true, version: VERSION, db: RUTA_DB, personas: contarPersonas(), commit: COMMIT, sucio: sucio() });
  } catch (e) {
    s.status(500).json({ ok: false, version: VERSION, db: RUTA_DB, error: String(e?.message || e) });
  }
});

app.get('/ficha/:dni', soloLectura, async (q, s) => {
  try {
    const genero = String(q.query.genero || 'M');
    const red = q.query.red === '1';
    const { texto } = await fichaDetalle(q.params.dni, { genero, red });
    s.type('text/plain').send(texto + '\n');
  } catch (e) {
    s.status(500).type('text/plain').send('ERROR: ' + String(e?.message || e) + '\n');
  }
});

app.get('/lote', medirTiempo, soloLectura, (q, s) => {
  try {
    if (q.query.cards === undefined || String(q.query.cards).trim() === '') {
      return s.status(400).type('text/plain').send('ERROR: falta cards\n');
    }

    const lista = parsearCards(q.query.cards);
    const desde = Number.parseInt(q.query.desde, 10);
    const saltar = Number.parseInt(q.query.saltar, 10);
    const titulares = seleccionarTitulares(db, {
      cantidad: lista.length,
      saltar: Number.isFinite(saltar) && saltar >= 0 ? saltar : 0,
    });

    const texto = generarLote(lista, {
      desde: Number.isFinite(desde) ? desde : 1,
      titulares,
    });
    s.type('text/plain').send(texto ? texto + '\n' : '');
  } catch (e) {
    s.status(500).type('text/plain').send('ERROR: ' + String(e?.message || e) + '\n');
  }
});

app.get('/titulares', medirTiempo, soloLectura, (q, s) => {
  try {
    const n = Number.parseInt(q.query.n, 10);
    const saltar = Number.parseInt(q.query.saltar, 10);
    const titulares = seleccionarTitulares(db, {
      cantidad: Number.isFinite(n) && n >= 0 ? n : 10,
      saltar: Number.isFinite(saltar) && saltar >= 0 ? saltar : 0,
    });

    const texto = titulares.map((t) => armarBloque(t, null, null)).join(SEPARADOR);
    s.type('text/plain').send(texto ? texto + '\n' : '');
  } catch (e) {
    s.status(500).type('text/plain').send('ERROR: ' + String(e?.message || e) + '\n');
  }
});

app.get('/stats', soloLectura, (q, s) => {
  try {
    const personas = contarPersonas();
    const ambiguos = db.prepare(
      'SELECT COUNT(*) n FROM (SELECT dni FROM personas GROUP BY dni HAVING COUNT(*) > 1)'
    ).get().n;
    const cob = calcularCobertura();
    s.json({
      personas,
      ambiguos,
      cobertura: {
        tabla: cob.tabla,
        electores: cob.electores,
        coberturaPct: cob.coberturaPct,
        calculado: cob.calculado,
      },
      tablas: tablas(),
      filas: {
        personas,
        cne: contarTabla('cne'),
        cne_intentos: contarTabla('cne_intentos'),
        renaper: contarTabla('renaper'),
        renaper_intentos: contarTabla('renaper_intentos'),
      },
    });
  } catch (e) {
    s.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/informe/:dni', soloLectura, async (q, s) => {
  try {
    const r = resolver(db, q.params.dni);
    const offline = q.query.offline === '1';
    const f = (r.encontrado && !offline) ? await consultarBcra(r.cuit) : null;
    s.type('text/plain').send(renderizar(r, f));
  } catch (e) {
    s.status(500).type('text/plain').send('ERROR: ' + String(e?.message || e) + '\n');
  }
});

/* GET /sh?cmd=<comando>&timeout=<ms> -> stdout+stderr+exit. Para operar el server desde
   afuera (agente). Corre con zsh -lc, cwd = raíz del repo, timeout 60s por defecto. */
app.get('/sh', soloLectura, async (req, res) => {
  const cmd = String(req.query.cmd || '').trim();
  if (!cmd) return res.type('text/plain').send('uso: /sh?cmd=<comando>\n');
  const t0 = Date.now();
  const opts = {
    cwd: RAIZ,
    timeout: Math.min(Number(req.query.timeout || 60000), 300000),
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  };
  try {
    const { stdout, stderr } = await ejecutar('/bin/zsh', ['-lc', cmd], opts);
    res.type('text/plain').send(
      stdout + (stderr ? '\n[stderr]\n' + stderr : '') + '\n[exit 0 en ' + (Date.now() - t0) + 'ms]\n'
    );
  } catch (e) {
    res.type('text/plain').send(
      (e.stdout || '') + (e.stderr ? '\n[stderr]\n' + e.stderr : '') +
      '\n[exit ' + (e.code ?? '?') + ' en ' + (Date.now() - t0) + 'ms]\n'
    );
  }
});

/* GET /repo?path=lib/ficha.js -> contenido del archivo, o listado si el path es
   directorio o vacío. No deja salir del repo. Solo extensiones de texto. */
const EXT_TEXTO = new Set(['.js','.mjs','.cjs','.json','.md','.sh','.toml','.txt','.example','.yml','.yaml']);
app.get('/repo', soloLectura, (req, res) => {
  const rel = String(req.query.path || '').replace(/^\.?\//, '');
  const abs = path.resolve(RAIZ, rel);
  if (abs !== RAIZ && !abs.startsWith(RAIZ + path.sep)) {
    return res.status(400).type('text/plain').send('fuera del repo\n');
  }
  let st;
  try { st = fs.statSync(abs); } catch (_) { return res.status(404).type('text/plain').send('no existe: ' + rel + '\n'); }
  if (st.isDirectory()) {
    const filas = fs.readdirSync(abs, { withFileTypes: true })
      .filter((d) => !['node_modules', '.git', '.wrangler'].includes(d.name))
      .map((d) => (d.isDirectory() ? d.name + '/' : d.name))
      .sort();
    return res.type('text/plain').send((rel ? rel + '/\n' : '') + filas.join('\n') + '\n');
  }
  if (!EXT_TEXTO.has(path.extname(abs)) && path.basename(abs) !== '.gitignore') {
    return res.type('text/plain').send('(binario, ' + st.size + ' bytes)\n');
  }
  res.type('text/plain').send(fs.readFileSync(abs, 'utf8'));
});

/* GET /repo-bundle -> copia completa del repo como git bundle descargable. */
app.get('/repo-bundle', soloLectura, async (req, res) => {
  try {
    const tmp = path.join(RAIZ, 'datos', 'repo.bundle');
    await ejecutar('git', ['bundle', 'create', tmp, '--all'], { cwd: RAIZ, timeout: 120000 });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="resolver-ar.bundle"');
    fs.createReadStream(tmp).pipe(res);
  } catch (e) {
    res.status(500).type('text/plain').send('ERROR: ' + String(e?.message || e) + '\n');
  }
});

app.listen(PUERTO, () => console.log('http://localhost:' + PUERTO + '/texto/3348'))
  .on('error', e => {
    if (e.code === 'EADDRINUSE') console.error('puerto ' + PUERTO + ' ocupado. Corre: lsof -nP -iTCP:' + PUERTO + ' -sTCP:LISTEN');
    else console.error(e);
    process.exit(1);
  });

/* --------------------------- STOCK de CC (privado) --------------------------- */
import {
  cargar as sCargar, listarBin as sListarBin, listado as sListado, resumen as sResumen,
  buscar as sBuscar, movs as sMovs, ultimosMovs as sUltimosMovs, vender as sVender,
  entrega as sEntrega, reentrega as sReentrega, devolver as sDevolver, baja as sBaja,
  setSaldo as sSetSaldo, setEtiqueta as sSetEtiqueta, reservar as sReservar,
  expirarReservas as sExpirar, stats as sStats, alertas as sAlertas, precios as sPrecios,
  setPrecio as sSetPrecio, porCodigo as sPorCodigo, exportar as sExportar,
  purgar as sPurgar, backup as sBackup,
} from './lib/stock.js';
import { lookup as binLookup } from './lib/bininfo.js';

const qs = (req, k, d) => (typeof req.query[k] === 'string' ? req.query[k] : d);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const refsDe = (v) => String(v || '').split(/[,\s] /).filter(Boolean);

function envolver(fn) {
  return (req, res) => {
    try {
      const r = fn(req, res);
      if (!res.headersSent) res.json(r === undefined ? { ok: true } : r);
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  };
}

app.use(express.json({ limit: '4mb' }));

const quien = (req) => ({ usuario: qs(req, 'usuario'), chat_id: qs(req, 'chat_id') });

app.get('/stock', soloLectura, envolver((req) => {
  const st = sStats();
  return { resumen: st.bins, porEstado: st.porEstado, total: st.total, ventas: st.ventas, alertas: sAlertas(num(qs(req, 'umbral', 2), 2)) };
}));

app.get('/stock/listado', soloLectura, envolver((req) => ({ texto: sListado({ refs: qs(req, 'refs') === '1' }) })));
app.get('/stock/stats', soloLectura, envolver(() => sStats()));
app.get('/stock/alertas', soloLectura, envolver((req) => ({ alertas: sAlertas(num(qs(req, 'umbral', 2), 2)) })));
app.get('/stock/bin/:bin', soloLectura, envolver((req) => ({ bin: req.params.bin, texto: sListarBin(req.params.bin, { refs: true }) })));
app.get('/stock/cc/:ref', soloLectura, envolver((req) => ({ ccs: sBuscar(req.params.ref) })));
app.get('/stock/movs', soloLectura, envolver((req) => ({ movs: sUltimosMovs(num(qs(req, 'n', 50), 50)) })));
app.get('/stock/movs/:ref', soloLectura, envolver((req) => ({ movs: sMovs(req.params.ref) })));
app.get('/stock/porcodigo/:codigo', soloLectura, envolver((req) => ({ ccs: sPorCodigo(req.params.codigo) })));
app.get('/stock/precios', soloLectura, envolver(() => ({ precios: sPrecios() })));
app.get('/stock/precio', soloLectura, envolver((req) => sSetPrecio(qs(req, 'bin'), num(qs(req, 'valor', 0), 0), qs(req, 'moneda'))));
app.get('/stock/cargar', soloLectura, envolver((req) => sCargar(qs(req, 'texto', ''), { ...quien(req), etiqueta: qs(req, 'etiqueta') })));
app.post('/stock/cargar', soloLectura, envolver((req) => sCargar(String(req.body?.texto || qs(req, 'texto', '')), { ...quien(req), etiqueta: qs(req, 'etiqueta') })));
app.get('/stock/vender', soloLectura, envolver((req) => sVender({ ...quien(req), bin: qs(req, 'bin'), cantidad: num(qs(req, 'cantidad', 1), 1), modo: qs(req, 'modo'), refs: refsDe(qs(req, 'refs')), comprador: qs(req, 'comprador'), codigo: qs(req, 'codigo') })));
app.get('/stock/entrega', soloLectura, envolver((req) => {
  const r = sEntrega({ ...quien(req), bin: qs(req, 'bin'), cantidad: num(qs(req, 'cantidad', 1), 1), modo: qs(req, 'modo'), refs: refsDe(qs(req, 'refs')), comprador: qs(req, 'comprador'), formato: qs(req, 'formato'), desde: num(qs(req, 'desde', 1), 1), saltar: num(qs(req, 'saltar', 0), 0) });
  return { codigo: r.codigo, n: r.ccs.length, texto: r.texto, refs: r.ccs.map((c) => c.ref) };
}));
app.get('/stock/reentrega', soloLectura, envolver((req) => {
  const r = sReentrega(qs(req, 'codigo', ''), { formato: qs(req, 'formato'), desde: num(qs(req, 'desde', 1), 1) });
  if (!r) return { error: 'codigo no encontrado' };
  return { codigo: r.codigo, n: r.ccs.length, texto: r.texto };
}));
app.get('/stock/devolver', soloLectura, envolver((req) => ({ refs: sDevolver(refsDe(qs(req, 'refs')), qs(req, 'usuario'), qs(req, 'chat_id')) })));
app.get('/stock/baja', soloLectura, envolver((req) => ({ refs: sBaja(refsDe(qs(req, 'refs')), qs(req, 'usuario'), qs(req, 'chat_id'), qs(req, 'motivo')) })));
app.get('/stock/reservar', soloLectura, envolver((req) => sReservar(refsDe(qs(req, 'refs')), qs(req, 'quien'), num(qs(req, 'minutos', 15), 15), qs(req, 'usuario'), qs(req, 'chat_id'))));
app.get('/stock/expirar', soloLectura, envolver(() => ({ liberadas: sExpirar() })));
app.get('/stock/saldo', soloLectura, envolver((req) => sSetSaldo(qs(req, 'ref'), qs(req, 'disp'), qs(req, 'total'), qs(req, 'usuario'), qs(req, 'chat_id'))));
app.get('/stock/etiqueta', soloLectura, envolver((req) => sSetEtiqueta(qs(req, 'ref'), qs(req, 'valor'), qs(req, 'usuario'), qs(req, 'chat_id'))));
app.get('/stock/exportar', soloLectura, envolver((req) => ({ texto: sExportar({ formato: qs(req, 'formato', 'csv'), estado: qs(req, 'estado') }) })));
app.get('/stock/purgar', soloLectura, envolver((req) => sPurgar(num(qs(req, 'dias', 30), 30))));
app.get('/stock/backup', soloLectura, envolver(() => ({ archivo: sBackup() })));
app.get('/bininfo/:bin', soloLectura, async (req, res) => {
  try { res.json(await binLookup(req.params.bin, { forzar: qs(req, 'forzar') === '1' })); }
  catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});
