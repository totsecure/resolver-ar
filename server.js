import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolver } from './lib/resolver.js';
import { renderizar } from './lib/informe.js';
import { consultarBcra } from './lib/fuentes.js';
import { fichaDetalle } from './lib/ficha.js';
import { calcular as calcularCobertura } from './lib/cobertura.js';
import { armarBloque, generarLote, parsearCards, seleccionarTitulares } from './lib/lote.js';

const VERSION = '1.0.0';
const PUERTO = Number(process.env.PORT || 3001);
const RUTA_DB = process.env.RESOLVER_DB || path.join(import.meta.dirname, 'datos', 'padron.db');
/* Si RESOLVER_TOKEN está vacío => modo dev, sin auth. */
const TOKEN = process.env.RESOLVER_TOKEN || '';

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
  if (!TOKEN) return true; // modo dev explicito
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
app.get('/texto/:dni', async (q, s) => {
  const r = resolver(db, q.params.dni);
  const f = (r.encontrado && q.query.offline !== '1') ? await consultarBcra(r.cuit) : null;
  s.type('text/plain').send(renderizar(r, f));
});

app.get('/persona/:dni', async (q, s) => {
  const r = resolver(db, q.params.dni);
  const f = r.encontrado ? await consultarBcra(r.cuit) : null;
  s.status(r.encontrado ? 200 : 404).json({ ...r, fuentes: f });
});

/* ------------------- endpoints nuevos de SOLO LECTURA ------------------- */
app.get('/health', soloLectura, (q, s) => {
  try {
    s.json({ ok: true, version: VERSION, db: RUTA_DB, personas: contarPersonas() });
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

app.get('/lote', soloLectura, (q, s) => {
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

app.get('/titulares', soloLectura, (q, s) => {
  try {
    const n = Number.parseInt(q.query.n, 10);
    const saltar = Number.parseInt(q.query.saltar, 10);
    const titulares = seleccionarTitulares(db, {
      cantidad: Number.isFinite(n) && n >= 0 ? n : 10,
      saltar: Number.isFinite(saltar) && saltar >= 0 ? saltar : 0,
    });

    const texto = titulares.map((t) => armarBloque(t, null, null)).join('\n\n');
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

app.listen(PUERTO, () => console.log('http://localhost:' + PUERTO + '/texto/3348'))
  .on('error', e => {
    if (e.code === 'EADDRINUSE') console.error('puerto ' + PUERTO + ' ocupado. Corre: lsof -nP -iTCP:' + PUERTO + ' -sTCP:LISTEN');
    else console.error(e);
    process.exit(1);
  });
