/* argos.js - fuente real ARGOS (RENAPER   base local). Solo HTTP, por IP whitelisteada.
 * Nunca lanza: devuelve {fuente:'AUSENTE', motivo}.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as gordo from './gordo.js';

export const BASE = process.env.ARGOS_BASE || 'http://104.234.7.128:5100';
export const TTL_DIAS = Number(process.env.ARGOS_TTL_DIAS || 30);
const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_DB = process.env.RESOLVER_DB || path.join(RAIZ, 'datos', 'padron.db');
const RUTA_PDF = path.join(RAIZ, 'datos', 'argos');
const RUTA_LOG = path.join(RAIZ, 'datos', 'argos.log');
let db = null;

function abrir() {
  if (db) return db;
  fs.mkdirSync(path.dirname(RUTA_DB), { recursive: true });
  db = new DatabaseSync(RUTA_DB);
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec('CREATE TABLE IF NOT EXISTS argos(dni TEXT PRIMARY KEY, fuente TEXT, json TEXT, capturado TEXT, ttl_dias INTEGER)');
  db.exec('CREATE TABLE IF NOT EXISTS argos_intentos(dni TEXT PRIMARY KEY, intentos INTEGER, ultimo TEXT, motivo TEXT)');
  /* KV chico para estado que tiene que sobrevivir al restart (hoy: bloqueos).
   * OJO EL ORDEN: la tabla se crea ANTES de cargarBloqueos(), si no la query
   * falla y el catch silencioso la esconde (el bloqueo no se cargaba nunca). */
  db.exec('CREATE TABLE IF NOT EXISTS cache_kv(clave TEXT PRIMARY KEY, valor TEXT)');
  cargarBloqueos();
  return db;
}

