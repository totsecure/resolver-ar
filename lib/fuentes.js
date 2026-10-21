// Fuentes externas. NO BLOQUEANTES: si fallan, el informe sale igual con estado explicito.
const TIMEOUT_MS = 8000;
const INTENTOS = 2;
const esperar = ms => new Promise(r => setTimeout(r, ms));

async function traer(url, opciones = {}) {
  let ultimo = { ok: false, http: 0, detalle: 'sin intentos' };
  for (let i = 1; i <= INTENTOS; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { ...opciones, signal: ctrl.signal });
      const texto = await r.text();
      clearTimeout(t);
      if (!r.ok) {
        ultimo = { ok: false, http: r.status, detalle: 'HTTP ' + r.status, cuerpo: texto.slice(0, 400) };
        if (r.status >= 500 && i < INTENTOS) { await esperar(600 * i); continue; }
        return ultimo;
      }
      let json = null;
      try { json = JSON.parse(texto); } catch {}
      if (!json) return { ok: false, http: r.status, detalle: 'respuesta no-JSON', cuerpo: texto.slice(0, 400) };
      return { ok: true, http: r.status, json };
    } catch (e) {
      clearTimeout(t);
      ultimo = { ok: false, http: 0, detalle: e.name === 'AbortError' ? ('timeout ' + TIMEOUT_MS + 'ms') : e.message };
      if (i < INTENTOS) { await esperar(600 * i); continue; }
    }
  }
  return ultimo;
}

const SITUACION = { 1:'1 normal', 2:'2 riesgo bajo', 3:'3 con problemas', 4:'4 alto riesgo', 5:'5 irrecuperable', 6:'6 irrecup. disp. tecnica' };

export async function consultarBcra(cuit) {
  const r = await traer('https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/' + cuit, { headers: { Accept: 'application/json' } });
  if (r.http === 404) {
    let msg = 'sin registros en la Central de Deudores';
    try { const j = JSON.parse(r.cuerpo); if (j.errorMessages) msg = j.errorMessages.join(' '); } catch {}
    return { fuente: 'BCRA', estado: 'SIN_DATOS', detalle: msg };
  }
  if (!r.ok) return { fuente: 'BCRA', estado: 'NO_DISPONIBLE', detalle: r.detalle };
  const res = (r.json || {}).results;
  if (!res) return { fuente: 'BCRA', estado: 'NO_DISPONIBLE', detalle: 'sin campo results' };
  const periodos = res.periodos || [];
  if (!periodos.length) return { fuente: 'BCRA', estado: 'DISPONIBLE', denominacion: res.denominacion, periodo: '-', situacion: 'sin financiaciones', deudaTotal: 0, entidades: 0 };
  const ents = periodos[0].entidades || [];
  const sit = ents.map(e => Number(e.situacion) || 0);
  const peor = sit.length ? Math.max(...sit) : 0;
  const total = ents.reduce((a, e) => a + (Number(e.monto) || 0), 0);
  return {
    fuente: 'BCRA', estado: 'DISPONIBLE', periodo: periodos[0].periodo,
    denominacion: res.denominacion, situacion: SITUACION[peor] || ('situacion ' + peor),
    deudaTotal: total, entidades: ents.length,
    detalle: ents.map(e => e.entidad + ' [sit ' + e.situacion + '] $' + e.monto).join(' | ')
  };
}

// El backend del padron-api de la CNE esta intermitente (503). Best-effort, sin bloquear.
export async function consultarCne(dni) {
  const r = await traer('https://www.padron.gov.ar/padron-api/consulta', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dni: Number(dni) })
  });
  if (!r.ok) return { fuente: 'CNE', estado: 'NO_DISPONIBLE', detalle: r.detalle, crudo: r.cuerpo };
  return { fuente: 'CNE', estado: 'DISPONIBLE', json: r.json };
}
