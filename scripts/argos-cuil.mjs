#!/usr/bin/env node
/* Trae mail y telefonos de una lista de CUIL (o DNI) usando ARGOS /api/v1/local.
 *
 *   node argos-cuil.mjs entrada.txt [salida.csv]
 *
 * - Acepta CUIL con guiones, CUIL pelado o DNI suelto; una fila por persona,
 *   o varias columnas (toma el primer token que parezca CUIL/DNI).
 * - Procesa de a TANDE por minuto (ARGOS: 30 consultas por minuto por IP).
 * - Guarda el avance en cuil.db: si se corta, retomа solo lo pendiente y
 *   nunca reconsulta lo ya resuelto.
 * - La salida CSV se escribe a medida que llegan los datos.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.ARGOS_BASE || 'http://104.234.7.128:5100';
const ENTRADA = process.argv[2] || '/opt/resolver/datos/cuil.txt';
const SALIDA = process.argv[3] || ENTRADA.replace(/\.[a-z]+$/i, '') + '-resultado.csv';
const DB = process.env.CUIL_DB || '/opt/resolver/datos/cuil.db';
const TANDE = Number(process.env.TANDE || 25);
const CONC = Number(process.env.CONC || 8);
const MAX_INTENTOS = Number(process.env.MAX_INTENTOS || 4);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();

/* ---------- entrada ---------- */
function dv(diez) {
  const p = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let s = 0;
  for (let i = 0; i < 10; i++) s += Number(diez[i]) * p[i];
  const v = 11 - (s % 11);
  return v === 11 ? 0 : v === 10 ? 9 : v;
}

function canonico(tok) {
  const d = String(tok).replace(/\D/g, '');
  if (d.length === 11 && /^\d{11}$/.test(d)) {
    let v = dv(d.slice(0, 10));
    return { cuil: d, dni: String(Number(d.slice(2, 10))), dvOk: v === Number(d[10]) ? 1 : 0 };
  }
  if (d.length >= 7 && d.length <= 8) return { cuil: null, dni: String(Number(d)), dvOk: 1 };
  return null;
}

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 8000');
db.exec(`CREATE TABLE IF NOT EXISTS persona(
  dni TEXT PRIMARY KEY, cuil TEXT, dv_ok INTEGER, estado TEXT DEFAULT 'pendiente',
  intentos INTEGER DEFAULT 0, motivo TEXT, nombre TEXT, mail TEXT, tels TEXT,
  localidad TEXT, provincia TEXT, cp TEXT, fecha TEXT)`);

/* ARGOS devuelve mucho mas que mail/tel: se guarda todo (additivo, no toca lo ya resuelto) */
const EXTRA = ['nacimiento', 'edad', 'sexo', 'direccion', 'direccion_db', 'emision', 'vencimiento_doc', 'ejemplar', 'familia', 'fuente'];
try { db.exec('ALTER TABLE persona ADD COLUMN fuente TEXT'); } catch {}
for (const c of EXTRA) { try { db.exec('ALTER TABLE persona ADD COLUMN ' + c + ' TEXT'); } catch {} }

if (!fs.existsSync(ENTRADA)) {
  console.error('no encuentro la entrada: ' + ENTRADA);
  process.exit(1);
}
const ins = db.prepare('INSERT OR IGNORE INTO persona(dni, cuil, dv_ok) VALUES(?,?,?)');
let cargados = 0, repetidos = 0, invalidos = 0;
for (const linea of fs.readFileSync(ENTRADA, 'utf8').split(/\r?\n/)) {
  if (!linea.trim()) continue;
  let c = null;
  for (const tok of linea.split(/[;,\t| ]+/)) {
    if (!tok) continue;
    c = canonico(tok);
    if (c) break;
  }
  if (!c) { invalidos += 1; continue; }
  const r = ins.run(c.dni, c.cuil, c.dvOk);
  if (r.changes) cargados += 1; else repetidos += 1;
}
const pend = () => db.prepare("SELECT COUNT(*) n FROM persona WHERE estado='pendiente'").get().n;
const hayFila = db.prepare("SELECT 1 x FROM cola LIMIT 1").get();
const lote = () => hayFila
  ? db.prepare("SELECT dni FROM persona WHERE dni IN (SELECT dni FROM cola) AND estado='pendiente' ORDER BY RANDOM() LIMIT ?")
  : db.prepare("SELECT dni FROM persona WHERE estado='pendiente' ORDER BY RANDOM() LIMIT ?");
