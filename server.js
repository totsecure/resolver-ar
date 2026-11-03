import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { resolver } from './lib/resolver.js';
import * as argos from './lib/argos.js';
import * as gordo from './lib/gordo.js';
import * as persona from './lib/persona.js';
import { renderizar } from './lib/informe.js';
import { consultarBcra } from './lib/fuentes.js';
import { fichaDetalle } from './lib/ficha.js';
import { calcular as calcularCobertura } from './lib/cobertura.js';
import { armarBloque, generarLote, parsearCards, seleccionarTitulares, SEPARADOR } from './lib/lote.js';
import * as auth from './lib/auth.js';
import * as wallet from './lib/wallet.js';
import * as vendedores from './lib/vendedores.js';
import * as recargas from './lib/recargas.js';
import * as catalogo from './lib/catalogo.js';
import * as vinculacion from './lib/vinculacion.js';
import * as notificaciones from './lib/notificaciones.js';
import * as reclamos from './lib/reclamos.js';
import * as precios from './lib/precios.js';
import * as metricas from './lib/metricas.js';
import * as checker from './lib/checker.js';
import * as pedido from './lib/pedido.js';
import * as pedidos from './lib/pedidos.js';
import * as operacion from './lib/operacion.js';
import {
  validar,
  login as loginSchema, segundoFactor as segundoFactorSchema, registro as registroSchema,
  ccAnalizar as ccAnalizarSchema, ccConfirmar as ccConfirmarSchema, panelComprar as panelComprarSchema,
  catalogoReservar as catalogoReservarSchema, catalogoPagar as catalogoPagarSchema,
  catalogoChk as catalogoChkSchema, catalogoCancelar as catalogoCancelarSchema,
  admin as adminSchema,
} from './lib/validacion.js';

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
/* Solo loopback: el acceso público entra por el Worker -> ngrok. */
const HOST = process.env.HOST || '127.0.0.1';
const DATASETTE_URL = process.env.DATASETTE_URL || 'http://127.0.0.1:3003';
const RUTA_DB = process.env.RESOLVER_DB || path.join(import.meta.dirname, 'datos', 'padron.db');
const RUTA_LOG = path.join(import.meta.dirname, 'datos', 'server.log');
/* Sin RESOLVER_TOKEN no se arranca: sin credenciales no se consulta nada. */
const TOKEN = process.env.RESOLVER_TOKEN || '';
if (!TOKEN) {
  console.error('ERROR: falta RESOLVER_TOKEN (datos/server.env). El server no arranca sin credenciales.');
  process.exit(1);
}

/* El padrón (personas) es OPCIONAL: el panel/stock funcionan con stock.db solo.
 * Si el archivo no está o no tiene la tabla, el server arranca igual y las
 * rutas que lo usan (/lote, /titulares, /texto, /ficha, /informe) avisan. */
let db = null;
let padronOk = false;
function abrirPadron() {
  if (db) return db;
  try {
    db = new DatabaseSync(RUTA_DB);
    db.exec('PRAGMA busy_timeout = 5000');
    padronOk = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personas'").get());
  } catch (e) {
    console.warn('AVISO: sin padrón (' + RUTA_DB + '): ' + String(e?.message || e));
    db = null;
    padronOk = false;
  }
  return db;
}
function padronON(res, extra = '') {
  if (abrirPadron() && padronOk) return true;
  res.status(503).type('text/plain').send('Sin padrón en este host (RESOLVER_DB). ' + extra + '\n');
  return false;
}
const app = express();
app.disable('x-powered-by');
/* Detras de ngrok/Worker el protocolo y la IP real llegan por headers. */
app.set('trust proxy', 1);
/* Cabeceras seguras. CSP: se permite el <style> inline del panel y los data:
 * URIs de Tabler; no hay scripts inline (todo es /panel/app.js y vendor/).
 * Se desactiva upgrade-insecure-requests para que funcione en http local. */
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: { 'upgrade-insecure-requests': null },
  },
});
app.use((req, res, next) => {
  /* Datasette trae su propio HTML/JS inline: no le aplicamos el CSP del panel. */
  if (req.path === '/datasette' || req.path.startsWith('/datasette/')) return next();
  return helmetMiddleware(req, res, next);
});
/* Compresión global (gzip/br según Accept-Encoding). */
app.use(compression());
/* Rate limit: alto para el panel (se refresca cada 20 s), estricto en auth.
 * La IP real llega en X-Forwarded-For puesta por el Worker (cf-connecting-ip). */
const panelLimit = rateLimit({
  windowMs: 5 * 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'demasiadas peticiones' },
  /* XFF la controla el Worker (cf-connecting-ip); se silencia el warning. */
  validate: { trustProxy: false },
});
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'demasiados intentos' },
  validate: { trustProxy: false },
});
app.use('/panel', panelLimit);
app.use('/api/auth/login', authLimit);
app.use('/api/auth/2fa', authLimit);
app.use('/api/registro', authLimit);
/* Rate limit propio por API key (no por IP). Los tokens de servicio no cuentan. */
const usoApiTokens = new Map();
function limitarApiToken(req, res, next) {
  const header = String(req.get('authorization') || '');
  const raw = req.get('x-api-token') || (header.startsWith('Bearer ') ? header.slice(7).trim() : '');
  if (!raw || raw === TOKEN) return next();
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  const ahora = Date.now();
  let e = usoApiTokens.get(hash);
  if (!e || ahora - e.inicio >= 60000) { e = { inicio: ahora, n: 0 }; usoApiTokens.set(hash, e); }
  e.n += 1;
  if (usoApiTokens.size > 1000) {
    for (const [k, v] of usoApiTokens) if (ahora - v.inicio >= 60000) usoApiTokens.delete(k);
  }
  res.setHeader('RateLimit-Policy', '60;w=60');
  res.setHeader('RateLimit', 'limit=60, remaining=' + Math.max(0, 60 - e.n) + ', reset=60');
  if (e.n > 60) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: 'rate_limit_token' }); }
  next();
}
app.use(limitarApiToken);
auth.migrar();
wallet.migrar();
vendedores.migrar();
recargas.migrar();
catalogo.migrar();
vinculacion.migrar();
notificaciones.migrar();
reclamos.migrar();
precios.migrar();
checker.migrar();
pedidos.migrar();

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

/* --------------------------- sesiones y roles --------------------------- */
const COOKIE_SESION = 'resolver_sesion';
const COOKIE_PRE = 'resolver_precsrf';