function log(msg) {
  try { fs.appendFileSync(RUTA_LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch (_) {}
}

export function normalizarDni(v) {
  const s = String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
  return s.length >= 7 && s.length <= 9 ? s : null;
}

/* ============================================================================
 * LIMITES DE ARGOS — REGLAS DE ORO (doc oficial, pool de 10 IPs compartido)
 * ============================================================================
 * Los cupos son GLOBALES ENTRE LAS 10 IPs SUMADAS, no por IP. O sea que este
 * proceso y cualquier otro que use las mismas IPs comparten el mismo techo.
 *
 *   por minuto : 15
 *   por hora   : 100
 *   por dia    : 500
 *   nosis PDF  : 3 por minuto (compartidas)
 *   anti-scrap : PROHIBIDO el barrido de DNIs correlativos en rafaga
 *
 * Castigo por pasarse (pausa automatica progresiva):
 *   Nivel 1: 5m   Nivel 2: 15m   Nivel 3: 30m   Nivel 4: 1h   Nivel 5: 3h
 *   Nivel 6+: 6h
 *
 * REGLA DE ORO: no nos pueden pausar NUNCA, ni siquiera al Nivel 1.
 *
 * Los tres cupos (minuto/hora/dia) se controlan por separado y tienen que
 * respetarse los tres a la vez. El dia es el que menos se toca pero es el que
 * deja el bot muerto mas tiempo, asi que tambien se frena.
 * ========================================================================== */
const marca = new Map();
const LIMITE_MINUTO = Number(process.env.ARGOS_RPM || 15);
const LIMITE_HORA = Number(process.env.ARGOS_RPH || 100);
const LIMITE_DIA = Number(process.env.ARGOS_RPD || 500);
/* nosis comparte el cupo general y ademas tiene el suyo: 3/min y UNA a la vez. */
const LIMITE_NOSIS = Number(process.env.ARGOS_RPM_NOSIS || 3);
let nosisActivo = 0;

/* La doc sugiere "1 consulta cada 6-10 min por IP" para operar CONTINUO, pero
 * eso es por IP: entre las 10 IPs el techo real es 15/min. Se apunta a no
 * tocar 15 (arriba de 100/h ya se nota). Nunca se sale a buscar el limite.
 */
/* ---------------------------------------------------------------------------
 * QUE RUTAS PAGAN CUPO
 *
 * Dato del proveedor (2026-11-18): /api/v1/local/<dni> esta habilitado como
 * ILIMITADO ("sin tope por minuto, hora ni dia, y sin timeouts"). Los limites
 * de 15/min - 100/h - 500/dia aplican SOLO a los endpoints externos: RENAPER en
 * vivo, Nosis, IA, patente, etc.
 *
 * Esto importa mucho: antes TODO pasaba por el mismo contador, asi que barrer
 * la base local (que es gratis) te comia el cupo que necesita RENAPER o nosis.
 * Y el anti-scrap tambien frenaba al pedo: /local no tiene problema de barrido.
 *
 * Solo el cupo se saltea. El CIRCUITO DE BLOQUEO sigue valiendo para todas las
 * rutas, porque un castigo de /local (si algun dia lo hubiera) igual hay que
 * respetarlo.
 * ------------------------------------------------------------------------- */
const RUTAS_LIBRES = [/^\/api\/v1\/local\//, /^\/api\/v1\/health/];
function pagaCupo(ruta) {
  return !RUTAS_LIBRES.some((re) => re.test(ruta));
}

function cupos() {
  const ahora = Date.now();
  const cnt = (clave, ms) => (marca.get(clave) || []).filter((t) => ahora - t < ms).length;
  return {
    minuto: cnt('todo', 60000),
    hora: cnt('hora', 3600000),
    dia: cnt('dia', 86400000),
  };
}
function hayCupo() {
  const c = cupos();
  return c.minuto < LIMITE_MINUTO && c.hora < LIMITE_HORA && c.dia < LIMITE_DIA;
}
function anotarUso() {
  const ahora = Date.now();
  /* Se guarda el timestamp crudo en las tres colas; cada una se poda por su
   * propia ventana al leer (una sola marca, tres ventanas). */
  for (const k of ['todo', 'hora', 'dia']) {
    const m = marca.get(k) || [];
    m.push(ahora);
    marca.set(k, m);
  }
}
/* Cuanto hay que esperar para el proximo cupo. Se usa para no hacer busy-wait
 * de 1s cuando falta mucho: si el cupo del minuto esta lleno, se duerme lo justo
 * hasta que venza el pedido mas viejo de la ventana. */
function esperaMs() {
  const ahora = Date.now();
  const c = cupos();
  let espera = 0;
  /* Para liberar UN cupo hay que esperar a que el pedido mas viejo de los que
   * ocupan la ventana cumpla su tiempo: los que sobran son los primeros de la
   * cola ordenada, y el que hay que dejar vencer es el que cae justo en el
   * borde (length - max). */
  const porVencer = (clave, ventana, usados, max) => {
    if (usados < max) return 0;
    const cola = (marca.get(clave) || []).filter((t) => ahora - t < ventana).sort((a, b) => a - b);
    const objetivo = cola[cola.length - max];
    return objetivo ? objetivo + ventana - ahora + 300 : 0;
  };
  espera = Math.max(espera, porVencer('todo', 60000, c.minuto, LIMITE_MINUTO));
  espera = Math.max(espera, porVencer('hora', 3600000, c.hora, LIMITE_HORA));
  espera = Math.max(espera, porVencer('dia', 86400000, c.dia, LIMITE_DIA));
  return Math.max(espera, 250);
}

/* ARGOS bloquea por "Timeout progresivo activo (Nivel N). Reintente en Xm" y
 * ese castigo dura HORAS. Con el 429 sostenido, los 3 intentos de pedir() y los
 * dos endpoints (renaper + local) son 8s tirados por DNI para que contesten
 * siempre lo mismo. Cuando el cuerpo del 429 dice que el castigo es largo, se
 * corta aca y los pedidos siguientes fallan en 0ms hasta que venza. */
/* OJO: el castigo es POR RUTA, no global. Medido: /api/v1/health contesta 200
 * mientras /api/v1/patente contesta 429. Si el bloqueo fuera global, pedir un
 * dominio dejaria ciego al scoring y viceversa. La clave es la ruta sin el
 * ultimo segmento. */
const bloqueos = new Map();
/* ARGOS dice el tiempo exacto ("Reintente en 47m 12s") y hay que creerle: si
 * reintentamos antes, comemos otro 429 y el nivel de castigo SUBE (asi llegamos
 * a Nivel 12). El techo es solo una red por si no parseamos el texto. */
const BLOQUEO_MAX_MS = Number(process.env.ARGOS_BLOQUEO_MIN || 180) * 60000;
/* ---------------------------------------------------------------------------
 * LA CLAVE DEL BLOQUEO — CORREGIDO 2026-11-18
 *
 * Se creia que el castigo era POR RUTA (que /patente castigado no afectaba a
 * /renaper). ES FALSO. Verificado en vivo: con el nivel 2 activo, /patente,
 * /telefono, /nosis, /renaper y /dni_completo devolvieron TODAS "Nivel 2.
 * Reintente en 10m 20s" — el mismo segundo exacto.
 *
 * El castigo cubre TODO lo que sea "endpoint externo". La UNICA excepcion es
 * /local, que el proveedor habilito como ilimitado y sigue andando siempre.
 *
 * Entonces la clave del bloqueo es UNA sola: 'externo'. Antes eran 5 claves
 * distintas y eso permitia que un pedido a /renaper intentara salir mientras
 * /patente estaba castigado, comiera otro 429 y SUBIERA el nivel. Nos
 * auto-escalabamos el castigo solos.
 * ------------------------------------------------------------------------- */
const CLAVE_EXTERNO = 'externo';
const rutaClave = (ruta) => (ruta && !pagaCupo(ruta) ? 'libre:' + String(ruta) : CLAVE_EXTERNO);

/* El bloqueo vivia solo en memoria y cada restart (que en este VPS es seguido)
 * lo borraba: el primer pedido despues del restart volvia a comer el 429 y asi
 * se re-alimentaba el castigo. Se persiste en la DB y se carga al arrancar. */
function cargarBloqueos() {
  /* Se llama desde abrir() DESPUES de crear cache_kv. Ojo: tiene que usar la
   * variable db directo y no abrir(), porque abrir() todavia no termino. */
  try {
    const filas = db.prepare("SELECT clave, valor FROM cache_kv WHERE clave LIKE 'bloqueo:%'").all();
    const ahora = Date.now();
    for (const r of filas) {
      const hasta = Number(r.valor || 0);
      const clave = r.clave.slice(8);
      if (hasta > ahora) bloqueos.set(clave, hasta);
      /* Vencidos: se limpian de la DB para que no se acumulen. */
      else db.prepare('DELETE FROM cache_kv WHERE clave =?').run(r.clave);
    }
    if (bloqueos.size) log('bloqueos cargados: ' + [...bloqueos.keys()].join(', '));
  } catch (e) { log('ERROR cargando bloqueos: ' + (e && e.message)); }
}
function guardarBloqueo(ruta, hasta) {
  try {
    db.prepare('INSERT INTO cache_kv(clave,valor) VALUES(?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor')
      .run('bloqueo:' + ruta, String(hasta));
  } catch (e) { log('ERROR guardando bloqueo: ' + (e && e.message)); }
}
function liberarBloqueo(ruta) {
  bloqueos.delete(ruta);
  try { db.prepare('DELETE FROM cache_kv WHERE clave =?').run('bloqueo:' + ruta); } catch (_) {}
}

function bloqueado(ruta) {
  const clave = rutaClave(ruta);
  const h = bloqueos.get(clave);
  if (!h) return false;
  if (Date.now() >= h) {
    /* Vencio: se limpia en memoria Y en la DB. Sin esto la clave quedaba
     * apuntando a un vencimiento viejo y el primer pedido post-vencimiento
     * volvia a fallar por las dudas. */
    liberarBloqueo(clave);
    return false;
  }
  return true;
}
function anotarBloqueo(ruta, texto) {
  /* Formatos reales de ARGOS, de mas a menos grave:
   *   "Timeout progresivo activo (Nivel 4). Reintente en 5h 3m."
   *   "Timeout progresivo activo (Nivel 1). Reintente en 2m 56s."
   *   "Reintente en 30s."
   * Se parsean horas, minutos Y segundos. Si no se parsea nada, se asume el
   * castigo mas chico (5m) en vez del mas grande, para no quedarnos ciegos. */
  const t = String(texto || '');
  const h = Number((/en\s+(\d+)\s*h/i.exec(t) || [])[1] || 0);
  const m = Number((/en\s+(?:\d+\s*h\s*)?(\d+)\s*m/i.exec(t) || [])[1] || 0);
  const s = Number((/en\s+(?:\d+\s*h\s*)?(?:\d+\s*m\s*)?(\d+)\s*s/i.exec(t) || [])[1] || 0);
  const mins = h * 60 + m + (s ? s / 60 : 0);
  /* Se le suman 20s de colchon: si volvemos justo en el segundo del vencimiento,
   * ARGOS todavia nos tiene castigados y el nivel SUBE. */
  const ms = Math.min(((mins || 5) * 60000) + 20000, BLOQUEO_MAX_MS);
  const clave = rutaClave(ruta);
  const hasta = Date.now() + ms;
  bloqueos.set(clave, hasta);
  guardarBloqueo(clave, hasta);
  const nivel = (/nivel\s+(\d+)/i.exec(t) || [])[1];
  log('bloqueo ARGOS ' + clave + ' por ' + (ms / 60000).toFixed(1) + 'm' +
    (nivel ? ' (Nivel ' + nivel + ')' : '') + ': ' + t.slice(0, 90));
}

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* Espera a que haya cupo. Todas las rutas pasan por aca menos nosis (que
 * ademas tiene su propio tope de concurrencia). El cupo global se cuenta en
 * 'todo'; nosis suma al global Y al suyo. */
/* Espera a que haya cupo en LOS TRES limites (minuto, hora, dia) antes de
 * dejar salir un pedido. Antes esto era una espera de 1s en loop y sin tope de
 * hora/dia, que es como nos comimos el castigo. nosis ademas tiene su tope de
 * 3/min y su cola de a uno.
 *
 * Es el UNICO punto por donde pasan todos los pedidos a ARGOS: si algo nuevo
 * llama a pedir() sin pasar por turno(), el limite no se respeta. */
async function turno(tipo, ruta) {
  /* Ruta libre (/local): no se toca el contador. Se devuelve ya mismo. */
  if (ruta && !pagaCupo(ruta)) return;
  const esNosis = tipo === 'nosis';
  for (;;) {
    const ahora = Date.now();
    /* Poda de las tres colas (cada una por su ventana). */
    for (const [k, ms] of [['todo', 60000], ['hora', 3600000], ['dia', 86400000]]) {
      const m = (marca.get(k) || []).filter((t) => ahora - t < ms);
      marca.set(k, m.length ? m : []);
    }
    const n = esNosis ? (marca.get('nosis') || []).filter((t) => ahora - t < 60000) : null;

    const cabe = hayCupo() && (!esNosis || n.length < LIMITE_NOSIS);
    if (cabe) {
      anotarUso();
      if (esNosis) { n.push(ahora); marca.set('nosis', n); }
      return;
    }
    await esperar(esperaMs());
  }
}

/* ---------------------------------------------------------------------------
 * ANTI-SCRAPING (ESTO ES LO QUE MAS NOS CASTIGO)
 *
 * Texto literal de ARGOS al castigarnos:
 *   "Timeout progresivo nivel 1 (Barrido secuencial/ascendente de DNIs
 *    detectado)"
 *
 * O sea: NO nos pausa solo por volumen, nos pausa por PARECER UN SCRAPER. Y el
 * patron que delata es mandar DNIs que suben de a uno (10000001, 10000002,
 * ...). Medido en vivo: 8 pedidos en 66 segundos (7/min, bien por debajo del
 * tope de 15/min) igual comieron Nivel 1, porque los DNIs eran 32000000, +1,
 * +2... La pausa de 400ms era insignificante: ARGOS quiere ver SEGUNDOS de
 * separacion cuando el patron es correlativo.
 *
 * Regla: si los ultimos pedidos fueron ascendentes/correlativos, se estira la
 * espera. Cuantos mas correlativos seguidos, mas larga la pausa (se rompe la
 * racha a la 4ta), y a la racha larga se le mete un corte de verdad.
 *
 * Un pedido suelto (DNI salteado, como hace una persona) NO paga pausa.
 *
 * OJO AL ESCRIBIR DESDE UN SCRIPT: si barres 10000001..10000100 de un tiron,
 * esto solo te da ~2.5s entre pedidos. Con 15/min el cupo ya te frena a 4s, asi
 * que combinado queda bien. Pero si necesitas URGENTE, saltea de a 7 DNIs
 * (10000001, 10000008, 10000015...) y pasas por persona normal.
 * ------------------------------------------------------------------------- */
const PAUSA_SCRAP_MS = Number(process.env.ARGOS_PAUSA_SCRAP_MS || 1200);
const RACHA_MAX = 6;
const ultimosDnis = [];
let ultimoPedido = 0;
let racha = 0;

/* Devuelve true si este DNI continua un barrido (delta 1..2 contra los ultimos). */
function pareceBarrido(d) {
  if (!d || !ultimosDnis.length) return false;
  const n = Number(d);
  if (!Number.isFinite(n)) return false;
  /* Solo mira el ULTIMO pedido: si el nuevo es correlativo del anterior, sigue
   * el barrido. Mirar mas atras da falsos positivos con DNIs sueltos que caen
   * cerca por casualidad. */
  const dif = Math.abs(Number(ultimosDnis[ultimosDnis.length - 1]) - n);
  return dif > 0 && dif <= 2;
}

async function antiScrap(d, ruta) {
  if (!d) return;
  /* /local es ilimitado y su base no se "barre" a los ojos de ARGOS: no paga
   * pausa. Solo los endpoints externos (patente, etc.) necesitan parecer
   * humanos. */
  if (ruta && !pagaCupo(ruta)) return;
  if (pareceBarrido(d)) {
    racha++;
    /* Pausa PLANA entre correlativos (PAUSA_SCRAP_MS, 1.2s). Nada de
     * multiplicar por la racha: probado, x1/x2/x3/x4 acumulaba 2.5/7.5/15/25/40s
     * y un barrido de 100 tardaba horas.
     *
     * OJO CON EL CUPO: esta pausa se SUMA al freno del cupo general, que ya
     * mete ~4s por pedido (15/min). Con 2.5s se llegaba al tope y ARGOS
     * respondia "Timeout progresivo (Limite por minuto)" — o sea la pausa
     * anti-scrap nos hacia pasar el limite de minuto. Con 1.2s queda aire.
     *
     * El corte se hace cada RACHA_MAX correlativos: se espera el DOBLE una vez
     * para que ARGOS vea un hueco y no un chorro parejo. */
    const tocaCorte = racha >= RACHA_MAX;
    if (tocaCorte) racha = 0;
    const quiero = PAUSA_SCRAP_MS * (tocaCorte ? 2 : 1);
    const falta = quiero - (Date.now() - ultimoPedido);
    if (falta > 0) await esperar(falta);
  } else {
    /* Cambio de patron: se corta la racha. */
    racha = 0;
  }
  ultimosDnis.push(d);
  if (ultimosDnis.length > 10) ultimosDnis.shift();
  ultimoPedido = Date.now();
}

/* Cola de a UNO para nosis (la doc: "1 nosis a la vez, las demas esperan hasta
 * 45s"). El cupo del pool y el cupo propio de nosis los descuenta pedir(), asi
 * que aca solo se maneja la concurrencia y se marca el tipo de pedido. */
async function turnoNosis() {
  const desde = Date.now();
  while (nosisActivo >= 1) {
    if (Date.now() - desde > 45000) throw new Error('cola nosis 45s');
    await esperar(500);
  }
  nosisActivo += 1;
}

async function pedir(ruta, opts) {
  opts = opts || {};
  /* nosis necesita pasar por su propio cupo (3/min) ademas del general. El
   * resto de las rutas solo por el general. Se marca con opts.tipo. */
  const tipo = opts.tipo === 'nosis' ? 'nosis' : 'reintento';
  if (bloqueado(ruta)) return { ok: false, motivo: 'rate limit (en espera)', tocado: false };
  const timeout = Number(opts.timeout || 30000);
  /* OJO CON LOS REINTENTOS: cada intento es un request REAL que ARGOS cuenta.
   * Antes el cupo se descontaba una sola vez (en turno(), afuera de aca) y los
   * reintentos salian gratis para nuestro contador pero no para el pool: 3
   * intentos con cupo de 1 era pasarse de 15/min a 45/min. Por eso ahora cada
   * intento vuelve a pedir turno().
   *
   * Con el castigo sostenido (429 con "Reintente en") no tiene sentido esperar:
   * se anota el bloqueo y se corta. El reintento corto queda para el 429
   * transitorio, que existe pero es minoria. */
  const esperas = [1500, 3000];
  let ultimo = 'sin respuesta';
  /* Corte previo: si la ruta ya esta castigada, no se toca ARGOS (contesta en
   * 0ms). Antes esto no existia y cada llamada nueva igual salia a pegarle al
   * servidor para recibir otro 429 — y con el castigo global, CUALQUIER ruta
   * externa quedaba castigada: sin este corte, un /scoring que pide renaper,
   * nosis y bcra mandaba 3 pedidos inutiles. */
  if (bloqueado(ruta)) return { ok: false, motivo: 'rate limit (en espera)', tocado: false };
  for (let i = 1; i <= 3; i++) {
    /* Todo intento pasa por el cupo, incluido el primero. Las rutas libres
     * (/local, /health) no gastan nada. */
    await turno(tipo, ruta);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(BASE + ruta, { signal: ctrl.signal });
      if (r.status === 200) { liberarBloqueo(rutaClave(ruta)); return { ok: true, r: r, tocado: true }; }
      if (r.status === 403) return { ok: false, motivo: 'IP no autorizada' };
      if (r.status === 404) return { ok: false, motivo: 'sin datos' };
      if (r.status === 400) return { ok: false, motivo: 'dni invalido' };
      if (r.status === 429 || r.status === 504) {
        ultimo = r.status === 429 ? 'rate limit' : 'timeout';
        /* Si el 429 trae "Reintente en Xm" en el cuerpo, el castigo es largo:
         * se anota el bloqueo y se cortan los reintentos de una. */
        if (r.status === 429) {
          const txt = await r.text().catch(() => '');
          if (/progresivo|reintente/i.test(txt)) {
            /* Se anota SIEMPRE, no solo si no habia bloqueo: ARGOS puede
             * alargar el castigo (subir de nivel) y hay que tomarlo. Si manda
             * uno mas corto tambien vale, es la verdad del momento. */
            anotarBloqueo(ruta, txt);
            return { ok: false, motivo: 'rate limit' };
          }
        }
        if (i < 3) { await esperar(esperas[i - 1]); continue; }
        return { ok: false, motivo: ultimo };
      }
      return { ok: false, motivo: 'http ' + r.status };
    } catch (e) {
      ultimo = e && e.name === 'AbortError' ? 'timeout' : String(e && e.message ? e.message : e);
      if (i < 3) await esperar(esperas[i - 1]);
    } finally {
      clearTimeout(t);
    }
  }
  return { ok: false, motivo: ultimo };
}

export async function health() {
  const gh = await gordo.health();
  if (gh && gh.ok) return gh.json || { ok: true };
  if (process.env.ARGOS_OFICIAL !== '1') return { ok: false, motivo: gh && gh.motivo };
  const r = await pedir('/api/v1/health', { timeout: 10000 });
  if (!r.ok) return { ok: false, motivo: r.motivo };
  try { return await r.r.json(); } catch (_) { return { ok: true }; }
}
export function cacheDeDni(dniBruto) {
  const d = normalizarDni(dniBruto);
  if (!d) return null;
  try {
    const f = abrir().prepare('SELECT * FROM argos WHERE dni =?').get(d);
    if (!f) return null;
    const edad = (Date.now() - Date.parse(f.capturado)) / 86400000;
    if (!(edad <= (f.ttl_dias || TTL_DIAS))) return null;
    const j = JSON.parse(f.json || '{}');
    return Object.assign({ fuente: f.fuente }, j);
  } catch (_) { return null; }
}

/* Cache aunque este vencida: se usa para responder al instante */
/* y refrescar en segundo plano. */
export function cacheViejo(dniBruto) {
  const d = normalizarDni(dniBruto);
  if (!d) return null;
  try {
    const f = abrir().prepare("SELECT * FROM argos WHERE dni =? LIMIT 1").get(d);
    if (!f) return null;
    const j = JSON.parse(f.json || "{}");
    return Object.assign({ fuente: f.fuente }, j);
  } catch (_) { return null; }
}

function guardar(dni, tipo, data) {
  try {
    abrir().prepare('INSERT INTO argos(dni,fuente,json,capturado,ttl_dias) VALUES(?,?,?,?,?) ON CONFLICT(dni) DO UPDATE SET fuente=excluded.fuente, json=excluded.json, capturado=excluded.capturado, ttl_dias=excluded.ttl_dias').run(dni, tipo, JSON.stringify(data), new Date().toISOString(), TTL_DIAS);
    abrir().prepare('DELETE FROM argos_intentos WHERE dni =?').run(dni);
  } catch (_) {}
}

function anotar(dni, motivo) {
  try {
    abrir().prepare('INSERT INTO argos_intentos(dni,intentos,ultimo,motivo) VALUES(?,1,?,?) ON CONFLICT(dni) DO UPDATE SET intentos=intentos+1, ultimo=excluded.ultimo, motivo=excluded.motivo').run(dni, new Date().toISOString(), motivo);
  } catch (_) {}
  log(dni + ' ' + motivo);
}

const titulo = (s) => String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

function fechaBr(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : null;
}

function interpretar(tipo, d, dni) {
  const out = { fuente: tipo === 'renaper' ? 'ARGOS_RENAPER' : 'ARGOS_LOCAL', dni: dni };
  const nd = String(d.nombre_db || d.nombre_completo || '').trim();
  if (nd) {
    const partes = nd.split(/\s+/);
    if (partes.length > 1) { out.apellido = partes[0]; out.nombre = partes.slice(1).join(' '); }
    out.nombreCompleto = nd;
  }
  if (d.sexo) out.sexo = String(d.sexo).toUpperCase();
  out.fechaNac = fechaBr(d.fecha_nacimiento);
  if (d.cuil) out.cuit = String(d.cuil).replace(/\D/g, '');
  let dir = titulo(d.calle || d.direccion || d.direccion_actual);
  const num = String(d.numero || '').trim();
  if (num && dir && dir.indexOf(num) === -1) dir = dir + ' ' + num;
  if (d.piso) dir = (dir || '') + ' PISO ' + d.piso;
  if (d.departamento) dir = (dir || '') + ' DEPTO ' + d.departamento;
  out.direccion = dir ? dir.replace(/\s+/g, ' ').trim() : null;
  out.ciudad = titulo(d.localidad || d.ciudad);
  out.provincia = titulo(d.provincia);
  out.cpostal = d.codigo_postal ? String(d.codigo_postal).trim() : null;
  out.nroTramite = d.tramite_principal ? String(d.tramite_principal).trim() : null;
  out.fallecido = d.fallecido === true || String(d.fallecido) === 'true' || Number(d.fallecido) === 1;
  const tel = Array.isArray(d.telefonos_asociados) ? d.telefonos_asociados[0] : null;
  out.telefono = tel ? String(tel).trim() : null;
  out.mail = d.correo_electronico ? String(d.correo_electronico).trim().toLowerCase() : null;
  return out;
}
/* renaper y local son fuentes COMPLEMENTARIAS del gordo, no dueñas del registro.
 * La tabla argos tiene PK solo en dni, asi que si se guardan con el dni pelado
 * PISAN lo que guardo el gordo y rompen los campos que solo el trae (familia).
 * Se guardan bajo su propia clave ('renaper:<dni>') y se leen de ahi. */
const CLAVE_FUENTE = (tipo, d) => tipo === 'renaper' ? 'renaper:' + d : 'local:' + d;

/* `renaper:`/`local:` viven en un espacio de claves DISTINTO del dni pelado, y
 * `datosDeDni` solo lee el pelado: un DNI guardado SOLO bajo `renaper:<dni>`
 * quedaba invisible para el scoring, que salia a la red de nuevo en vez de usar
 * el cache. Medido: 273 filas con prefijo y 20 DNIs huerfanos (30000496 entre
 * ellos: el dato de RENAPER estaba guardado y el bot lo ignoro).
 * Se devuelve el primero que haya y este fresco; el pelado gana sobre el
 * prefijado porque lo escribe el camino principal. */
function cachePrefijado(d) {
  for (const k of ['renaper:' + d, 'local:' + d]) {
    const f = cacheFuente(k.startsWith('renaper') ? 'renaper' : 'local', d);
    if (f) return f;
  }
  return null;
}

function cacheFuente(tipo, d) {
  try {
    const f = abrir().prepare('SELECT json, capturado, ttl_dias FROM argos WHERE dni =?').get(CLAVE_FUENTE(tipo, d));
    if (!f) return null;
    const edad = (Date.now() - Date.parse(f.capturado)) / 86400000;
    if (!(edad <= (f.ttl_dias || TTL_DIAS))) return null;
    return JSON.parse(f.json || '{}');
  } catch (_) { return null; }
}

export async function datos(tipo, dniBruto, opts) {
  opts = opts || {};
  const d = normalizarDni(dniBruto);
  if (!d) return { fuente: 'AUSENTE', motivo: 'dni invalido' };
  if (!opts.forzar) {
    const c = cacheFuente(tipo, d);
    if (c) return c;
  }
  /* El cupo lo descuenta pedir(), que es el unico que toca la red. */
  const r = await pedir('/api/v1/'+tipo+'/'+d, { timeout: 30000 });
  /* Anti-scraping: SOLO se marca el DNI si hubo red de verdad. Si el pedido
   * salio del corto-circuito por bloqueo (0ms, sin tocar ARGOS), no cuenta como
   * parte del barrido: si se marcara, al vencer el bloqueo la lista de
   * correlativos se armo con pedidos fantasma y mete una pausa al pepe. */
  if (r.tocado) await antiScrap(d, '/api/v1/' + tipo + '/' + d);
  if (!r.ok) { anotar(d, r.motivo); return { fuente: 'AUSENTE', motivo: r.motivo }; }
  let j = null;
  try { j = await r.r.json(); } catch (_) {}
  /* ARGOS devuelve {"ok":false,"error":"..."} cuando nos bloquea por abuso
   * ("Timeout progresivo activo (Nivel N). Reintente en 2h 48m."). Eso NO es
   * una respuesta invalida ni un dato ausente: es la fuente entera caida, y
   * hay que propagar el motivo del servidor en vez de tragarselo, porque si no
   * el usuario lee "respuesta invalida" y no se entiende nada. */
  if (!j || !j.ok) return { fuente: 'AUSENTE', motivo: (j && j.error) || 'respuesta invalida' };
  const data = interpretar(tipo, j.data || {}, d);
  try {
    abrir().prepare('INSERT INTO argos(dni,fuente,json,capturado,ttl_dias) VALUES(?,?,?,?,?) ON CONFLICT(dni) DO UPDATE SET fuente=excluded.fuente, json=excluded.json, capturado=excluded.capturado, ttl_dias=excluded.ttl_dias')
      .run(CLAVE_FUENTE(tipo, d), data.fuente, JSON.stringify(data), new Date().toISOString(), TTL_DIAS);
  } catch (_) {}
  return data;
}

const ENVUELTOS = new Map();

/* Un solo pedido por DNI a la vez: si dos comandos piden lo mismo, */
/* el segundo espera al primero en vez de duplicar la consulta. */
function refrescar(d, opts) {
  if (ENVUELTOS.has(d)) return ENVUELTOS.get(d);
  const p = (async () => {
    try {
      /* El gordo (GORDO_BASE) esta MUERTO desde hace dias: el puerto no
       * acepta conexion y cada intento cuelga, asi que un DNI nuevo pagaba
       * 11-13s SOLO en este paso, y encima el castigo vivia en memoria del
       * proceso (un restart lo borraba y volvia a pagar). Con GORDO_APAGADO=1
       * se lo saltea del todo. Sus campos (nombre, sexo, fechaNac, cuit,
       * direccion) los trae RENAPER, que esta vivo. Los ~3100 registros ya
       * cacheados del gordo siguen sirviendo: se consultan por cache aparte. */
      const g = process.env.GORDO_APAGADO === "1"
        ? { fuente: "AUSENTE", motivo: "gordo apagado" }
        : await gordo.datos(d);
      if (g && g.fuente && g.fuente !== "AUSENTE") { guardar(d, g.fuente, g); return g; }
      if (process.env.ARGOS_OFICIAL !== "1") return { fuente: "AUSENTE", motivo: (g && g.motivo) || "sin datos" };
      const ren = await datos("renaper", d, opts || {});
      /* IMPORTANTE: local SIEMPRE se pide, aunque renaper este bloqueado.
       * Antes se salteaba ("es el mismo servidor y el mismo castigo"), pero eso
       * era de cuando TODO pagaba cupo y castigo. Ahora /local es ILIMITADO y
       * nunca esta castigado: si renaper rebota, local igual trae nombre,
       * documento, domicilio y familia. Saltearlo era perder la unica fuente
       * que sigue viva durante un castigo. */
      const loc = await datos("local", d, opts || {});
      const out = {};
      if (loc && loc.fuente !== "AUSENTE") Object.assign(out, loc);
      if (ren && ren.fuente !== "AUSENTE") Object.assign(out, ren);
      if (Object.keys(out).length) guardar(d, out.fuente || "ARGOS", out);
      return Object.keys(out).length ? out : { fuente: "AUSENTE", motivo: (ren.motivo || loc.motivo || "sin datos") };
    } catch (e) {
      return { fuente: "AUSENTE", motivo: String(e && e.message ? e.message : e) };
    } finally { ENVUELTOS.delete(d); }
  })();
  ENVUELTOS.set(d, p);
  return p;
}

export async function datosDeDni(dniBruto, opts) {
  opts = opts || {};
  const d = normalizarDni(dniBruto);
  if (!d) return {};
  if (opts.sinRed) return cacheDeDni(d) || cachePrefijado(d) || cacheViejo(d) || {};
  const fresco = cacheDeDni(d) || cachePrefijado(d);
  if (fresco && !opts.forzar) return fresco;
  const viejo = fresco || cacheViejo(d);
  if (viejo && !opts.forzar) {
    refrescar(d, opts).catch(() => {});
    return viejo;
  }
  const r = await refrescar(d, opts);
  return r || viejo || { fuente: "AUSENTE", motivo: "sin datos" };
}

/* CUIL de RENAPER SIN TOCAR LA TABLA argos. La tabla tiene PK en dni solo, asi
 * que guardar el registro de renaper PISA el del gordo y ensucia el cache de
 * datosDeDni. Para una consulta puntual de CUIL no vale la pena: se pega
 * directo al endpoint y se devuelve el cuil ya normalizado.
 *
 * TRAMPA MEDIDA: el 404 de ARGOS es INTERMITENTE para el mismo DNI (probado:
 * 9 de 11 llamadas dan 404 y 2 dan 200 con el cuil, sin patron). O sea que un
 * 404 NO es "no esta en RENAPER", es "esta vez no lo sirvio". Por eso el 404
 * tambien se reintenta; sin esto el informe marcaba el CUIL como PRESUNTO y
 * hasta daba por inexistente a gente que si tiene datos. */
const CLAVE_RENAPER = (d) => 'r:' + d;

function guardarCuilRenaper(dni, cuil) {
  try {
    abrir().prepare('INSERT INTO argos(dni,fuente,json,capturado,ttl_dias) VALUES(?,?,?,?,?) ON CONFLICT(dni) DO UPDATE SET json=excluded.json, capturado=excluded.capturado')
      .run(CLAVE_RENAPER(dni), 'RENAPER_CUIL', JSON.stringify({ cuil: cuil }), new Date().toISOString(), 180);
  } catch (_) {}
}

/* Ficha de un dominio (patente) contra DNRPA: titulares registrales,
 * transferencias 2024-2025, porcentuales y permisos notariales de conduccion.
 * El dominio ya viene normalizado (A-Z0-9, 5-9 chars) por lib/vehiculos.js.
 * Devuelve {ok:true, data} o {ok:false, motivo}; el data crudo lo interpreta
 * el llamador porque los campos son muchos y planos. */
export async function pedirPatente(dom) {
  try {
    const ruta = '/api/v1/patente/' + encodeURIComponent(dom);
    /* patente es ruta EXTERNA: paga cupo (lo hace pedir()) y ademas paga la
     * pausa anti-scrap, porque los dominios tambien se barren seguido. */
    const r = await pedir(ruta, { timeout: 40000 });
    if (r.tocado) await antiScrap(dom, ruta);
    if (!r.ok) return { ok: false, motivo: r.motivo };
    const j = await r.r.json();
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, motivo: String(e && e.message ? e.message : e) };
  }
}

export async function cuilDeRenaper(dniBruto) {
  const d = normalizarDni(dniBruto);
  if (!d) return null;
  /* Cache primero: ARGOS sirve RENAPER de forma INTERMITENTE (medido: el mismo
   * DNI da 404 en 9 de 11 llamadas y 200 en las otras 2, sin patron). Una vez
   * que el cuil aparece, guardarlo evita volver a depender de la suerte. Se
   * usa la tabla argos con la clave 'r:<dni>' para no pisar el registro del
   * gordo, que va con el dni pelado. */
  try {
    const f = abrir().prepare('SELECT json, capturado FROM argos WHERE dni =?').get(CLAVE_RENAPER(d));
    if (f && (Date.now() - Date.parse(f.capturado)) / 86400000 <= 180) {
      const c = String(JSON.parse(f.json || '{}').cuil || '').replace(/\D/g, '');
      if (c.length === 11) return c;
    }
  } catch (_) {}
  let ultimo = null;
  for (let i = 1; i <= 3; i++) {
    let r = null;
    try {
      /* Con ARGOS bloqueado (o en castigo), pedir() contesta en 0ms: sin este
       * corte los 3 intentos se comen igual las esperas para recibir lo mismo.
       * Ademas cada intento gastaria un cupo del pool. */
      if (bloqueado('/api/v1/renaper/' + d) && i > 1) break;
      r = await pedir('/api/v1/renaper/' + d, { timeout: 15000 });
      if (r.ok) {
        const j = await r.r.json();
        const c = String((j && j.data && j.data.cuil) || '').replace(/\D/g, '');
        if (c.length === 11) { guardarCuilRenaper(d, c); return c; }
        ultimo = 'sin cuil en la respuesta';
      } else {
        ultimo = r.motivo;
      }
    } catch (e) { ultimo = 'excepcion'; }
    /* Si el intento NO toco la red (pedir corto por bloqueo), no se espera: el
     * segundo intento es un tiro al aire y los 1.2-2.4s son seguro perdidos,
     * porque el castigo dura minutos. El continue salta la espera. */
    if (r && r.tocado === false) continue;
    /* Las rachas de 404 de ARGOS duran varios segundos (medido: aparecen y
     * desaparecen sin patron), asi que la espera crece y el total ronda los
     * 20s. Reintentar muy junto cae entero dentro de la misma racha. */
    if (i < 4) await esperar(1200 * i);
  }
  log('renaper ' + d + ' sin cuil tras 4 intentos (' + ultimo + ')');
  return null;
}

export async function nosisPdf(dniBruto) {
  const d = normalizarDni(dniBruto);
  if (!d) return { fuente: 'AUSENTE', motivo: 'dni invalido' };
  /* turnoNosis() maneja la concurrencia de a uno; el cupo del pool lo
   * descuenta pedir(). Aca se reserva el cupo de nosis (que es mas chico) para
   * no arrancar una descarga que va a esperar al pedo. */
  try { await turnoNosis(); } catch (e) { return { fuente: 'AUSENTE', motivo: String(e.message) }; }
  try {
    const r = await pedir('/api/v1/nosis/'+d, { timeout: 190000, tipo: 'nosis' });
    if (!r.ok) { anotar(d, r.motivo); return { fuente: 'AUSENTE', motivo: r.motivo }; }
    const buf = Buffer.from(await r.r.arrayBuffer());
    fs.mkdirSync(RUTA_PDF, { recursive: true });
    const archivo = path.join(RUTA_PDF, d + '.pdf');
    fs.writeFileSync(archivo, buf);
    log(d + ' nosis pdf ' + buf.length);
    return { fuente: 'ARGOS_NOSIS', dni: d, archivo: archivo, bytes: buf.length };
  } catch (e) {
    return { fuente: 'AUSENTE', motivo: String(e && e.message ? e.message : e) };
  } finally {
    nosisActivo = Math.max(0, nosisActivo - 1);
  }
}

/* Expone el estado real de los contadores. Los numeros son los del pool (ver
 * el bloque de arriba): 15/min, 100/h, 500/dia, nosis 3/min. NO son 30/min ni
 * 28/min ni 2/min, que eran las cifras viejas de la doc incompleta.
 */
export function limites() {
  /* abrir() dispara la carga de bloqueos persistidos. Sin esto, consultar los
   * limites en un proceso recien arrancado muestra "sin pausas" aunque haya
   * una pausa activa guardada en la DB. */
  try { abrir(); } catch (_) {}
  const ahora = Date.now();
  const uso = (t, ms) => (marca.get(t) || []).filter((x) => ahora - x < ms).length;
  const bl = [];
  for (const [r, hasta] of bloqueos) if (hasta > ahora) bl.push({ ruta: r, minutos: Math.ceil((hasta - ahora) / 60000) });
  return {
    minuto: { usados: uso('todo', 60000), max: LIMITE_MINUTO },
    hora: { usados: uso('hora', 3600000), max: LIMITE_HORA },
    dia: { usados: uso('dia', 86400000), max: LIMITE_DIA },
    nosis: { usados: uso('nosis', 60000), max: LIMITE_NOSIS, enCurso: nosisActivo, concurrencia: 1 },
    bloqueados: bl,
    /* Reglas que no son cupo pero son de la doc: sirven para saber si el
     * trafico actual se parece a un scraper. */
    reglas: {
      pauta: 'pool de 10 IPs: 15/min, 100/h, 500/dia',
      antiScrap: 'sin barrido de DNIs correlativos en rafaga',
      ultimosDnis: ultimosDnis.slice(-5),
    },
    ttlDias: TTL_DIAS,
  };
}

export function stats() {
  try {
    const d = abrir();
    return { cacheados: d.prepare('SELECT COUNT(*) n FROM argos').get().n, fallos: d.prepare('SELECT COUNT(*) n FROM argos_intentos').get().n };
  } catch (_) { return { cacheados: 0, fallos: 0 }; }
}

export default { BASE, normalizarDni, health, datos, datosDeDni, cuilDeRenaper, nosisPdf, cacheDeDni, stats, limites };