console.log('entrada: ' + ENTRADA);
console.log('nuevos: ' + cargados + ' | ya estaban: ' + repetidos + ' | ilegibles: ' + invalidos);
console.log('pendientes de consultar: ' + (hayFila ? 'en cola' : pend()) + ' | limite ARGOS: 30/min -> tandes de ' + TANDE);
if (!pend()) { console.log('nada por hacer.'); resumen(); process.exit(0); }

/* ---------- salida ---------- */
function csv(nombre, filas, cabecera) {
  const nuevo = !fs.existsSync(nombre);
  const esc = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
  const out = filas.map((f) => f.map(esc).join(';')).join('\n');
  fs.appendFileSync(nombre, (nuevo ? '\ufeff' + cabecera.join(';') + '\n' : '') + out + '\n');
}
const COLS = ['cuil', 'dni', 'nombre', 'mail', 'telefonos_local', 'telefonos_familia', 'nacimiento', 'edad', 'sexo',
  'direccion', 'localidad', 'provincia', 'cp', 'emision', 'vencimiento_doc', 'ejemplar', 'familia', 'grupo_familiar', 'fuente', 'consultado'];

/* ---------- consulta ---------- */
async function traer(dni) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(BASE + '/api/v1/local/' + dni, { signal: ctrl.signal });
    if (r.status === 200) return { ok: true, j: await r.json() };
    if (r.status === 404) return { vacio: true, motivo: 'sin datos en ARGOS' };
    if (r.status === 429) return { motivo: 'rate limit' };
    return { motivo: 'http ' + r.status };
  } catch (e) {
    return { motivo: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

const upd = {
  sinDatos: db.prepare("UPDATE persona SET estado='sin_datos', intentos=intentos+1, motivo=?, fecha=? WHERE dni=?"),
  fallo: db.prepare('UPDATE persona SET estado=?, intentos=intentos+1, motivo=?, fecha=? WHERE dni=?'),
  ok: db.prepare(`UPDATE persona SET estado='ok', nombre=?, mail=?, tels=?, localidad=?, provincia=?, cp=?, fecha=?,
    nacimiento=?, edad=?, sexo=?, direccion=?, direccion_db=?, emision=?, vencimiento_doc=?, ejemplar=?, familia=?, fuente=?
    WHERE dni=?`),
};

/* "PINTOS Agustina Lorena (28, Hijo/a, mismo domicilio) 40980589" */
function armaFamilia(grupo, telsFam) {
  const g = (Array.isArray(grupo) ? grupo : []).map((p) => {
    const det = [p.edad, p.parentesco_deducido_ia, p.mismo_domicilio ? 'mismo domicilio' : 'otro domicilio']
      .filter((x) => x !== undefined && x !== null && x !== '').join(', ');
    const tel = (telsFam && telsFam[p.dni]) ? ' tel ' + telsFam[p.dni].join(' / ') : '';
    return (p.nombre_completo || '') + ' (' + det + ') ' + p.dni + tel;
  }).filter((x) => x.trim().length > 4);
  return { texto: g.join(' | '), cuantos: g.length };
}

async function procesar(dni) {
  const r = await traer(dni);
  const f = iso();
  if (r.vacio) { upd.sinDatos.run(r.motivo, f, dni); sinDatos += 1; return; }
  if (!r.ok) {
    const it = db.prepare('SELECT intentos n FROM persona WHERE dni=?').get(dni).n + 1;
    upd.fallo.run(it >= MAX_INTENTOS ? 'error' : 'pendiente', r.motivo || '?', f, dni);
    if (it >= MAX_INTENTOS) fallos += 1;
    return;
  }
  const d = (r.j && r.j.data) || {};
  const tels = Array.isArray(d.telefonos_asociados) ? d.telefonos_asociados.filter(Boolean).join(' / ') : (d.telefonos_asociados || '');
  const fam = armaFamilia(d.grupo_familiar_detectado, d.telefonos_familia);
  const fila = db.prepare('SELECT cuil FROM persona WHERE dni=?').get(dni) || {};
  const nombre = d.nombre_completo || d.nombre_db || '';
  const dir = d.direccion_actual || d.direccion_db || '';
  upd.ok.run(nombre, d.correo_electronico || '', tels,
    d.localidad || d.ciudad || '', d.provincia || '', d.codigo_postal || '', f,
    d.fecha_nacimiento || '', d.edad_actual || '', d.sexo || '', dir, d.direccion_db || '',
    d.documento_emision || '', d.documento_vencimiento || '', d.ejemplar || '', fam.texto, 'ARGOS_LOCAL', dni);
  csv(SALIDA, [[fila.cuil || '', dni, nombre, d.correo_electronico || '', tels, '',
    d.fecha_nacimiento || '', d.edad_actual || '', d.sexo || '', dir,
    d.localidad || d.ciudad || '', d.provincia || '', d.codigo_postal || '',
    d.documento_emision || '', d.documento_vencimiento || '', d.ejemplar || '',
    fam.cuantos, fam.texto, 'ARGOS_LOCAL', f]], COLS);
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]); }
  }));
}