function cookies(req) {
  const out = {};
  const raw = req.get('cookie') || '';
  for (const parte of raw.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}

function esHttps(req) {
  const p = String(req.get('x-forwarded-proto') || req.protocol || '').split(',')[0].trim();
  return p === 'https' || req.secure === true;
}

function ponerCookie(req, res, nombre, valor, { httpOnly = true, maxAge = null, path: ruta = '/' } = {}) {
  let c = nombre + '=' + encodeURIComponent(valor) + '; Path=' + ruta + '; SameSite=Lax';
  if (httpOnly) c += '; HttpOnly';
  if (maxAge != null) c += '; Max-Age=' + Math.max(0, Math.floor(maxAge));
  if (esHttps(req)) c += '; Secure';
  const previo = res.getHeader('Set-Cookie');
  const lista = previo == null ? [] : (Array.isArray(previo) ? previo.slice() : [String(previo)]);
  lista.push(c);
  res.setHeader('Set-Cookie', lista);
}

function borrarCookie(req, res, nombre) {
  ponerCookie(req, res, nombre, '', { maxAge: 0 });
}

/** Servicio (token) o sesion de usuario. El token conserva acceso total. */
function contexto(req) {
  if (autorizado(req)) {
    return {
      tipo: 'servicio', rol: 'admin', token: null,
      usuario: { id: 0, usuario: 'servicio', nombre: 'servicio', rol: 'admin' },
      sesion: null,
    };
  }
  const apiToken = req.get('x-api-token')
    || (String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim())
    || (typeof req.query.api_token === 'string' ? req.query.api_token : '');
  if (apiToken && apiToken !== process.env.RESOLVER_TOKEN) {
    const u = auth.usuarioPorApiToken(apiToken, req.ip);
    if (u) {
      return { tipo: 'api', rol: u.rol, usuario: auth.publico(u), crudo: u, sesion: null, token: null };
    }
  }
  const token = cookies(req)[COOKIE_SESION];
  if (!token) return null;
  const ctx = auth.sesionDeToken(token);
  if (!ctx) return null;
  return {
    tipo: 'sesion', token, rol: ctx.usuario.rol,
    usuario: auth.publico(ctx.usuario),
    crudo: ctx.usuario, sesion: ctx.sesion,
  };
}

function debeConfigurar2fa(ctx) {
  /* TOTP desactivado en el flujo de login: no se exige configurarlo. */
  return false;
}

/** Exige sesion autenticada (aunque este pendiente el 2FA). */
function soloSesion(req, res, next) {
  const ctx = contexto(req);
  if (!ctx) return res.status(401).json({ error: 'no autorizado', login: '/login' });
  if (ctx.tipo !== 'sesion') return res.status(403).json({ error: 'requiere_sesion' });
  req.auth = ctx;
  next();
}

/** Exige sesion completa (2FA resuelto) y, si se pasan roles, uno de ellos. */
function acceso(roles = null) {
  return (req, res, next) => {
    const ctx = contexto(req);
    if (!ctx) {
      if (req.method === 'GET' && req.accepts('html')) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
      return res.status(401).json({ error: 'no autorizado', login: '/login' });
    }
    if (ctx.tipo === 'sesion' && ctx.sesion.paso2fa) {
      return res.status(401).json({ error: '2fa_pendiente' });
    }
    if (debeConfigurar2fa(ctx)) {
      return res.status(403).json({ error: '2fa_requerido', detalle: 'Activá el 2FA para continuar.' });
    }
    if (roles && !roles.includes(ctx.rol)) {
      return res.status(403).json({ error: 'sin permiso', rol: ctx.rol });
    }
    /* API keys: scopes. Un token viejo sin scopes conserva acceso completo. */
    if (ctx.tipo === 'api') {
      const sc = ctx.crudo && Array.isArray(ctx.crudo.api_scopes) ? ctx.crudo.api_scopes : [];
      if (sc.length) {
        const ruta = req.path;
        const metodo = req.method;
        let need = null;
        if (ruta.startsWith('/api/admin')) need = metodo === 'GET' ? 'admin:read' : 'admin:write';
        else if (ruta.startsWith('/api/catalogo')) {
          if (metodo === 'GET') need = 'catalogo:read';
          else if (ruta.includes('/reservar')) need = 'catalogo:reserve';
          else if (ruta.includes('/pagar')) need = 'catalogo:pay';
          else need = 'catalogo:read';
        } else if (ruta.startsWith('/api/wallet')) need = 'wallet:read';
        else if (ruta.startsWith('/api/pedidos')) need = metodo === 'GET' ? 'pedidos:read' : 'pedidos:write';
        if (need && !sc.includes(need)) {
          return res.status(403).json({ error: 'scope_requerido', scope: need });
        }
      }
    }
    req.auth = ctx;
    next();
  };
}

/** CSRF: obligatorio en POST con sesion. El token de servicio queda exento. */
function csrf(req, res, next) {
  const ctx = req.auth || contexto(req);
  if (!ctx) return res.status(401).json({ error: 'no autorizado' });
  if (ctx.tipo === 'servicio') return next();
  const enviado = req.get('x-csrf-token')
    || (req.body && req.body._csrf)
    || (typeof req.query._csrf === 'string' ? req.query._csrf : '');
  if (!enviado || !auth.igualSeguro(enviado, ctx.sesion && ctx.sesion.csrf)) {
    return res.status(403).json({ error: 'csrf' });
  }
  next();
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
  if (!abrirPadron()) return 0;
  try { return db.prepare('SELECT COUNT(*) n FROM personas').get().n; } catch (_) { return 0; }
}


/* DNI real al azar del padron (sin traer 5M filas). */
function dniAlAzar() {
  if (!abrirPadron()) return null;
  try {
    const n = contarPersonas();
    if (!n) return null;
    /* OFFSET sobre 5,6M filas es lento: se salta por rowid y se toma la primera fila util. */
    const salto = Math.floor(Math.random() * n);
    const r = db.prepare('SELECT dni FROM personas WHERE rowid >= ? LIMIT 1').get(salto);
    return r && r.dni ? String(r.dni).padStart(8, '0') : null;
  } catch (_) { return null; }
}

function fichaTexto(r) {
  const L = [];
  L.push('TITULAR ' + (r.apellido || '') + ' ' + (r.nombre || ''));
  L.push('DNI ' + r.dni);
  L.push('NRO TRAMITE ' + (r.nroTramite || '-'));
  L.push('FECHA NAC ' + (r.fechaNac || '-') + (r.edad ? ' (' + r.edad + ' anios)' : ''));
  L.push('CUIL ' + (r.cuit || '-'));
  L.push('SEXO ' + (r.sexo || '-'));
  L.push('MAIL ' + (r.mail || '-'));
  L.push('TELEFONO ' + (r.telefono || '-'));
  L.push('DIRECCION ' + (r.direccion || '-'));
  L.push('CIUDAD ' + (r.ciudad || '-'));
  L.push('PROVINCIA ' + (r.provincia || '-'));
  L.push('CP ' + (r.cpostal || '-'));
  L.push('FALLECIDO ' + (r.fallecido ? 'SI' : 'NO') + (r.infoFallecimiento ? ' - ' + r.infoFallecimiento : ''));
  if (r.emision) L.push('DOC EMISION ' + r.emision);
  if (r.vencimiento) L.push('DOC VENCIM. ' + r.vencimiento);
  if (r.ejemplar) L.push('EJEMPLAR ' + r.ejemplar);
  if (r.idCiudadano) L.push('ID CIUDADANO ' + r.idCiudadano);
  if (r.signo) L.push('SIGNO ' + r.signo);
  if (r.barrio) L.push('BARRIO ' + r.barrio);
  L.push('FUENTE ' + (r.fuente || '-'));
  if (r.domicilios && r.domicilios.length) L.push('DOMICILIOS HIST. ' + r.domicilios.join(' | '));
  if (r.familia && r.familia.length) {
    L.push('FAMILIA:');
    for (const f of r.familia) L.push('  - ' + (f.nombre || '') + ' DNI ' + (f.dni || '-') + (f.edad ? '(' + f.edad + ')' : '') + (f.parentesco ? '[' + f.parentesco + ']' : ''));
  }
  return L.join('\n');
}
function contarTabla(tabla) {
  if (!abrirPadron()) return 0;
  try {
    return db.prepare(`SELECT COUNT(*) n FROM "${tabla}"`).get().n;
  } catch (_) {
    return 0;
  }
}

/* Tablas internas de Litestream (creadas en stock.db). No forman parte del
 * contrato público de /stats, pero se informan aparte para que sean conocidas. */
const TABLAS_INTERNAS = ['_litestream_lock', '_litestream_seq'];

function tablas() {
  try {
    abrirPadron();
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((r) => r.name)
      .filter((n) => !TABLAS_INTERNAS.includes(n));
  } catch (_) {
    return [];
  }
}

function tablasInternas() {
  try {
    return sBase().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((r) => r.name)
      .filter((n) => TABLAS_INTERNAS.includes(n));
  } catch (_) {
    return [];
  }
}

/* ------------------------- endpoints existentes ------------------------- */
app.get('/texto/:dni', soloLectura, async (q, s) => {
  if (!padronON(s, 'Probá /health.')) return;
  const r = resolver(db, q.params.dni);
  const f = (r.encontrado && q.query.offline !== '1') ? await consultarBcra(r.cuit) : null;
  s.type('text/plain').send(renderizar(r, f));
});

app.get('/persona/:dni', soloLectura, async (q, s) => {
  if (!padronON(s)) return;
  const r = resolver(db, q.params.dni);
  const f = r.encontrado ? await consultarBcra(r.cuit) : null;
  s.status(r.encontrado ? 200 : 404).json({ ...r, fuentes: f });
});

/* ------------------- endpoints nuevos de SOLO LECTURA ------------------- */

/* -------------------------------- ARGOS -------------------------------- */
app.get('/argos/health', soloLectura, async (q, s) => {
  try { s.json(await argos.health()); } catch (e) { s.status(500).json({ ok: false, error: String(e?.message || e) }); }
});

app.get('/argos/stats', soloLectura, (q, s) => s.json(argos.stats()));
app.get('/argos/limites', soloLectura, (q, s) => s.json(argos.limites()));

app.get('/argos/cache/:dni', soloLectura, (q, s) => {
  const r = argos.cacheDeDni(q.params.dni);
  s.status(r ? 200 : 404).json(r || { fuente: 'AUSENTE', motivo: 'sin cache' });
});

app.get('/argos/local/:dni', soloLectura, async (q, s) => {
  const d = argos.normalizarDni(q.params.dni);
  if (!d) return s.status(400).json({ fuente: 'AUSENTE', motivo: 'dni invalido' });
  const cr = await gordo.crudo(d);
  if (cr) return s.json(gordo.soloLocal(cr, d));
  const r = await argos.datos('local', d, { forzar: true });
  s.status(r && r.fuente !== 'AUSENTE' ? 200 : 404).json(r);
});

app.get('/argos/renaper/:dni', soloLectura, async (q, s) => {
  const d = argos.normalizarDni(q.params.dni);
  if (!d) return s.status(400).json({ fuente: 'AUSENTE', motivo: 'dni invalido' });
  const cr = await gordo.crudo(d);
  if (cr) return s.json(gordo.soloRenaper(cr, d));
  const r = await argos.datos('renaper', d, { forzar: true });
  s.status(r && r.fuente !== 'AUSENTE' ? 200 : 404).json(r);
});


app.get('/argos/prewarm', soloLectura, async (q, s) => {
  const dnis = String(q.query.dnis || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 40);
  const res = [];
  for (const d of dnis) {
    const r = await persona.argosDe(d, { forzar: true });
    res.push({ dni: d, fuente: r.fuente || null, nombre: r.nombreCompleto || null });
  }
  s.json({ ok: true, pedidos: dnis.length, res });
});


app.get('/random', soloLectura, async (q, s) => {
  const n = Math.min(Math.max(Number(q.query.n) || 1, 1), 10);
  const out = [];
  for (let i = 0; i < n; i ++) {
    const d = dniAlAzar();
    if (!d) break;
    const r = await persona.argosDe(d, { forzar: true });
    out.push(r && r.fuente && r.fuente !== 'AUSENTE' ? r : { dni: d, fuente: 'AUSENTE', motivo: (r && r.motivo) || 'sin datos' });
  }
  s.json({ ok: true, pedidos: n, res });
});

app.get('/ficha-random', soloLectura, async (q, s) => {
  const n = Math.min(Math.max(Number(q.query.n) || 1, 1), 5);
  const bloques = [];
  for (let i = 0; i < n; i ++) {
    const d = dniAlAzar();
    if (!d) break;
    const r = await persona.argosDe(d, { forzar: true });
    bloques.push(r && r.fuente && r.fuente !== 'AUSENTE' ? fichaTexto(r) : 'DNI ' + d + ' - AUSENTE (' + ((r && r.motivo) || 'sin datos') + ')');
  }
  s.type('text/plain').send(bloques.join('\n' + '='.repeat(50) + '\n') + '\n');
});

app.get('/ficha-argos/:dni', soloLectura, async (q, s) => {
  const r = await persona.argosDe(q.params.dni, { forzar: q.query.forzar === '1' });
  if (!r || !r.fuente || r.fuente === 'AUSENTE') return s.status(404).type('text/plain').send('AUSENTE - ' + ((r && r.motivo) || 'sin datos'));
  s.type('text/plain').send(fichaTexto(r) + '\n');
});

app.get('/argos/:dni', soloLectura, async (q, s) => {
  const dni = q.params.dni;
  const local = persona.real(dni) || {};
  const conLocal = (r) => {
    const out = { ...local, ...(r || {}) };
    if (!out.nombreCompleto) out.nombreCompleto = [out.apellido, out.nombre].filter(Boolean).join(" ") || null;
    if (!out.fuente || out.fuente === "AUSENTE") out.fuente = out.nombreCompleto ? "LOCAL" : "AUSENTE";
    return out;
  };
  try {
    if (q.query.forzar === "1") return s.json(await persona.argosDe(dni, { forzar: true }));
    const cache = persona.cacheArgos(dni);
    if (cache && cache.fuente && cache.fuente !== "AUSENTE") return s.json(cache);
    /* Sin cache: no se espera mas de 2,5 s; si no llega se sirve lo local y el pedido sigue en segundo plano. */
    const r = await Promise.race([persona.argosDe(dni, {}), new Promise((ok) => setTimeout(() => ok(null), 2500))]);
    if (!r) persona.argosDe(dni, {}).catch(() => {});
    s.json(conLocal(r));
  } catch (e) { s.json(conLocal(null)); }
});

app.get('/nosis-argos/:dni', soloLectura, async (q, s) => {
  try {
    const r = await argos.nosisPdf(q.params.dni);
    if (!r.archivo) return s.status(404).json(r);
    s.sendFile(r.archivo);
  } catch (e) { s.status(500).json({ fuente: 'AUSENTE', motivo: String(e?.message || e) }); }
});

/* /health público (healthchecks de host); si viene token, responde igual. */
app.get('/health', (q, s) => {
  try {
    s.json({ ok: true, version: VERSION, padron: Boolean(abrirPadron() && padronOk), personas: contarPersonas(), commit: COMMIT, sucio: sucio() });
  } catch (e) {
    s.status(500).json({ ok: false, version: VERSION, error: String(e?.message || e) });
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
    if (!padronON(s, 'El lote necesita el padrón.')) return;

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
    if (!padronON(s, 'Titulares necesita el padrón.')) return;
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
    const ambiguos = (() => { try { return db.prepare(
      'SELECT COUNT(*) n FROM (SELECT dni FROM personas GROUP BY dni HAVING COUNT(*) > 1)'
    ).get().n; } catch (_) { return 0; } })();
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
      tablas_internas: tablasInternas(),
      filas: {
        personas,
        cne: contarTabla('cne'),
        cne_intentos: contarTabla('cne_intentos'),
        renaper: contarTabla('renaper'),
        renaper_intentos: contarTabla('renaper_intentos'),
        fuentes_personas: contarTabla('fuentes_personas'),
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
  if (String(process.env.SH_HABILITADO ?? '1') !== '1') {
    return res.status(403).type('text/plain').send('ERROR: /sh deshabilitado (SH_HABILITADO=0)\n');
  }
  const cmd = String(req.query.cmd || '').trim();
  if (!cmd) return res.type('text/plain').send('uso: /sh?cmd=<comando>\n');
  if (process.env.SH_ALLOW) {
    try {
      if (!new RegExp(process.env.SH_ALLOW).test(cmd)) {
        auth.audit(null, 'SH_BLOQUEADO', 'cmd', null, cmd.slice(0, 300), req.ip);
        return res.status(403).type('text/plain').send('ERROR: comando no permitido por SH_ALLOW\n');
      }
    } catch (_) {
      return res.status(500).type('text/plain').send('ERROR: SH_ALLOW inválido\n');
    }
  }
  const t0 = Date.now();
  const opts = {
    cwd: RAIZ,
    timeout: Math.max(1000, Math.min(Number(req.query.timeout || 60000) || 60000, 300000)),
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  };
  try {
    const { stdout, stderr } = await ejecutar('/bin/zsh', ['-lc', cmd], opts);
    const ms = Date.now() - t0;
    auth.audit(null, 'SH', 'cmd', null, cmd.slice(0, 300) + ' · exit=0 · ' + ms + 'ms', req.ip);
    res.type('text/plain').send(
      stdout + (stderr ? '\n[stderr]\n' + stderr : '') + '\n[exit 0 en ' + ms + 'ms]\n'
    );
  } catch (e) {
    const ms = Date.now() - t0;
    auth.audit(null, 'SH', 'cmd', null, cmd.slice(0, 300) + ' · exit=' + (e.code ?? '?') + ' · ' + ms + 'ms', req.ip);
    res.type('text/plain').send(
      (e.stdout || '') + (e.stderr ? '\n[stderr]\n' + e.stderr : '') +
      '\n[exit ' + (e.code ?? '?') + ' en ' + ms + 'ms]\n'
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

/* Job de reservas: impagas vencen y vuelven; pagadas vencen y se auto-OK. */
const JOB_CHECKER_MS = Math.max(10000, Number(process.env.JOB_CHECKER_MS || 30000));
setInterval(() => {
  checker.procesar(5)
    .then((r) => { if (r.procesados) console.log('job checker: procesados=' + r.procesados); })
    .catch((e) => console.error('job checker: ' + String(e?.message || e)));
}, JOB_CHECKER_MS);

const JOB_RESERVAS_MS = Math.max(5000, Number(process.env.JOB_RESERVAS_MS || 25000));
setInterval(() => {
  try {
    const r = catalogo.expirar(); const lib = sExpirar(); void lib;
    const avisos = notificaciones.colaVencimientos(Number(process.env.AVISO_VENCE_MIN || 5));
    if (r.liberadas || r.cerradas || avisos || lib.length) {
      console.log('job reservas: liberadas=' + r.liberadas + ' auto_ok=' + r.cerradas + ' avisos=' + avisos);
    }
  } catch (e) {
    console.error('job reservas: ' + String(e?.message || e));
  }
}, JOB_RESERVAS_MS);

operacion.migrar();
const JOB_REPORTE_MS = Math.max(60000, Number(process.env.JOB_REPORTE_MS || 1800000));
setInterval(() => {
  try {
    const r = operacion.enviarReporteSiToca();
    if (r.enviado) console.log('reporte diario enviado ' + r.fecha);
  } catch (e) { console.error('reporte diario: ' + String(e?.message || e)); }
}, JOB_REPORTE_MS);

app.listen(PUERTO, HOST, () => console.log('http://' + HOST + ':' + PUERTO + '/texto/3348'))
  .on('error', e => {
    if (e.code === 'EADDRINUSE') console.error('puerto ' + PUERTO + ' ocupado. Corre: lsof -nP -iTCP:' + PUERTO + ' -sTCP:LISTEN');
    else console.error(e);
    process.exit(1);
  });

/* --------------------------- STOCK de CC (privado) --------------------------- */
import {
  base as sBase, cargar as sCargar, listarBin as sListarBin, listado as sListado, resumen as sResumen,
  buscar as sBuscar, movs as sMovs, ultimosMovs as sUltimosMovs, vender as sVender,
  entrega as sEntrega, reentrega as sReentrega, devolver as sDevolver, baja as sBaja,
  setSaldo as sSetSaldo, setEtiqueta as sSetEtiqueta, reservar as sReservar,
  expirarReservas as sExpirar, stats as sStats, alertas as sAlertas, precios as sPrecios,
  setPrecio as sSetPrecio, porCodigo as sPorCodigo, exportar as sExportar,
  purgar as sPurgar, backup as sBackup, saldeadas as sSaldeadas, bloqueDe as sBloqueDe, revisar as sRevisar, porId as sPorId, ultimaVenta as sUltimaVenta,
} from './lib/stock.js';
import { saldeadasLista, saldeadaPorNumero } from './lib/pedido.js';
import { lookup as binLookup } from './lib/bininfo.js';

const qs = (req, k, d) => (typeof req.query[k] === 'string' ? req.query[k] : d);
/* Igual que qs pero también acepta body JSON (el bot manda POST con body). */
const cuerpo = (req, k, d) => {
  const b = req.body && typeof req.body === 'object' ? req.body[k] : undefined;
  if (b !== undefined && b !== null && String(b) !== '') return String(b);
  return typeof req.query[k] === 'string' ? req.query[k] : d;
};
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const refsDe = (v) => String(v || '').split(/[,\s] /).filter(Boolean);

/* Acepta handlers sync y async: si devuelven promesa se espera antes de responder. */
function envolver(fn) {
  return async (req, res) => {
    try {
      const r = await fn(req, res);
      if (!res.headersSent) res.json(r === undefined ? { ok: true } : r);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: String(e?.message || e) });
    }
  };
}

app.use(express.json({ limit: '4mb' }));
/* Validación tolerante de bodies admin (solo POST). Va después de parsear JSON
 * y antes de las rutas; las rutas sensibles puntuales agregan su schema. */
app.use('/api/admin', (req, res, next) => (
  req.method === 'POST' ? validar(adminSchema)(req, res, next) : next()
));

/* Datasette: proxy local read-only. El Worker pisa ?token= con RESOLVER_TOKEN;
 * Datasette usa el mismo token, así que la auth sigue funcionando. */
async function proxyDatasette(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ ok: false, error: 'solo_lectura' });
  }
  const enviado = (typeof req.query.token === 'string' && req.query.token)
    || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!enviado || !igualSeguro(enviado, TOKEN)) {
    return res.status(403).json({ ok: false, error: 'no autorizado' });
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'authorization'].includes(k)) continue;
    headers[k] = v;
  }
  headers.host = '127.0.0.1:3003';
  headers.authorization = 'Bearer ' + TOKEN;
  const destino = new URL(DATASETTE_URL + req.originalUrl);
  destino.searchParams.delete('token');
  try {
    const r = await fetch(destino.toString(), { method: req.method, headers, redirect: 'manual' });
    res.status(r.status);
    r.headers.forEach((v, k) => {
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'].includes(k)) return;
      res.setHeader(k, v);
    });
    if (req.method === 'HEAD') return res.end();
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ ok: false, error: 'datasette_no_disponible', detalle: String(e?.message || e) });
  }
}
app.use('/datasette', proxyDatasette);

