/* persona.js - datos REALES de una persona desde la cache (cne/renaper/nosis).
 * Sin red por defecto: solo lee lo ya cacheado. Prioridad en fichas:
 * real (RENAPER/CNE) > NOSIS > provisto > sintetico.
 */
import * as renaper from './renaper.js';
import * as cne from './cne.js';
import * as nosis from './nosis.js';
import * as fuentes from './fuentes-datos.js';
import * as argos from './argos.js';

/* Nosis solo completa lo que las fuentes reales locales no trajeron.
 * RazonSocial/nombreCompleto se usa COMPLETO: nunca se parte por espacios
 * (apellidos compuestos). El apellido/nombre fino sigue saliendo del padron. */
function aplicarNosis(out, n) {
  if (!n || n.fuente !== 'NOSIS') return out;
  if (!out.direccion && n.domicilio) out.direccion = n.domicilio;
  if (!out.ciudad && n.ciudad) out.ciudad = n.ciudad;
  if (!out.provincia && n.provincia) out.provincia = n.provincia;
  const nombre = n.nombre || n.nombreCompleto || n.razonSocial || null;
  if (!out.nombre && nombre) out.nombre = nombre;
  if (!out.razonSocial && (n.razonSocial || nombre)) out.razonSocial = n.razonSocial || nombre;
  out.fuenteNosis = 'NOSIS';
  out.cuitNosis = n.cuit || null;
  return out;
}

export function real(dni) {
  const d = renaper.normalizarDni(dni);
  if (!d) return {};
  const out = {};
  try {
    const r = renaper.leer(d);
    if (r && ['REAL_RENAPER', 'MANUAL', 'TEXTO_REFERENCIA'].includes(String(r.fuente || '').toUpperCase())) {
      if (r.nroTramite) out.nroTramite = r.nroTramite;
      if (r.fechaNac) out.fechaNac = r.fechaNac;
      if (r.direccion) out.direccion = r.direccion;
      if (r.ciudad) out.ciudad = r.ciudad;
      if (r.provincia) out.provincia = r.provincia;
      if (r.cpostal) out.cpostal = r.cpostal;
      out.fuente = r.fuente;
    }
  } catch (_) {}
  try {
    const c = cne.leer(d);
    if (c && c.fuente === 'REAL_CNE') {
      if (!out.direccion && c.domicilio) out.direccion = c.domicilio;
      if (!out.ciudad && c.localidad) out.ciudad = c.localidad;
      if (!out.provincia && c.distrito != null && cne.DISTRITOS[c.distrito]) out.provincia = cne.DISTRITOS[c.distrito];
      out.fuenteCne = 'REAL_CNE';
    }
  } catch (_) {}
  /* Fuentes publicas cargadas con importar-fuente.mjs (padrones, AFIP, RENABAP).
   * Completan solo lo que RENAPER/CNE no trajeron; nunca pisan un dato local
   * mas confiable. El anio de nacimiento NO se usa como fechaNac. */
  try {
    const f = fuentes.leer(d);
    const v = f.valores || {};
    if (!out.apellido && v.apellido) out.apellido = v.apellido;
    if (!out.nombres && v.nombre) out.nombres = v.nombre;
    if (!out.nombre && (v.nombreCompleto || (v.apellido && v.nombre))) out.nombre = v.nombreCompleto || (v.apellido + ' ' + v.nombre);
    if (!out.direccion && v.domicilio) out.direccion = v.domicilio;
    if (!out.ciudad && v.ciudad) out.ciudad = v.ciudad;
    if (!out.provincia && v.provincia) out.provincia = v.provincia;
    if (!out.cpostal && v.cpostal) out.cpostal = v.cpostal;
    if (!out.fechaNac && v.fechaNac) out.fechaNac = v.fechaNac;
    if (!out.nroTramite && v.nroTramite) out.nroTramite = v.nroTramite;
    if (!out.anioNac && v.anioNac) out.anioNac = v.anioNac;
    if (Object.keys(v).length) out.fuenteFuentes = f.fuentes;
  } catch (_) {}

  /* Nosis: solo cache (real() es sincronica). Para red usar realAsync(). */
  try {
    aplicarNosis(out, nosis.cacheDeDni(d)); aplicarArgos(out, cacheArgos(d));
  } catch (_) {}
  return out;
}

/** Datos de fuentes publicas SOLO de cache, con su fuente por campo. */
export function fuentesDe(dni) {
  try {
    return fuentes.leer(dni);
  } catch (_) {
    return { valores: {}, fuentes: {} };
  }
}

/** Datos Nosis SOLO de cache, sin red. Nunca lanza. */
export function cacheNosis(dni) {
  try {
    return nosis.cacheDeDni(dni) || {};
  } catch (_) {
    return {};
  }
}

/** Datos Nosis por red (busqueda + informe) o solo cache. Nunca lanza. */
export async function nosisDe(dni, opts = {}) {
  try {
    return (await nosis.datosDeDni(dni, opts)) || {};
  } catch (_) {
    return {};
  }
}

/* Refresco de RENAPER en background: la ficha nunca espera 25 s a un servicio
 * caido. Se sirve cache y se actualiza para la proxima apertura. */
const refrescandoRen = new Set();

export function renaperRefrescar(dni, opts = {}) {
  const d = renaper.normalizarDni(dni);
  if (!d || refrescandoRen.has(d)) return false;
  refrescandoRen.add(d);
  renaper.obtener(d, {
    red: true,
    sinRed: false,
    genero: opts.genero,
    timeoutMs: opts.timeoutMs || Number(process.env.FICHA_TIMEOUT_MS || 4000),
    forzar: opts.forzar === true,
  }).catch(() => {}).finally(() => refrescandoRen.delete(d));
  return true;
}