/* ---------- bucle: una tanda al inicio de cada minuto ---------- */
let vueltas = 0, conDatos = 0, sinDatos = 0, fallos = 0;
const desde = Date.now();
await esperar(Math.floor(Math.random() * 45) * 1000); // arranque desalineado (no siempre al segundo 0)
for (;;) {
  const seg = new Date().getSeconds();
  if (seg > 2) await esperar((61 - seg) * 1000);
  const cuantos = TANDE + Math.floor(Math.random() * 7) - 3; // 22..28: tanda variable
  const fila = lote().all(cuantos);
  if (!fila.length) break;
  const antes = db.prepare("SELECT COUNT(*) n FROM persona WHERE estado='ok'").get().n;
  await pool(fila, CONC, (f) => procesar(f.dni));
  const ahora = db.prepare("SELECT COUNT(*) n FROM persona WHERE estado='ok'").get().n;
  conDatos += ahora - antes;
  vueltas += 1;
  const total = db.prepare('SELECT COUNT(*) n FROM persona').get().n;
  const restan = pend();
  if (vueltas % 5 === 0 || !restan) {
    const hechas = total - restan;
    const min = (Date.now() - desde) / 60000;
    console.log('[' + iso().slice(11, 19) + '] ' + hechas + '/' + total +
      ' consultadas | ' + conDatos + ' con datos, ' + sinDatos + ' sin datos, ' + fallos + ' con error' +
      ' | ' + (hechas / Math.max(min, 0.1)).toFixed(1) + '/min' +
      (restan ? ' | faltan ~' + Math.ceil(restan / TANDE) + ' min' : ''));
  }
}

function resumen() {
  const t = db.prepare("SELECT estado, COUNT(*) n FROM persona GROUP BY estado").all();
  const conMail = db.prepare("SELECT COUNT(*) n FROM persona WHERE mail <> ''").get().n;
  const conTel = db.prepare("SELECT COUNT(*) n FROM persona WHERE tels <> ''").get().n;
  console.log('--- resumen ---');
  console.log(JSON.stringify(t));
  console.log('con mail: ' + conMail + ' | con telefono: ' + conTel);
  const conEdad = db.prepare("SELECT COUNT(*) n FROM persona WHERE edad <> ''").get().n;
  const conFam = db.prepare("SELECT COUNT(*) n FROM persona WHERE familia <> ''").get().n;
  console.log('con fecha de nacimiento/edad: ' + conEdad + ' | con grupo familiar: ' + conFam);
  console.log('resultado: ' + SALIDA);
  const faltan = db.prepare("SELECT cuil, dni, estado, motivo FROM persona WHERE estado <> 'ok'").all();
  const nom = SALIDA.replace(/\.csv$/i, '') + '-faltantes.csv';
  if (faltan.length) {
    csv(nom, faltan.map((f) => [f.cuil || '', f.dni, f.estado, f.motivo || '']), ['cuil', 'dni', 'estado', 'motivo']);
    console.log('sin datos/error: ' + faltan.length + ' -> ' + nom);
  }
}
resumen();
process.exit(0);