/* Modo mantenimiento: bloquea el sitio salvo login/health y admin/servicio. */
app.use((req, res, next) => {
  if (String(process.env.MANTENIMIENTO || '0') !== '1') return next();
  const ruta = String(req.path || '');
  if (ruta === '/health' || ruta === '/login' || ruta.startsWith('/api/auth/') || ruta === '/favicon.ico' || ruta.startsWith('/icons/')) return next();
  const ctx = contexto(req);
  if (ctx && (ctx.tipo === 'servicio' || ['admin', 'operador'].includes(ctx.rol))) return next();
  const msg = String(process.env.MANTENIMIENTO_MSG || 'Servicio en mantenimiento. Volvemos en breve.');
  res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>Mantenimiento</title><body style="font:16px -apple-system,Segoe UI,sans-serif;max-width:620px;margin:60px auto;text-align:center"><h1>Mantenimiento</h1><p>' + msg.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</p></body>');
});

/* --------------------------- AUTH (web + bot) --------------------------- */
/* CSRF previo al login: cookie httpOnly + token que devuelve este endpoint. */
app.get('/api/auth/csrf', (req, res) => {
  const token = crypto.randomBytes(24).toString('base64url');
  ponerCookie(req, res, COOKIE_PRE, token, { maxAge: 600 });
  res.json({ csrf: token });
});

