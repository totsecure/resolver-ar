/* persona-api.js — fuente PAGA por DNI, APAGADA por defecto.
 *
 * Se usa solo cuando se vende/resuelve una ficha puntual: consulta, guarda en
 * fuentes_personas (fuente API) y cachea para siempre. No se usa para cargas
 * masivas. Tope de gasto diario configurable.
 *
 * Config (datos/server.env), todas opcionales:
 *   PERSONA_API_URL=https://apistore.pcnt.io
 *   PERSONA_API_KEY=...
 *   PERSONA_API_MAX_DIA=50
 *   PERSONA_API_PATH=/v1/information/persons/identification
 *
 * Sin URL o KEY configuradas devuelve null y no hace nada.
 *
 * OJO: el contrato real de apistore.pcnt.io NO esta verificado. El mapeo de
 * abajo es best-effort segun los nombres de campo conocidos. Antes de dar por
 * bueno id_tramite_principal hay que compararlo con el tramite impreso de un
 * DNI conocido (9 vs 11 digitos).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as fuentes from './fuentes-datos.js';

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_USO = path.join(RAIZ, 'datos', 'persona-api-uso.json');

function env(k) {
  if (process.env[k]) return String(process.env[k]).trim();
  try {
    const txt = fs.readFileSync(path.join(RAIZ, 'datos', 'server.env'), 'utf8');
    return ((txt.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1] || '').trim().replace(/^["']|["']$/g, '');
  } catch (_) {
    return '';
  }
}

export function configurado() {
  return Boolean(env('PERSONA_API_URL') && env('PERSONA_API_KEY'));
}

function uso() {
  try { return JSON.parse(fs.readFileSync(RUTA_USO, 'utf8')); } catch (_) { return { fecha: '', n: 0 }; }
}

function anotarUso() {
  const hoy = new Date().toISOString().slice(0, 10);
  const u = uso();
  const n = u.fecha === hoy ? Number(u.n || 0) + 1 : 1;
  try { fs.mkdirSync(path.dirname(RUTA_USO), { recursive: true }); fs.writeFileSync(RUTA_USO, JSON.stringify({ fecha: hoy, n }, null, 2), { mode: 0o600 }); } catch (_) {}
  return n;
}

export function restanteHoy() {
  const max = Number(env('PERSONA_API_MAX_DIA') || 50);
  const u = uso();
  const hoy = new Date().toISOString().slice(0, 10);
  const usado = u.fecha === hoy ? Number(u.n || 0) : 0;
  return Math.max(0, max - usado);
}

function texto(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
}

/** Mapea la respuesta (nombres conocidos) a campos de fuentes_personas. */
export function interpretar(j) {
  const p = j && (j.data || j.persona || j.result || j);
  if (!p || typeof p !== 'object') return {};
  const calle = texto(p.calle);
  const numero = texto(p.numero ?? p.numero_calle);
  const piso = texto(p.piso);
  const depto = texto(p.departamento ?? p.depto);
  const dom = [calle, numero, piso ? 'PISO ' + piso : null, depto ? 'DEPTO ' + depto : null].filter(Boolean).join(' ') || null;
  return {
    apellido: texto(p.apellido),
    nombre: texto(p.nombres ?? p.nombre),
    fechaNac: texto(p.fecha_nacimiento),
    nroTramite: texto(p.id_tramite_principal ?? p.nro_tramite),
    cuit: texto(p.cuil),
    domicilio: dom,
    ciudad: texto(p.ciudad),
    provincia: texto(p.provincia),
    cpostal: texto(p.codigo_postal ?? p.cpostal),
    fallecido: p.codigo_fallecido != null ? Boolean(Number(p.codigo_fallecido)) : null,
  };
}

/**
 * Consulta la API paga para UN dni, respeta el tope diario y cachea en
 * fuentes_personas. Devuelve {datos, fuente} o null. Nunca lanza.
 */
export async function consultar(dni, opts = {}) {
  if (!configurado()) return null;
  const d = String(dni || '').replace(/\D/g, '');
  if (d.length < 6) return null;
  if (!opts.forzar && restanteHoy() <= 0) return null;

  const base = env('PERSONA_API_URL').replace(/\/+$/, '');
  const ruta = env('PERSONA_API_PATH') || '/v1/information/persons/identification';
  const url = base + ruta + (ruta.includes('?') ? '&' : '?') + 'dni=' + encodeURIComponent(d);
  const key = env('PERSONA_API_KEY');

  try {
    const r = await fetch(url, {
      headers: { accept: 'application/json', authorization: 'Bearer ' + key, 'x-api-key': key },
      signal: AbortSignal.timeout(Number(env('PERSONA_API_TIMEOUT_MS') || 12000)),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const datos = interpretar(j);
    const filas = [];
    for (const [campo, valor] of Object.entries(datos)) {
      if (campo === 'fallecido' || valor == null) continue;
      const v = fuentes.normalizarCampo(campo, valor);
      if (v != null) filas.push({ dni: d, campo, valor: v });
    }
    if (!filas.length) return null;
    fuentes.guardar(filas, { fuente: 'API', lote: 'api-' + new Date().toISOString().slice(0, 10), archivo: 'persona-api' });
    anotarUso();
    return { datos, fuente: 'API' };
  } catch (_) {
    return null;
  }
}

export default { configurado, consultar, interpretar, restanteHoy };
