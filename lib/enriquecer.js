/* enriquecer.js — capa de enriquecimiento sobre una persona ya resuelta.
 *
 * Politica:
 * - mail y telefono: SINTETICO determinista (lib/faker-ar.js), solo si faltan.
 * - domicilio y fechaEjemplar: SOLO desde la cache del CNE (tabla `cne`).
 *   La red se usa unicamente si opts.red === true (y aun asi requiere captcha).
 *   El CNE no devuelve fecha de nacimiento: se declara `fechaEjemplar`.
 * - Nunca pisa un campo real ya presente. Si no hay dato, se declara AUSENTE.
 * - `__enriquecido` (no enumerable) evita re-enriquecer el mismo objeto.
 * - Cada campo agregado queda declarado en `_fuente`.
 */

import { generarSinteticos } from './faker-ar.js';
import * as cne from './cne.js';

const MARCAR = '__enriquecido';

/** Extrae un DNI de un objeto: dni/DNI, campos.dni.valor o los 8 digitos del CUIT. */
export function dniDe(p) {
  const bruto =
    p?.dni ??
    p?.DNI ??
    p?.campos?.dni?.valor ??
    p?.cuit ??
    p?.CUIT ??
    p?.cuil ??
    p?.CUIL;
  const d = String(bruto ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 11) return d.slice(2, 10);
  return d.length >= 4 ? d.padStart(8, '0').slice(-8) : '';
}

function nombreDe(p) {
  let nombre = p?.nombre ?? p?.nombres ?? p?.NOMBRE ?? p?.campos?.nombre?.valor;
  let apellido = p?.apellido ?? p?.apellidos ?? p?.APELLIDO ?? p?.campos?.apellido?.valor;

  /* Resultado de lib/resolver.js: campos.titular.valor = "APELLIDO, NOMBRE". */
  const titular = p?.campos?.titular?.valor;
  if ((!nombre || !apellido) && typeof titular === 'string' && titular.includes(',')) {
    const [a, n] = titular.split(',');
    apellido = apellido || a.trim();
    nombre = nombre || n.trim();
  }
  return {
    nombre: nombre ?? null,
    apellido: apellido ?? null,
    provincia: p?.provincia ?? p?.province ?? null,
    sexo: p?.sexo ?? p?.SEXO ?? p?.campos?.sexo?.valor ?? null,
  };
}

/* Un campo "existe" si no es null/undefined/''. Valor 0 cuenta como existente. */
const tiene = (v) => v !== null && v !== undefined && v !== '';

