import { COBERTURA_POBLACIONAL } from './resolver.js';

const F = (k, v) => k.padEnd(15) + (v == null || v === '' ? 'NO INFORMADO' : v);
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Z ]/g,'').replace(/\s+/g,' ').trim();

export function renderizar(r, fuentes) {
  const L = [];

  if (!r.encontrado) {
    L.push('DNI ' + r.dni + ' - NO ENCONTRADO (' + (r.motivo || 'sin datos') + ')');
    L.push('');
    L.push('COBERTURA: el padron cubre ~' + COBERTURA_POBLACIONAL + '% de la poblacion.');
    L.push('No encontrado es el caso NORMAL, no un error del resolver.');
    if (r.candidatos) {
      L.push('');
      L.push('CUIL DERIVADO (sin verificar contra el padron):');
      L.push(F('  masculino', r.candidatos.masculino));
      L.push(F('  femenino', r.candidatos.femenino));
    }
    return L.join('\n');
  }

  const c = k => (r.campos[k] ? r.campos[k].valor : null);

  if (r.ambiguo) {
    L.push('*** DNI AMBIGUO: ' + r.titulares.length + ' titulares con este DNI ***');
    r.titulares.forEach((t, i) => L.push('  [' + (i+1) + '] ' + t.titular + '   CUIT ' + t.cuit + '   prefijo ' + t.prefijo));
    L.push('  Se informa el primero. Los datos de abajo son de ' + c('titular') + '.');
    L.push('');
  }

  L.push('DATOS TITULAR');
  ['titular','denominacion','dni','cuit','cuil','sexo'].forEach(k => L.push(F(k.toUpperCase(), c(k))));
  L.push(F('MAIL', c('mail')), F('TELEFONO', c('telefono')));
  L.push('', 'SITUACION IMPOSITIVA (REAL)');
  ['sucesion','ganancias','iva','monotributo','integrante_soc','empleador','actividad'].forEach(k => L.push(F(k.toUpperCase(), c(k))));

  L.push('', 'FUENTES EXTERNAS');
  if (!fuentes) L.push(F('BCRA', 'no consultado'));
  else if (fuentes.estado === 'SIN_DATOS') L.push(F('BCRA', 'sin registros (' + fuentes.detalle + ')'));
  else if (fuentes.estado !== 'DISPONIBLE') L.push(F('BCRA', 'NO DISPONIBLE (' + fuentes.detalle + ')'));
  else {
    L.push(F('BCRA PERIODO', fuentes.periodo));
    L.push(F('BCRA SITUACION', fuentes.situacion));
    L.push(F('BCRA DEUDA', fuentes.deudaTotal ? ('$' + fuentes.deudaTotal.toLocaleString('es-AR') + ' en ' + fuentes.entidades + ' entidad(es)') : 'sin financiaciones'));
    if (fuentes.detalle) L.push(F('BCRA DETALLE', fuentes.detalle));
    const a = norm(fuentes.denominacion), b = norm(r.campos.denominacion.valor);
    if (a && b) L.push(F('CRUCE NOMBRE', a === b ? 'coincide con el padron' : ('NO COINCIDE (BCRA dice "' + fuentes.denominacion + '")')));
  }

  L.push('', 'PROCEDENCIA REAL_AFIP: ' + r.procedencia + '% (' + r.camposReales + '/' + r.camposTotal + ' CAMPOS del informe; NO es cobertura poblacional)');
  L.push('COBERTURA POBLACIONAL DEL PADRON: ~' + COBERTURA_POBLACIONAL + '%');

  return L.join('\n');
}

/* AGENTS.md: wrapper de informe: enriquecimiento + linea de cobertura (idempotente).
 * AGENTS.md: si el resultado es string sin "COBERTURA POBLACIONAL" se agrega
 * lineaCobertura(); si es objeto se setea .cobertura. Soporta promesas y arrays.
 * Si ves este marcador, NO volver a parchear.
 */
import { enriquecerPersona as __enriquecerInforme } from './enriquecer.js';
import { lineaCobertura as __lineaCobertura } from './cobertura.js';

function __postInforme(resultado) {
  const v = __enriquecerInforme(resultado);
  if (typeof v === 'string') {
    return v.includes('COBERTURA POBLACIONAL') ? v : v + '\n\n' + __lineaCobertura();
  }
  if (v && typeof v === 'object') {
    if (!v.cobertura) v.cobertura = __lineaCobertura();
    return v;
  }
  return v;
}

function __envolverInforme(fn) {
  return function (...args) {
    const r = fn.apply(this, args);
    if (r && typeof r.then === 'function') return r.then(__postInforme);
    return __postInforme(r);
  };
}

renderizar = __envolverInforme(renderizar);