export function renaperRefrescando(dni) {
  const d = renaper.normalizarDni(dni);
  return d ? refrescandoRen.has(d) : false;
}

/* Refresco en background: una ficha NUNCA espera a Nosis. Se deduplica por DNI
 * y usa timeout corto; el resultado queda en cache para la proxima apertura. */
const refrescando = new Set();

export function nosisRefrescar(dni, opts = {}) {
  const d = renaper.normalizarDni(dni);
  if (!d || refrescando.has(d)) return false;
  refrescando.add(d);
  nosisDe(d, { red: true, timeoutMs: opts.timeoutMs || 8000, forzar: opts.forzar === true })
    .catch(() => {})
    .finally(() => refrescando.delete(d));
  return true;
}

export function nosisRefrescando(dni) {
  const d = renaper.normalizarDni(dni);
  return d ? refrescando.has(d) : false;
}

/**
 * Igual que real() pero puede salir a Nosis ({red:true}).
 * Devuelve los valores ya mezclados + `fuentes` por campo y el crudo de cada fuente.
 * @returns {Promise<{direccion?:string, ciudad?:string, provincia?:string,
 *   nombre?:string, nroTramite?:string, fechaNac?:string, cpostal?:string,
 *   fuente?:string, fuenteNosis?:string, fuentes:Object<string,string>,
 *   renaper:object|null, cne:object|null, nosis:object}>}
 */
export async function realAsync(dni, opts = {}) {
  const d = renaper.normalizarDni(dni);
  if (!d) return { fuentes: {}, renaper: null, cne: null, nosis: {} };

  const base = real(d);
  const a = opts.red === true ? await argosDe(d, { forzar: opts.forzar === true }) : cacheArgos(d);
  let n = {};
  if (opts.red === true) n = await nosisDe(d, { red: true, forzar: opts.forzar === true });
  else n = cacheNosis(d);

  const out = { ...base };
  const fuentes = {};
  if (out.direccion) fuentes.direccion = out.fuente || out.fuenteCne || 'REAL';
  if (out.ciudad) fuentes.ciudad = out.fuente || out.fuenteCne || 'REAL';
  if (out.provincia) fuentes.provincia = out.fuente || out.fuenteCne || 'REAL';

  if (n && n.fuente === 'NOSIS') {
    if (!out.direccion && n.domicilio) { out.direccion = n.domicilio; fuentes.direccion = 'NOSIS'; }
    if (!out.ciudad && n.ciudad) { out.ciudad = n.ciudad; fuentes.ciudad = 'NOSIS'; }
    if (!out.provincia && n.provincia) { out.provincia = n.provincia; fuentes.provincia = 'NOSIS'; }
    if (!out.nombre && (n.nombre || n.nombreCompleto || n.razonSocial)) {
      out.nombre = n.nombre || n.nombreCompleto || n.razonSocial;
      fuentes.nombre = 'NOSIS';
    }
    out.fuenteNosis = 'NOSIS';
  }

  let ren = null;
  let cneFila = null;
  try { ren = renaper.leer(d); } catch (_) {}
  try { cneFila = cne.leer(d); } catch (_) {}

  if (a && a.fuente && a.fuente !== 'AUSENTE') {
    aplicarArgos(out, a);
    for (const c of ['direccion', 'ciudad', 'provincia', 'nombre']) if (a[c]) fuentes[c] = a.fuente;
    fuentes.titular = a.fuente;
  }
  return { ...out, fuentes, renaper: ren, cne: cneFila, nosis: n || {} };
}

export function hay(dni) {
  return Object.keys(real(dni)).length > 0;
}

/**
 * Fuente paga por DNI (apagada por defecto). Consulta, cachea en
 * fuentes_personas y devuelve realAsync actualizado. Si no esta configurada,
 * devuelve lo mismo que realAsync sin red paga.
 */
export async function conFuentePaga(dni, opts = {}) {
  const d = renaper.normalizarDni(dni);
  if (d) {
    try {
      const api = await import('./persona-api.js');
      if (api.configurado()) await api.consultar(d, { forzar: opts.forzar === true });
    } catch (_) {}
  }
  return realAsync(dni, opts);
}

/* Crear fuentes_personas al importar: una ficha no puede explotar por tabla
 * faltante si el proyecto se levanta desde cero. */
try { fuentes.asegurar(); } catch (_) {}

/* ARGOS es la fuente mas confiable: pisa lo que haya en out. */
function aplicarArgos(out, a) {
  if (!a || !a.fuente || a.fuente === 'AUSENTE') return out;
  const campos = ['apellido', 'nombre', 'nombreCompleto', 'fechaNac', 'cuit', 'direccion', 'ciudad', 'provincia', 'cpostal', 'nroTramite', 'telefono', 'mail', 'sexo'];
  for (const c of campos) { if (a[c]) out[c] = a[c]; }
  out.fallecido = a.fallecido === true;
  out.fuenteArgos = a.fuente;
  return out;
}

/** Datos ARGOS SOLO de cache (real() es sincronica). Nunca lanza. */
export function cacheArgos(dni) {
  try { return argos.cacheDeDni(dni) || {}; } catch (_) { return {}; }
}

/** Datos ARGOS por red o solo cache. Nunca lanza. */
export async function argosDe(dni, opts = {}) {
  try { return (await argos.datosDeDni(dni, opts)) || {}; } catch (_) { return {}; }
}