function distritoDe(provincia) {
  const clave = String(provincia ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().trim();
  if (/^(CABA|CIUDAD AUTONOMA DE BUENOS AIRES|CAPITAL FEDERAL)$/.test(clave)) return 1;
  if (/^(BUENOS AIRES|BSAS|PBA|PROVINCIA DE BUENOS AIRES)$/.test(clave)) return 2;
  if (clave === 'CATAMARCA') return 3;
  if (clave === 'CORDOBA') return 4;
  if (clave === 'CORRIENTES') return 5;
  if (clave === 'SANTA FE') return 21;
  if (/TIERRA DEL FUEGO/.test(clave)) return 24;
  return null;
}

function marcarSoloAusentes(valor) {
  const fuente = {};
  for (const campo of ['mail', 'telefono', 'domicilio', 'fechaEjemplar']) {
    if (!tiene(valor[campo])) {
      fuente[campo] = 'AUSENTE';
      valor[`${campo}_fuente`] = valor[`${campo}_fuente`] || 'AUSENTE';
    } else {
      fuente[campo] = valor[`${campo}_fuente`] || 'DESCONOCIDA';
    }
  }
  valor._fuente = fuente;
  if (!('cne_estado' in valor)) valor.cne_estado = 'AUSENTE';
  return valor;
}

/**
 * Enriquece UNA persona (o un array). Mutua el objeto y lo devuelve.
 * Idempotente: la segunda llamada no hace nada.
 *
 * @param {object|object[]} valor
 * @param {{red?:boolean, distrito?:number, sexo?:'m'|'f'|'x', codigo?:string, token?:string, forzar?:boolean}} [opts]
 */
export function enriquecerPersona(valor, opts = {}) {
  if (Array.isArray(valor)) return valor.map((v) => enriquecerPersona(v, opts));
  if (!valor || typeof valor !== 'object') return valor;

  /* Ya enriquecido: no se recalcula ni se pisa nada. */
  if (valor[MARCAR] === true) return valor;

  const definirMarca = (obj) => {
    try {
      Object.defineProperty(obj, MARCAR, { value: true, enumerable: false, configurable: true, writable: false });
    } catch (_) {
      obj[MARCAR] = true;
    }
    return obj;
  };

  /* Un resultado "no encontrado" no es una persona: no se le inventa contacto. */
  if (valor.encontrado === false) {
    marcarSoloAusentes(valor);
    return definirMarca(valor);
  }

  const dni = dniDe(valor);
  if (!dni) {
    marcarSoloAusentes(valor);
    return definirMarca(valor);
  }

  /* Resultado de lib/resolver.js: los campos viven en `campos`. Si ya hay
   * mail/telefono declarados ahi, se copian al nivel superior en vez de generar
   * otros distintos (el informe usa campos; la API usa el nivel superior). */
  const campos = valor.campos && typeof valor.campos === 'object' ? valor.campos : null;
  if (campos) {
    for (const k of ['mail', 'telefono']) {
      if (!tiene(valor[k]) && tiene(campos[k]?.valor)) {
        valor[k] = campos[k].valor;
        valor[`${k}_fuente`] = campos[k].fuente || 'SINTETICO';
      }
    }
  }

  const persona = nombreDe(valor);
  const fuente = {};
  const sinteticos = generarSinteticos(dni, persona);

  /* --- mail / telefono: solo si el campo no existe --- */
  if (!tiene(valor.mail)) {
    valor.mail = sinteticos.mail.valor;
    valor.mail_fuente = 'SINTETICO';
    valor.mail_regla = sinteticos.mail.regla;
    fuente.mail = 'SINTETICO';
  } else {
    fuente.mail = valor.mail_fuente || 'REAL';
  }

  if (!tiene(valor.telefono)) {
    valor.telefono = sinteticos.telefono.valor;
    valor.telefono_fuente = 'SINTETICO';
    valor.telefono_regla = sinteticos.telefono.regla;
    fuente.telefono = 'SINTETICO';
  } else {
    fuente.telefono = valor.telefono_fuente || 'REAL';
  }

  /* --- domicilio / fechaEjemplar: solo cache CNE (red solo si opts.red) --- */
  let c = null;
  try {
    c = cne.obtenerSync(dni, {
      red: opts.red === true,
      sinRed: opts.red !== true,
      distrito: opts.distrito ?? distritoDe(persona.provincia),
      sexo: opts.sexo ?? persona.sexo,
      codigo: opts.codigo,
      token: opts.token,
    });
  } catch (_) {
    c = null;
  }

  const hayCne = Boolean(c && c.fuente === 'REAL_CNE');

  for (const campo of ['domicilio', 'localidad', 'fechaEjemplar']) {
    if (!tiene(valor[campo])) {
      if (hayCne && tiene(c[campo])) {
        valor[campo] = c[campo];
        valor[`${campo}_fuente`] = 'REAL_CNE';
        fuente[campo] = 'REAL_CNE';
      } else {
        valor[campo] = null;
        valor[`${campo}_fuente`] = 'AUSENTE';
        fuente[campo] = 'AUSENTE';
      }
    } else {
      fuente[campo] = valor[`${campo}_fuente`] || (hayCne ? 'REAL_CNE' : 'REAL');
    }
  }

  if (hayCne) {
    valor.cne_estado = c.origen === 'CACHE' ? 'CACHE' : 'CONSULTADO';
    valor.cne_distrito = c.distrito ?? null;
  } else {
    valor.cne_estado = 'AUSENTE';
    valor.cne_motivo = c?.motivo || 'sin cache CNE';
  }

  valor._fuente = fuente;
  const previos = valor.sinteticos || {};
  valor.sinteticos = {
    mail: fuente.mail === 'SINTETICO' ? valor.mail : (previos.mail ?? null),
    telefono: fuente.telefono === 'SINTETICO' ? valor.telefono : (previos.telefono ?? null),
    fuente: 'SINTETICO',
  };

  return definirMarca(valor);
}

export { MARCAR };
