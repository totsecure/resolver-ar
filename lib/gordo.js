/* gordo.js - fuente real via la API del panel de checkeo (IP ya autorizada en ARGOS).
 * GET /api/dni/<dni> devuelve un objeto plano con base local + RENAPER.
 * Nunca lanza: devuelve {fuente:'AUSENTE', motivo}.
 */
export const BASE = process.env.GORDO_BASE || 'http://104.234.7.128:5000';
const RUTA = '/api/dni/';
let ultimo = 0;
const SEPARACION = Number(process.env.GORDO_MS || 400);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const titulo = (s) => String(s || '').replace(/_/g,' ').replace(/\s+/g,' ').trim();
function fechaBr(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? m[3]+'/'+m[2]+'/'+m[1] : null; }

export function normalizarDni(v) {
  const s = String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
  return s.length >= 7 && s.length <= 9 ? s : null;
}

export function interpretar(d, dni) {
  if (!d) return null;
  const out = { fuente: 'ARGOS_DNI', dni: dni };
  const nd = titulo(d.nombre_completo || d.nombre_renaper || d.nombre_db);
  if (nd) {
    const partes = nd.split(' ');
    if (partes.length > 1) { out.apellido = partes[0]; out.nombre = partes.slice(1).join(' '); }
    out.nombreCompleto = nd;
  }
  if (d.sexo_renaper || d.sexo) out.sexo = String(d.sexo_renaper || d.sexo).toUpperCase();
  out.fechaNac = fechaBr(d.fecha_nacimiento_renaper || d.fecha_nacimiento);
  const cuil = String(d.cuil_renaper || d.cuil || '').replace(/\D/g, '');
  if (cuil) out.cuit = cuil;
  let dir = titulo(d.direccion_renaper || d.direccion_actual || d.direccion_db);
  if (!d.direccion_renaper && dir) {
    const num = String(d.numero || '').trim();
    if (num && dir.indexOf(num) === -1) dir = dir+' '+num;
    if (d.piso) dir = dir+' PISO '+d.piso;
    if (d.departamento) dir = dir+' DEPTO '+d.departamento;
  }
  out.direccion = dir || null;
  out.ciudad = titulo(d.localidad_renaper || d.localidad || d.ciudad_renaper);
  out.provincia = titulo(d.provincia_renaper || d.provincia);
  out.cpostal = d.codigo_postal ? String(d.codigo_postal).trim() : null;
  out.nroTramite = d.tramite_principal ? String(d.tramite_principal).trim() : null;
  out.fallecido = d.fallecido === true || String(d.fallecido) === 'true' || Number(d.fallecido) === 1;
  const tel = Array.isArray(d.telefonos_asociados) ? d.telefonos_asociados[0] : null;
  out.telefono = tel ? String(tel).trim() : null;
  out.mail = d.correo_electronico ? String(d.correo_electronico).trim().toLowerCase() : null;
  if (Array.isArray(d.grupo_familiar_detectado)) out.familia = d.grupo_familiar_detectado.slice(0, 12).map((f) => ({ dni: f.dni, nombre: f.nombre_completo, edad: f.edad, parentesco: f.parentesco_deducido_ia }));
  if (Array.isArray(d.domicilios_padron_o_historicos)) out.domicilios = d.domicilios_padron_o_historicos.slice(0, 8);
  if (d.edad_actual) out.edad = Number(d.edad_actual);
  if (d.signo_zodiacal) out.signo = String(d.signo_zodiacal);
  if (d.documento_emision) out.emision = String(d.documento_emision);
 if (d.documento_vencimiento) out.vencimiento = String(d.documento_vencimiento);
 if (d.ejemplar) out.ejemplar = String(d.ejemplar);
 if (d.id_ciudadano) out.idCiudadano = String(d.id_ciudadano);
 if (d.barrio) out.barrio = String(d.barrio);
 if (d.info_fallecimiento) out.infoFallecimiento = String(d.info_fallecimiento);
 if (d.fallecimiento_origen) out.fallecimientoOrigen = String(d.fallecimiento_origen);
  out.renaperEncontrado = d.renaper_encontrado === true || String(d.renaper_encontrado) === 'true';
  /* Copias crudas de RENAPER, sin pisar el dato principal: sirven para que el
   * server pueda avisar cuando RENAPER dice algo distinto. */
  out.nombreRenaper = d.nombre_renaper ? titulo(d.nombre_renaper) : null;
  out.fechaNacRenaper = fechaBr(d.fecha_nacimiento_renaper);
  out.cuilRenaper = String(d.cuil_renaper || '').replace(/\D/g, '') || null;
  return out;
}

/* Vistas parciales sobre el mismo JSON: una solo pide la base local,
 * otra solo lo que vino de RENAPER. Sirven para comparar fuentes.
 */
