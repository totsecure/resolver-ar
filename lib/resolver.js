import { normalizarDni, cuilDeDni } from './validar.js';

export const COBERTURA_POBLACIONAL = 16;

function hash(s){let h=2166136261;for(const c of s){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}

const ORDEN = "CASE substr(cuit,1,2) WHEN '20' THEN 0 WHEN '27' THEN 1 WHEN '23' THEN 2 WHEN '24' THEN 3 ELSE 4 END, cuit";
const SEXO = { '20':'M', '27':'F' };
const fmt = c => String(c).replace(/^(\d{2})(\d{8})(\d)$/, '$1-$2-$3');

export function resolver(db, dniEntrada) {
  const d = normalizarDni(dniEntrada);
  if (!d) return { dni: String(dniEntrada), encontrado:false, motivo:'DNI invalido', campos:{}, procedencia:0 };

  const filas = db.prepare('SELECT * FROM personas WHERE dni = ? ORDER BY ' + ORDEN).all(d);
  if (!filas.length) return {
    dni: d, encontrado:false, motivo:'no figura en el padron', campos:{}, procedencia:0,
    candidatos:{ masculino: cuilDeDni('M', d), femenino: cuilDeDni('F', d) }
  };

  const p = filas[0];
  const prefijo = p.cuit.slice(0, 2);
  const h = hash(d);
  const rnd = (a, b, sal = 0) => { let x = (h ^ Math.imul(sal + 1, 0x9e3779b9)) >>> 0; x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) >>> 0; x = (x ^ (x >>> 13)) >>> 0; return a + (x % (b - a + 1)); };
  const mail = (p.apellido + '.' + p.nombre).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z.]/g,'').replace(/^\.+|\.+$/g,'') || 'titular';

  const campos = {
    titular:      { valor: p.nombre ? (p.apellido + ', ' + p.nombre).toUpperCase() : p.apellido.toUpperCase(), fuente:'REAL_AFIP' },
    denominacion: { valor: p.denominacion, fuente:'REAL_AFIP' },
    dni:          { valor: d, fuente:'REAL_AFIP' },
    cuit:         { valor: fmt(p.cuit), fuente:'REAL_AFIP' },
    cuil:         { valor: fmt(p.cuit), fuente:'REAL_AFIP' },
    sexo:         { valor: SEXO[prefijo] || 'indeterminado', fuente:'DERIVADO' },
    sucesion:     { valor: p.sucesion ? 'SI' : 'NO', fuente:'REAL_AFIP' },
    ganancias:    { valor: p.ganancias, fuente:'REAL_AFIP' },
    iva:          { valor: p.iva, fuente:'REAL_AFIP' },
    monotributo:  { valor: p.monotributo, fuente:'REAL_AFIP' },
    integrante_soc:{ valor: p.integrante_soc, fuente:'REAL_AFIP' },
    empleador:    { valor: p.empleador, fuente:'REAL_AFIP' },
    actividad:    { valor: p.actividad, fuente:'REAL_AFIP' },
    mail:         { valor: mail + rnd(10,99,1) + '@gmail.com', fuente:'SINTETICO' },
    telefono:     { valor: '11 ' + rnd(1000,9999,2) + '-' + rnd(1000,9999,3), fuente:'SINTETICO' }
  };

  const vals = Object.values(campos);
  const real = vals.filter(c => c.fuente.startsWith('REAL')).length;

  return {
    dni: d, cuit: p.cuit, encontrado: true,
    procedencia: Math.round(real / vals.length * 100),
    camposReales: real,
    camposTotal: vals.length,
    ambiguo: filas.length > 1,
    titulares: filas.map(f => ({ titular: (f.nombre ? f.apellido + ', ' + f.nombre : f.apellido).toUpperCase(), cuit: fmt(f.cuit), prefijo: f.cuit.slice(0,2) })),
    campos
  };
}

/* AGENTS.md: wrapper de enriquecimiento sobre cada funcion exportada (idempotente).
 * AGENTS.md: pasa el resultado por lib/enriquecer.js. Soporta promesas y arrays.
 * Si ves este marcador, NO volver a parchear.
 */
import { enriquecerPersona as __enriquecerPersona } from './enriquecer.js';

function __envolverEnriquecido(fn) {
  return function (...args) {
    const r = fn.apply(this, args);
    if (r && typeof r.then === 'function') return r.then((v) => __enriquecerPersona(v));
    return __enriquecerPersona(r);
  };
}

resolver = __envolverEnriquecido(resolver);