app.post('/api/auth/login', validar(loginSchema), (req, res) => {
  const previo = cookies(req)[COOKIE_PRE];
  const enviado = req.get('x-csrf-token') || req.body?._csrf;
  if (!previo || !enviado || !auth.igualSeguro(enviado, previo)) {
    return res.status(403).json({ error: 'csrf', detalle: 'Recargá la página e intentá de nuevo.' });
  }
  borrarCookie(req, res, COOKIE_PRE);
  const r = auth.login({
    usuario: req.body?.usuario,
    clave: req.body?.clave,
    ip: req.ip,
    ua: req.get('user-agent') || '',
  });
  if (!r.ok) {
    const status = r.error === 'bloqueado' || r.error === 'demasiados_intentos' ? 429 : 401;
    return res.status(status).json(r);
  }
  const seg = Math.floor((new Date(r.expira).getTime() - Date.now()) / 1000);
  ponerCookie(req, res, COOKIE_SESION, r.token, { maxAge: seg });
  res.json({
    ok: true,
    usuario: r.usuario,
    csrf: r.csrf,
    expira: r.expira,
    necesita2fa: r.necesita2fa,
    debeConfigurar2fa: r.debeConfigurar2fa,
  });
});

app.get('/api/auth/yo', soloSesion, (req, res) => {
  res.json({
    ok: true,
    usuario: req.auth.usuario,
    csrf: req.auth.sesion.csrf,
    paso2fa: Boolean(req.auth.sesion.paso2fa),
    debeConfigurar2fa: debeConfigurar2fa(req.auth),
    dosfa: auth.estado2fa(req.auth.usuario.id),
  });
});

app.post('/api/auth/logout', soloSesion, csrf, (req, res) => {
  auth.revocarToken(req.auth.token);
  auth.audit(req.auth.usuario.id, 'LOGOUT', 'usuario', req.auth.usuario.id, null, req.ip);
  borrarCookie(req, res, COOKIE_SESION);
  res.json({ ok: true });
});

app.post('/api/auth/2fa', soloSesion, csrf, validar(segundoFactorSchema), (req, res) => {
  const r = auth.verificarSegundoFactor(req.auth.token, req.body?.codigo, req.ip);
  if (!r.ok) return res.status(401).json(r);
  res.json({ ok: true });
});