export function soloLocal(d, dni) {
  const out = { fuente: 'ARGOS_LOCAL', dni: dni };
  if (!d) return out;
  const nd = titulo(d.nombre_completo || d.nombre_db);
  if (nd) out.nombreCompleto = nd;
  out.direccion = titulo(d.direccion_db || d.direccion_actual) || null;
  out.ciudad = titulo(d.localidad) || null;
  out.provincia = titulo(d.provincia) || null;
  out.cpostal = d.codigo_postal ? String(d.codigo_postal).trim() : null;
  out.mail = d.correo_electronico ? String(d.correo_electronico).trim().toLowerCase() : null;
  const tel = Array.isArray(d.telefonos_asociados) ? d.telefonos_asociados[0] : null;
  out.telefono = tel ? String(tel).trim() : null;
  const cuil = String(d.cuil || '').replace(/D/g, '');
  if (cuil) out.cuit = cuil;
  if (d.edad_actual) out.edad = Number(d.edad_actual);
  if (Array.isArray(d.domicilios_padron_o_historicos)) out.domicilios = d.domicilios_padron_o_historicos.slice(0, 8);
  return out;
}

export function soloRenaper(d, dni) {
  const out = { fuente: 'ARGOS_RENAPER', dni: dni };
  if (!d) return out;
  const nd = titulo(d.nombre_renaper || d.nombre_completo);
  if (nd) {
    const p = nd.split(' ');
    if (p.length > 1) { out.apellido = p[p.length - 1]; out.nombre = p.slice(0, p.length - 1).join(' '); }
    out.nombreCompleto = nd;
  }
  out.fechaNac = fechaBr(d.fecha_nacimiento_renaper || d.fecha_nacimiento);
  const cuil = String(d.cuil_renaper || d.cuil || '').replace(/D/g, '');
  if (cuil) out.cuit = cuil;
  out.direccion = titulo(d.direccion_renaper) || null;
  out.cpostal = d.codigo_postal ? String(d.codigo_postal).trim() : null;
  out.nroTramite = d.tramite_principal ? String(d.tramite_principal).trim() : null;
  if (d.documento_emision) out.emision = String(d.documento_emision);
  if (d.documento_vencimiento) out.vencimiento = String(d.documento_vencimiento);
  out.fallecido = d.fallecido === true || String(d.fallecido) === 'true';
  if (d.info_fallecimiento) out.infoFallecimiento = String(d.info_fallecimiento);
  out.renaperEncontrado = d.renaper_encontrado === true || String(d.renaper_encontrado) === 'true';
  /* Copias crudas de RENAPER, sin pisar el dato principal: sirven para que el
   * server pueda avisar cuando RENAPER dice algo distinto. */
  out.nombreRenaper = d.nombre_renaper ? titulo(d.nombre_renaper) : null;
  out.fechaNacRenaper = fechaBr(d.fecha_nacimiento_renaper);
  out.cuilRenaper = String(d.cuil_renaper || '').replace(/\D/g, '') || null;
  return out;
}

export async function crudo(dniBruto) {
  const d = normalizarDni(dniBruto);
  if (!d) return null;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    const r = await fetch(BASE + RUTA + d, { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch (_) { return null; }
}
export async function health() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch(BASE+'/api/health', { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, motivo: 'http '+r.status };
    return { ok: true, json: await r.json().catch(() => null) };
  } catch (e) { return { ok: false, motivo: String(e && e.message ? e.message : e) }; }
}

export async function datos(dniBruto) {
  const d = normalizarDni(dniBruto);
  if (!d) return { fuente: 'AUSENTE', motivo: 'dni invalido' };
  const espera = SEPARACION - (Date.now() - ultimo);
  if (espera > 0) await esperar(espera);
  ultimo = Date.now();
  let motivo = 'sin respuesta';
  for (let i = 1; i <= 2; i++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 25000);
    try {
      const r = await fetch(BASE+RUTA+d, { signal: c.signal, headers: { accept: 'application/json' } });
      if (r.status === 200) {
        const j = await r.json().catch(() => null);
        const out = interpretar(j, d);
        if (!out) return { fuente: 'AUSENTE', motivo: 'respuesta invalida' };
        return out;
      }
      if (r.status === 404) return { fuente: 'AUSENTE', motivo: 'sin datos' };
      if (r.status === 429) { motivo = 'rate limit'; await esperar(3000); continue; }
      motivo = 'http '+r.status;
    } catch (e) {
      motivo = e && e.name === 'AbortError' ? 'timeout' : String(e && e.message ? e.message : e);
      await esperar(1500);
    } finally { clearTimeout(t); }
  }
  return { fuente: 'AUSENTE', motivo: motivo };
}

export default { BASE, datos, health, interpretar, normalizarDni };