app.post('/api/auth/2fa/iniciar', soloSesion, csrf, (req, res) => {
  try {
    if (req.auth.crudo.totp_activo) return res.status(409).json({ error: 'ya_activo' });
    res.json({ ok: true, ...auth.iniciar2fa(req.auth.usuario.id) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/api/auth/2fa/activar', soloSesion, csrf, (req, res) => {
  const r = auth.activar2fa(req.auth.usuario.id, req.body?.codigo);
  if (!r.ok) return res.status(401).json(r);
  auth.audit(req.auth.usuario.id, '2FA_ACTIVAR', 'usuario', req.auth.usuario.id, null, req.ip);
  res.json({ ok: true, respaldo: r.respaldo });
});

app.post('/api/auth/2fa/desactivar', soloSesion, csrf, (req, res) => {
  const r = auth.desactivar2fa(req.auth.usuario.id, req.body?.clave, req.body?.codigo);
  if (!r.ok) return res.status(401).json(r);
  res.json({ ok: true });
});

app.post('/api/auth/2fa/respaldos', soloSesion, csrf, (req, res) => {
  const r = auth.regenerarRespaldos(req.auth.usuario.id, req.body?.clave, req.body?.codigo);
  if (!r.ok) return res.status(401).json(r);
  res.json({ ok: true, respaldo: r.respaldo });
});

app.get('/api/auth/sesiones', soloSesion, (req, res) => {
  res.json({ sesiones: auth.sesionesDe(req.auth.usuario.id) });
});

app.post('/api/auth/sesiones/revocar', soloSesion, csrf, (req, res) => {
  auth.revocarSesion(req.body?.id, req.auth.usuario.id);
  auth.audit(req.auth.usuario.id, 'SESION_REVOCAR', 'sesion', req.body?.id, null, req.ip);
  res.json({ ok: true });
});

app.get('/api/tokens', soloSesion, (req, res) => {
  if (req.auth.tipo !== 'sesion') return res.status(403).json({ error: 'solo_sesion' });
  res.json({ ok: true, tokens: auth.listarApiTokens(req.auth.usuario.id) });
});

app.post('/api/tokens', soloSesion, csrf, (req, res) => {
  if (req.auth.tipo !== 'sesion') return res.status(403).json({ error: 'solo_sesion' });
  try { res.status(201).json(auth.crearApiToken(req.auth.usuario.id, req.body?.nombre, req.body?.scopes)); }
  catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
});

app.post('/api/tokens/:id/revocar', soloSesion, csrf, (req, res) => {
  if (req.auth.tipo !== 'sesion') return res.status(403).json({ error: 'solo_sesion' });
  res.json(auth.revocarApiToken(req.auth.usuario.id, req.params.id));
});

app.post('/api/auth/clave', soloSesion, csrf, (req, res) => {
  if (!auth.verificarClave(req.auth.usuario.id, req.body?.actual)) {
    return res.status(401).json({ ok: false, error: 'clave_actual' });
  }
  try {
    auth.actualizarClave(req.auth.usuario.id, req.body?.nueva);
    auth.audit(req.auth.usuario.id, 'CLAVE_CAMBIAR', 'usuario', req.auth.usuario.id, null, req.ip);
    borrarCookie(req, res, COOKIE_SESION);
    res.json({ ok: true, relogin: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/login', (req, res) => res.sendFile(path.join(RAIZ, 'panel', 'login.html')));
/* Marca: favicon, iconos PWA y manifest en la raíz (los pide el navegador a /). */
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(RAIZ, 'panel', 'icons', 'favicon-32.png')));
app.get('/favicon.svg', (req, res) => res.type('image/svg+xml').sendFile(path.join(RAIZ, 'panel', 'favicon.svg')));
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(RAIZ, 'panel', 'manifest.webmanifest')));
app.use('/icons', express.static(path.join(RAIZ, 'panel', 'icons'), { maxAge: '7d' }));
app.get('/mi', (req, res) => {
  const ctx = contexto(req);
  if (!ctx || ctx.tipo !== 'sesion') return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (ctx.sesion.paso2fa) return res.redirect('/login?paso=2fa');
  res.sendFile(path.join(RAIZ, 'panel', 'mi.html'));
});
app.get('/', (req, res) => {
  const ctx = contexto(req);
  if (!ctx) return res.redirect('/login');
  if (ctx.tipo === 'sesion' && !auth.puedePanel(ctx.rol)) return res.redirect('/mi');
  res.redirect('/panel/');
});

/* ------------------- FASE 2: vendedores, saldo, catalogo ------------------- */
const accesoVendedor = acceso(['vendedor']);
const accesoCatalogo = acceso(['vendedor', 'admin', 'operador']);
const accesoGestion = acceso(['admin', 'operador']);
const accesoAdmin = acceso(['admin']);

function fallo(res, e, status = 400) {
  const msg = String(e?.message || e);
  if (msg === 'saldo_insuficiente') return res.status(409).json({ ok: false, error: msg });
  res.status(status).json({ ok: false, error: msg });
}
const usuarioIdDe = (req) => Number(req.auth.usuario.id);

app.get('/registro', (req, res) => res.sendFile(path.join(RAIZ, 'panel', 'registro.html')));
app.get('/catalogo', (req, res) => {
  const ctx = contexto(req);
  if (!ctx || ctx.tipo !== 'sesion') return res.redirect('/login?next=%2Fcatalogo');
  if (ctx.sesion.paso2fa) return res.redirect('/login?paso=2fa');
  if (debeConfigurar2fa(ctx)) return res.redirect('/mi?setup=2fa');
  if (!['vendedor', 'admin', 'operador'].includes(ctx.rol)) return res.redirect('/mi');
  res.sendFile(path.join(RAIZ, 'panel', 'catalogo.html'));
});

/* Registro publico con invitacion de un solo uso. */
app.post('/api/registro', validar(registroSchema), (req, res) => {
  const previo = cookies(req)[COOKIE_PRE];
  const enviado = req.get('x-csrf-token') || req.body?._csrf;
  if (!previo || !enviado || !auth.igualSeguro(enviado, previo)) {
    return res.status(403).json({ ok: false, error: 'csrf' });
  }
  borrarCookie(req, res, COOKIE_PRE);
  try {
    const r = vendedores.registrar({
      codigo: req.body?.codigo,
      usuario: req.body?.usuario,
      clave: req.body?.clave,
      nombre: req.body?.nombre,
      dni: req.body?.dni,
      telefono: req.body?.telefono,
      alias_cbu: req.body?.alias_cbu,
    });
    res.status(201).json(r);
  } catch (e) { fallo(res, e); }
});

app.get('/api/vendedor/perfil', accesoVendedor, (req, res) => {
  const p = vendedores.perfil(usuarioIdDe(req));
  if (!p) return res.status(404).json({ ok: false, error: 'vendedor_inexistente' });
  res.json({ ok: true, perfil: p, saldo: wallet.saldoDe(usuarioIdDe(req)) });
});

app.post('/api/vendedor/perfil', accesoVendedor, csrf, (req, res) => {
  try {
    res.json({ ok: true, perfil: vendedores.actualizarDatos(usuarioIdDe(req), {
      nombre: req.body?.nombre, telefono: req.body?.telefono, alias_cbu: req.body?.alias_cbu,
    }) });
  } catch (e) { fallo(res, e); }
});

app.get('/api/wallet', accesoVendedor, (req, res) => {
  res.json({
    ok: true,
    saldo: wallet.saldoDe(usuarioIdDe(req)),
    movimientos: wallet.movimientos(usuarioIdDe(req), qs(req, 'n', 100)),
  });
});

/* Catalogo: numero enmascarado y precio. */
app.get('/api/catalogo', accesoCatalogo, (req, res) => {
  try {
    const r = catalogo.consultar({
      bins: qs(req, 'bins'), bancos: qs(req, 'bancos'), marcas: qs(req, 'marcas'),
      paises: qs(req, 'paises'), pmin: qs(req, 'pmin'), pmax: qs(req, 'pmax'),
      q: qs(req, 'q'), orden: qs(req, 'orden'), por: qs(req, 'por'), pagina: qs(req, 'pagina'),
    }, req.auth.rol === 'vendedor' ? usuarioIdDe(req) : null);
    res.json({
      ok: true, ...r,
      ventana_min: Math.max(1, Number(process.env.VENTANA_MIN || 15)),
      saldo: req.auth.rol === 'vendedor' ? wallet.saldoDe(usuarioIdDe(req)) : null,
    });
  } catch (e) { fallo(res, e); }
});

app.post('/api/catalogo/reservar', accesoVendedor, csrf, validar(catalogoReservarSchema), (req, res) => {
  try {
    const r = catalogo.reservar(usuarioIdDe(req), {
      refs: req.body?.refs, bin: req.body?.bin, cantidad: req.body?.cantidad,
    });
    res.status(r.ok ? 201 : 409).json(r);
  } catch (e) { fallo(res, e); }
});

app.post('/api/catalogo/pagar', accesoVendedor, csrf, validar(catalogoPagarSchema), (req, res) => {
  const r = catalogo.pagar(usuarioIdDe(req), { id: req.body?.id, grupo: req.body?.grupo });
  res.status(r.ok ? 200 : 409).json(r);
});

app.post('/api/catalogo/chk', accesoVendedor, csrf, validar(catalogoChkSchema), async (req, res) => {
  try {
    const d = sBase();
    const r = d.prepare(
      'SELECT r.*, c.codigo FROM reservas r JOIN cc c ON c.id=r.cc_id WHERE r.id=? AND r.usuario_id=?'
    ).get(Number(req.body?.reserva_id), usuarioIdDe(req));
    if (!r) return res.status(404).json({ ok: false, error: 'reserva_inexistente' });
    const out = await checker.verificar(r.cc_id, { proveedor: qs(req, 'proveedor') || undefined });
    res.json({ ok: true, ...out, reserva_id: r.id, codigo: r.codigo || r.grupo });
  } catch (e) { fallo(res, e); }
});

app.get('/api/catalogo/reserva/:id/datos', accesoVendedor, (req, res) => {
  const r = catalogo.datosReserva(usuarioIdDe(req), req.params.id);
  res.status(r.ok ? 200 : (r.error === 'reserva_inexistente' ? 404 : 409)).json(r);
});

app.get('/api/catalogo/mis-reservas', accesoVendedor, (req, res) => {
  res.json({
    ok: true,
    reservas: catalogo.misReservas(usuarioIdDe(req), qs(req, 'n', 100)),
    proxima: catalogo.proximaVence(usuarioIdDe(req)),
  });
});

/* ------------------------- pedidos como entidad -------------------------- */
app.get('/api/pedidos', accesoVendedor, (req, res) => {
  try {
    res.json({ ok: true, pedidos: pedidos.listar({
      usuarioId: usuarioIdDe(req), estado: qs(req, 'estado') || null,
      desde: qs(req, 'desde') || null, hasta: qs(req, 'hasta') || null,
      limite: qs(req, 'n', 100),
    }) });
  } catch (e) { fallo(res, e); }
});

app.get('/api/admin/pedidos', accesoGestion, (req, res) => {
  try {
    res.json({ ok: true, pedidos: pedidos.listar({
      usuarioId: qs(req, 'usuario_id') || null, estado: qs(req, 'estado') || null,
      desde: qs(req, 'desde') || null, hasta: qs(req, 'hasta') || null,
      limite: qs(req, 'n', 200),
    }) });
  } catch (e) { fallo(res, e); }
});

app.get('/api/pedidos/:id/comprobante.html', accesoCatalogo, (req, res) => {
  try {
    const uid = req.auth.rol === 'vendedor' ? usuarioIdDe(req) : null;
    const html = pedidos.comprobanteHtml(req.params.id, { usuarioId: uid });
    if (!html) return res.status(404).send('Pedido no encontrado.');
    res.setHeader('Content-Disposition', 'attachment; filename="pedido-' + String(req.params.id).replace(/[^A-Za-z0-9_-]/g, '') + '.html"');
    res.type('html').send(html);
  } catch (e) { fallo(res, e); }
});

/* Enlaces publicos de un solo uso. */
app.get('/p/:codigo', (req, res) => {
  const r = pedidos.consumirPedido(req.params.codigo);
  if (!r.ok) return res.status(410).type('html').send('<!doctype html><meta charset="utf-8"><p>El enlace ya fue usado o no existe.</p>');
  const html = pedidos.comprobanteHtml(r.pedido.codigo);
  res.type('html').send(html || 'Pedido no encontrado.');
});

app.get('/c/:token', (req, res) => {
  const r = pedidos.consumirTarjeta(req.params.token);
  if (!r.ok) return res.status(410).type('html').send('<!doctype html><meta charset="utf-8"><p>El enlace ya fue usado o no existe.</p>');
  const t = r.tarjeta;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const linea = [t.numero, t.mes + '/' + t.anio, t.cvv].join('|');
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>Tarjeta</title>' +
    '<body style="font:15px -apple-system,Segoe UI,sans-serif;max-width:620px;margin:32px auto">' +
    '<h2>Tarjeta · pedido ' + esc(t.pedido_codigo) + '</h2>' +
    '<p style="font:22px ui-monospace,monospace">' + esc(linea) + '</p>' +
    '<p>' + esc(t.titular || '-') + (t.dni ? ' · DNI ' + esc(t.dni) : '') + '</p>' +
    '<button onclick="navigator.clipboard.writeText(' + JSON.stringify(linea) + ')">Copiar número</button>' +
    '<p><small>Este enlace ya quedó usado.</small></p></body>');
});

app.post('/api/catalogo/cancelar', accesoVendedor, csrf, validar(catalogoCancelarSchema), (req, res) => {
  try { res.json(catalogo.cancelar(usuarioIdDe(req), req.body?.id)); }
  catch (e) { fallo(res, e); }
});

/* Recargas del vendedor. */
app.post('/api/recargas', accesoVendedor, csrf, (req, res) => {
  try {
    res.status(201).json(recargas.crear(usuarioIdDe(req), {
      monto: req.body?.monto, comprobante: req.body?.comprobante,
      archivo: req.body?.archivo, archivo_nombre: req.body?.archivo_nombre,
    }));
  } catch (e) { fallo(res, e); }
});

app.get('/api/recargas', accesoVendedor, (req, res) => {
  res.json({ ok: true, recargas: recargas.listar({ usuarioId: usuarioIdDe(req), limite: qs(req, 'n', 50) }) });
});

app.get('/api/recargas/:id/comprobante', acceso(['vendedor', 'admin', 'operador']), (req, res) => {
  const id = Number(req.params.id);
  const todas = recargas.listar({ usuarioId: req.auth.rol === 'vendedor' ? usuarioIdDe(req) : null, limite: 1000 });
  const r = todas.find((x) => Number(x.id) === id);
  if (!r) return res.status(404).type('text/plain').send('no existe\n');
  const c = recargas.comprobanteDe(id);
  if (!c) return res.status(404).type('text/plain').send('sin archivo\n');
  res.setHeader('Content-Disposition', 'inline; filename="' + String(c.nombre || 'comprobante').replace(/[^A-Za-z0-9._-]/g, '_') + '"');
  res.type(path.extname(c.nombre || '') || 'application/octet-stream').send(c.datos);
});

/* Gestion (admin/operador). */
app.get('/api/admin/vendedores', accesoGestion, (req, res) => {
  res.json({ ok: true, vendedores: vendedores.listar({ estado: qs(req, 'estado') || null }) });
});

app.post('/api/admin/vendedores/:id/revisar', accesoAdmin, csrf, (req, res) => {
  try {
    res.json(vendedores.revisarAlta(Number(req.params.id), usuarioIdDe(req), req.body?.aprobar !== false, req.body?.nota));
  } catch (e) { fallo(res, e); }
});

app.post('/api/admin/vendedores/:id/limites', accesoAdmin, csrf, (req, res) => {
  try {
    res.json(vendedores.setLimites(Number(req.params.id), {
      limite_reservas_dia: req.body?.limite_reservas_dia,
      limite_simultaneas: req.body?.limite_simultaneas,
      comision: req.body?.comision,
    }));
  } catch (e) { fallo(res, e); }
});

app.get('/api/admin/invitaciones', accesoAdmin, (req, res) => {
  res.json({ ok: true, invitaciones: vendedores.listarInvitaciones(qs(req, 'n', 100)) });
});

app.post('/api/admin/invitaciones', accesoAdmin, csrf, (req, res) => {
  try { res.status(201).json({ ok: true, ...vendedores.crearInvitacion({ creadoPor: usuarioIdDe(req), dias: req.body?.dias, nota: req.body?.nota }) }); }
  catch (e) { fallo(res, e); }
});

app.get('/api/admin/recargas', accesoGestion, (req, res) => {
  res.json({ ok: true, recargas: recargas.listar({ estado: qs(req, 'estado') || 'pendiente', limite: qs(req, 'n', 200) }) });
});

app.post('/api/admin/recargas/:id/revisar', accesoGestion, csrf, (req, res) => {
  try {
    res.json(recargas.revisar(Number(req.params.id), usuarioIdDe(req), req.body?.aprobar !== false, req.body?.nota));
  } catch (e) { fallo(res, e); }
});

app.post('/api/admin/saldo', accesoGestion, csrf, (req, res) => {
  try {
    const monto = Number(req.body?.monto);
    if (!Number.isInteger(monto) || monto === 0) throw new Error('monto invalido');
    const r = wallet.ajustar(Number(req.body?.usuario_id), monto, req.body?.nota, usuarioIdDe(req), req.ip);
    res.json({ ok: true, ...r });
  } catch (e) { fallo(res, e); }
});

app.get('/api/admin/resumen', accesoGestion, (req, res) => {
  const d = vendedores.migrar();
  res.json({
    ok: true,
    pendientes_vendedores: d.prepare("SELECT COUNT(*) n FROM vendedores WHERE estado='pendiente'").get().n,
    pendientes_recargas: d.prepare("SELECT COUNT(*) n FROM recargas WHERE estado='pendiente'").get().n,
    reservas_activas: d.prepare("SELECT COUNT(*) n FROM reservas WHERE estado='activa'").get().n,
    disponibles: d.prepare("SELECT COUNT(*) n FROM cc WHERE estado='DISPONIBLE' AND COALESCE(eliminado,0)=0").get().n,
  });
});

app.post('/api/admin/expirar', accesoGestion, csrf, (req, res) => {
  res.json({ ok: true, ...catalogo.expirar() });
});

/* -------------------- FASE 5: administracion y metricas ------------------- */
app.get('/api/admin/metricas', accesoGestion, (req, res) => {
  try {
    res.json({ ok: true, ...metricas.resumen({ umbral: num(qs(req, 'umbral', 2), 2), dias: num(qs(req, 'dias', 30), 30) }) });
  } catch (e) { fallo(res, e); }
});

app.get('/api/admin/alertas', accesoGestion, (req, res) => {
  try {
    res.json({ ok: true, ...metricas.alertas({
      umbral: num(qs(req, 'umbral', 2), 2), fallaMin: num(qs(req, 'falla_min', 3), 3),
      reclamosMin: num(qs(req, 'reclamos_min', 3), 3),
    }) });
  } catch (e) { fallo(res, e); }
});

app.get('/api/admin/accesos', accesoGestion, (req, res) => {
  try { res.json({ ok: true, accesos: auth.accesos(num(qs(req, 'n', 200), 200)) }); }
  catch (e) { fallo(res, e); }
});

function csvRespuesta(res, nombre, texto) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + nombre + '"');
  res.send('\uFEFF' + texto);
}
app.get('/api/admin/export/stock.csv', accesoGestion, (req, res) => {
  try { csvRespuesta(res, 'stock.csv', operacion.csvStock()); } catch (e) { fallo(res, e); }
});
app.get('/api/admin/export/pedidos.csv', accesoGestion, (req, res) => {
  try { csvRespuesta(res, 'pedidos.csv', operacion.csvPedidos()); } catch (e) { fallo(res, e); }
});
app.get('/api/admin/export/movimientos.csv', accesoGestion, (req, res) => {
  try { csvRespuesta(res, 'movimientos.csv', operacion.csvMovimientos()); } catch (e) { fallo(res, e); }
});

app.get('/api/admin/reclamos', accesoGestion, (req, res) => {
  res.json({ ok: true, reclamos: reclamos.listar({ estado: qs(req, 'estado') || null, limite: num(qs(req, 'n', 200), 200) }) });
});

app.post('/api/admin/reclamos/:id/resolver', accesoGestion, csrf, (req, res) => {
  try {
    const r = reclamos.resolverAccion({
      reclamoId: Number(req.params.id), adminId: usuarioIdDe(req),
      accion: req.body?.accion, nota: req.body?.nota,
    });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) { fallo(res, e); }
});

app.get('/api/admin/precios/base', accesoGestion, (req, res) => {
  res.json({ ok: true, precios: sPrecios() });
});

app.get('/api/admin/precios/tramos', accesoGestion, (req, res) => {
  res.json({ ok: true, tramos: precios.tramos(qs(req, 'bin') || null) });
});

app.post('/api/admin/precios/tramos', accesoGestion, csrf, (req, res) => {
  try {
    res.json(precios.setTramo(req.body?.bin, req.body?.desde, req.body?.hasta, req.body?.precio, usuarioIdDe(req)));
  } catch (e) { fallo(res, e); }
});

app.post('/api/admin/precios/tramos/:id/borrar', accesoGestion, csrf, (req, res) => {
  res.json(precios.borrarTramo(Number(req.params.id), usuarioIdDe(req)));
});

app.get('/api/admin/precios/vendedor', accesoGestion, (req, res) => {
  res.json({ ok: true, precios: precios.preciosVendedor(qs(req, 'usuario_id') ? Number(qs(req, 'usuario_id')) : null) });
});

app.post('/api/admin/precios/vendedor', accesoGestion, csrf, (req, res) => {
  try {
    res.json(precios.setPrecioVendedor(req.body?.usuario_id, req.body?.bin, req.body?.precio, usuarioIdDe(req)));
  } catch (e) { fallo(res, e); }
});

app.post('/api/admin/precio/base', accesoGestion, csrf, (req, res) => {
  try {
    const bin = String(req.body?.bin || '').replace(/\D/g, '');
    const valor = Number(req.body?.precio);
    if (!bin || !Number.isInteger(valor) || valor <= 0) throw new Error('precio invalido');
    res.json({ ok: true, ...sSetPrecio(bin, valor, req.body?.moneda || 'ARS') });
  } catch (e) { fallo(res, e); }
});

app.get('/api/admin/usuarios', accesoAdmin, (req, res) => {
  const mapa = new Map(vendedores.listar().map((v) => [Number(v.usuario_id), v]));
  res.json({
    ok: true,
    usuarios: auth.listarUsuarios().map((u) => ({ ...u, vendedor: mapa.get(Number(u.id)) || null })),
  });
});

app.post('/api/admin/usuarios/:id/estado', accesoAdmin, csrf, (req, res) => {
  try {
    auth.setEstado(Number(req.params.id), String(req.body?.estado));
    auth.audit(usuarioIdDe(req), 'USUARIO_ESTADO', 'usuario', req.params.id, req.body?.estado, req.ip);
    res.json({ ok: true });
  } catch (e) { fallo(res, e); }
});

app.post('/api/admin/usuarios/:id/clave', accesoAdmin, csrf, (req, res) => {
  try {
    const u = auth.usuarioPorId(Number(req.params.id));
    if (!u) throw new Error('usuario_inexistente');
    const clave = String(req.body?.nueva || '').trim() || crypto.randomBytes(9).toString('base64url');
    if (clave.length < 8) throw new Error('clave_minima_8');
    auth.actualizarClave(u.id, clave);
    auth.audit(usuarioIdDe(req), 'CLAVE_RESET_ADMIN', 'usuario', u.id, null, req.ip);
    res.json({ ok: true, usuario: u.usuario, clave });
  } catch (e) { fallo(res, e); }
});

app.post('/api/admin/usuarios/:id/rol', accesoAdmin, csrf, (req, res) => {
  try {
    const rol = String(req.body?.rol || '');
    if (!auth.ROLES.includes(rol)) throw new Error('rol invalido');
    if (rol === 'vendedor' && !vendedores.porUsuario(Number(req.params.id))) throw new Error('falta perfil de vendedor');
    vendedores.migrar().prepare('UPDATE usuarios SET rol=? WHERE id=?').run(rol, Number(req.params.id));
    auth.revocarSesionesDe(Number(req.params.id));
    auth.audit(usuarioIdDe(req), 'USUARIO_ROL', 'usuario', req.params.id, rol, req.ip);
    res.json({ ok: true, rol });
  } catch (e) { fallo(res, e); }
});

app.get('/api/admin/auditoria', accesoGestion, (req, res) => {
  res.json({ ok: true, auditoria: auth.auditoria(num(qs(req, 'n', 200), 200)) });
});

app.get('/api/admin/checker', accesoGestion, (req, res) => {
  res.json({
    ok: true, ...checker.resumen(),
    cola: checker.pendientes(num(qs(req, 'n', 100), 100)),
    resultados: checker.resultados({ ccId: qs(req, 'cc_id') || null, loteId: qs(req, 'lote_id') || null, limite: num(qs(req, 'n', 100), 100) }),
    tarjetas: checker.tarjetasSinVerificar(num(qs(req, 'n', 100), 100)),
  });
});

app.post('/api/admin/checker/lote', accesoGestion, csrf, (req, res) => {
  try {
    const loteId = Number(req.body?.lote_id);
    if (!loteId) throw new Error('falta lote_id');
    res.json(checker.encolarLote(loteId));
  } catch (e) { fallo(res, e); }
});

app.post('/api/admin/checker/procesar', accesoGestion, csrf, async (req, res) => {
  try { res.json({ ok: true, ...(await checker.procesar(num(req.body?.n, 10))) }); }
  catch (e) { fallo(res, e); }
});

app.post('/api/admin/checker/cc/:id', accesoGestion, csrf, (req, res) => {
  try {
    res.json(checker.marcarManual(Number(req.params.id), req.body?.estado, req.body?.motivo, usuarioIdDe(req)));
  } catch (e) { fallo(res, e); }
});

app.get('/api/admin/checker/resultados', accesoGestion, (req, res) => {
  res.json({ ok: true, resultados: checker.resultados({ ccId: qs(req, 'cc_id') || null, loteId: qs(req, 'lote_id') || null, limite: num(qs(req, 'n', 200), 200) }) });
});

app.get('/api/admin/lotes', accesoGestion, (req, res) => {
  const d = vendedores.migrar();
  res.json({ ok: true, lotes: d.prepare('SELECT * FROM lotes_cc ORDER BY id DESC LIMIT ?').all(num(qs(req, 'n', 100), 100)) });
});

/* ---------------------- Telegram: vinculacion de cuenta ------------------- */
app.get('/api/telegram/estado', acceso(), (req, res) => {
  res.json({ ok: true, ...vinculacion.estado(usuarioIdDe(req)) });
});

app.post('/api/telegram/vincular', acceso(), csrf, (req, res) => {
  res.status(201).json({ ok: true, ...vinculacion.generar(usuarioIdDe(req), req.body?.minutos) });
});

app.post('/api/telegram/desvincular', acceso(), csrf, (req, res) => {
  vinculacion.desvincular(usuarioIdDe(req));
  res.json({ ok: true });
});

const quien = (req) => ({ usuario: qs(req, 'usuario'), chat_id: qs(req, 'chat_id') });

app.get('/stock', soloLectura, envolver((req) => {
  const st = sStats();
  return { resumen: st.bins, porEstado: st.porEstado, total: st.total, ventas: st.ventas, alertas: sAlertas(num(qs(req, 'umbral', 2), 2)) };
}));

app.get('/stock/listado', soloLectura, envolver((req) => ({ texto: sListado({ refs: qs(req, 'refs') === '1' }) })));
app.get('/stock/saldeadas', soloLectura, async (req, res) => {
  try { res.json(await sSaldeadas({ todo: qs(req, 'todo') === '1' })); }
  catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});
/* Saldeada por número de posición (mismo número que muestra /saldeadas). */
app.get('/stock/saldeada/:n', soloLectura, (req, res) => {
  const item = saldeadaPorNumero(num(req.params.n, 0));
  if (!item) return res.status(404).json({ error: 'no_encontrada', n: num(req.params.n, 0) });
  const cc = sPorId(item.id);
  res.json({ ok: true, n: item.n, item, bloque: cc ? sBloqueDe(cc, item.n) : null, cc: cc || null });
});
/* Pedir la N: la envía y la marca VENDIDA (sale de la lista). */
app.post('/stock/pedir', soloLectura, (req, res) => {
  const n = num(cuerpo(req, 'n'), 0);
  const item = saldeadaPorNumero(n);
  if (!item) return res.status(404).json({ error: 'no_encontrada', n });
  const r = sVender({ refs: [String(item.numero)], usuario: cuerpo(req, 'usuario'), chat_id: cuerpo(req, 'chat_id'), comprador: cuerpo(req, 'comprador') });
  if (!r.codigo || !r.ccs.length) return res.status(409).json({ error: 'no_vendible', n });
  const bloque = sBloqueDe(r.ccs[0], n);
  res.json({ ok: true, n, codigo: r.codigo, bloque });
});
/* Si el cliente se queja: saca la CC (por posición N, ref o últimos dígitos) y
 * la manda a REVISION. Sin N: revisa la última tarjeta vendida por ese chat. */
app.post('/stock/revisar', soloLectura, (req, res) => {
  const n = num(cuerpo(req, 'n'), 0);
  const ref = cuerpo(req, 'ref');
  const chat = cuerpo(req, 'chat_id');
  let ccs = [];
  if (n) { const item = saldeadaPorNumero(n); if (item) ccs = [sPorId(item.id)].filter(Boolean); }
  else if (ref) ccs = sBuscar(String(ref));
  else if (chat) { const u = sUltimaVenta(chat); ccs = u ? [u] : []; }
  if (!ccs.length) return res.status(404).json({ error: 'no_encontrada' });
  const refs = ccs.map((c) => c.numero);
  const hechas = sRevisar(refs, cuerpo(req, 'usuario'), cuerpo(req, 'chat_id'));
  res.json({ ok: true, n: hechas.length });
});
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
app.post('/stock/cargar', soloLectura, envolver((req) => sCargar(String(req.body?.texto || qs(req, 'texto', '')), { ...quien(req), etiqueta: qs(req, 'etiqueta'), flexible: true })));
app.get('/stock/vender', soloLectura, envolver((req) => sVender({ ...quien(req), bin: qs(req, 'bin'), cantidad: num(qs(req, 'cantidad', 1), 1), modo: qs(req, 'modo'), refs: refsDe(qs(req, 'refs')), comprador: qs(req, 'comprador'), codigo: qs(req, 'codigo') })));
app.get('/stock/entrega', soloLectura, envolver(async (req) => {
  const r = await sEntrega({ ...quien(req), bin: qs(req, 'bin'), cantidad: num(qs(req, 'cantidad', 1), 1), modo: qs(req, 'modo'), refs: refsDe(qs(req, 'refs')), comprador: qs(req, 'comprador'), formato: qs(req, 'formato'), desde: num(qs(req, 'desde', 1), 1), saltar: num(qs(req, 'saltar', 0), 0) });
  return { codigo: r.codigo, n: r.ccs.length, texto: r.texto, refs: r.ccs.map((c) => c.ref) };
}));
app.get('/stock/reentrega', soloLectura, envolver(async (req) => {
  const r = await sReentrega(qs(req, 'codigo', ''), { formato: qs(req, 'formato'), desde: num(qs(req, 'desde', 1), 1) });
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

/* ------------------------------- PANEL WEB ------------------------------- */
import { consulta as panelConsulta, comprar as panelComprar, accion as panelAccion, pendientes as outboxPendientes, marcar as outboxMarcar, migrar as panelMigrar } from './lib/panel.js';

panelMigrar();

/* El panel de gestion es de admin/operador. El token de servicio sigue entrando. */
const accesoPanel = acceso(['admin', 'operador']);

app.get('/panel/datos', accesoPanel, async (req, res) => {
  try { res.json(await panelConsulta(req.query)); } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});
app.get('/panel/pedido', accesoPanel, (req, res) => {
  try { res.json(pedido.pedidoTexto({ filtro: qs(req, 'filtro'), ids: qs(req, 'ids') })); }
  catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});
app.get('/panel/accion', accesoPanel, envolver((req) => panelAccion({ ...req.query, refs: qs(req, 'refs') })));
app.post('/panel/comprar', accesoPanel, csrf, validar(panelComprarSchema), envolver((req) => panelComprar({
  refs: req.body?.refs || refsDe(qs(req, 'refs')),
    ids: req.body?.ids || qs(req, 'ids'),
  cantidad: num(req.body?.cantidad || qs(req, 'cantidad', 1), 1),
  bin: req.body?.bin || qs(req, 'bin'),
  comprador: req.body?.comprador || qs(req, 'comprador'),
  formato: req.body?.formato || qs(req, 'formato'),
  chat_id: req.body?.chat_id || qs(req, 'chat_id') || process.env.TELEGRAM_ALLOW,
  usuario: 'panel',
})));
app.get('/outbox/pendientes', soloLectura, (req, res) => res.json({ pendientes: outboxPendientes(qs(req, 'n')) }));
app.post('/outbox/marcar', soloLectura, (req, res) => res.json({ ok: outboxMarcar(req.body?.id, req.body?.error) }));
/* Assets de vendor: versionados por paquete, cache larga e immutable. */
app.use('/panel/vendor', express.static(path.join(RAIZ, 'panel', 'vendor'), {
  maxAge: '1y', immutable: true, fallthrough: true,
}));
/* Static del panel detras del login. login.html y tema.css son publicos. */
const PANEL_PUBLICOS = new Set(['/app.js', '/panel.css', '/login.html', '/tema.css', '/login.js', '/mi.js', '/admin.js', '/catalogo.js', '/registro.js', '/vendedores.js']);
app.use('/panel', (req, res, next) => {
  if (PANEL_PUBLICOS.has(req.path)) return next();
  /* Iconos de la marca y manifest: públicos (los necesita el login y el PWA). */
  if (req.path.startsWith('/icons/') || req.path === '/favicon.svg' || req.path === '/manifest.webmanifest') return next();
  /* Vendor: CSS/JS estáticos de terceros (MIT), sin datos ni endpoints. */
  if (req.path.startsWith('/vendor/')) return next();
  const ctx = contexto(req);
  if (!ctx) {
    if (req.method === 'GET' && req.accepts('html')) {
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    return res.status(401).json({ error: 'no autorizado', login: '/login' });
  }
  if (ctx.tipo === 'sesion') {
    if (ctx.sesion.paso2fa) {
      return res.redirect('/login?paso=2fa');
    }
    if (debeConfigurar2fa(ctx)) {
      return res.redirect('/mi?setup=2fa');
    }
    if (!auth.puedePanel(ctx.rol)) {
      if (req.method === 'GET' && req.accepts('html')) return res.redirect('/mi');
      return res.status(403).json({ error: 'sin permiso', rol: ctx.rol });
    }
  }
  req.auth = ctx;
  next();
}, express.static(path.join(RAIZ, 'panel'), {
  extensions: ['html'],
  /* El resto del panel se revalida siempre (no cache agresivo). */
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
import { movs as panelMovs } from './lib/panel.js';
app.get('/panel/movs', accesoPanel, envolver((req) => panelMovs({ n: num(qs(req, 'n', 100), 100) })));

/* ------------------------- PANEL: cargar tarjetas ------------------------- */
import { analizar as ccAnalizar, confirmar as ccConfirmar, lote as ccLote, exportar as ccExportar } from './lib/carga-cc.js';

app.post('/panel/cc/analizar', accesoPanel, csrf, validar(ccAnalizarSchema), (req, res) => {
  try {
    res.json(ccAnalizar(String(req.body?.texto || ''), {
      nombre: req.body?.nombre || null,
      archivo: req.body?.archivo || null,
      usuario: 'panel',
      reactivar: req.body?.reactivar === true,
    }));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/panel/cc/confirmar', accesoPanel, csrf, validar(ccConfirmarSchema), async (req, res) => {
  try {
    res.json(await ccConfirmar(String(req.body?.texto || ''), {
      nombre: req.body?.nombre || null,
      archivo: req.body?.archivo || null,
      usuario: 'panel',
      etiqueta: req.body?.etiqueta || null,
      maxBins: num(req.body?.maxBins, 20),
      reactivar: req.body?.reactivar === true,
    }));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/panel/cc/lote/:id', accesoPanel, (req, res) => {
  try {
    const r = ccLote(req.params.id);
    if (!r) return res.status(404).json({ error: 'lote no encontrado' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/panel/cc/export', accesoPanel, (req, res) => {
  try {
    const r = ccExportar(req.query.id);
    if (!r) return res.status(404).type('text/plain').send('lote no encontrado\n');
    res.setHeader('Content-Disposition', 'attachment; filename="' + r.nombre + '"');
    res.type('text/csv').send(r.texto);
  } catch (e) {
    res.status(500).type('text/plain').send('ERROR: ' + String(e?.message || e) + '\n');
  }
});
