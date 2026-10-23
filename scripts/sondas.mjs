/* sondas.mjs — sondeo de fuentes reales de identidad (T2).
 *
 *   node scripts/sondas.mjs
 *
 * Prueba cada endpoint por camino directo (Mac) y por el Worker (/proxy),
 * guarda el cuerpo crudo en /tmp/sonda-<nombre>-<camino>.txt y reporta:
 *   fuente | camino | status | bytes | nacimiento | domicilio | tramite | veredicto
 *
 * No explota si una sonda falla. No entra al humo (depende de terceros).
 * Al final imprime hallazgos de recon (formularios, captcha, XHR) y una
 * recomendacion por campo.
 */
import fs from 'node:fs';

const ENV = '/Users/bunker/resolver/datos/server.env';
const TOKEN = ((fs.readFileSync(ENV, 'utf8').match(/^RESOLVER_TOKEN=(.*)$/m) || [, ''])[1] || '').trim();
const WORKER = 'https://resolver-api.correonube.workers.dev/proxy';
const DNI = process.argv[2] || '30756789';
const CUIT = process.argv[3] || '20307567890';
const BIN = process.argv[4] || '516585';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const T = Number(process.env.SONDA_TIMEOUT_MS || 15000);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const alcanzables = new Map();

async function alcanza(host) {
  if (alcanzables.has(host)) return alcanzables.get(host);
  try {
    await fetch('https://' + host + '/', { method: 'GET', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000), redirect: 'manual' });
    alcanzables.set(host, true);
  } catch (_) {
    alcanzables.set(host, false);
  }
  return alcanzables.get(host);
}

function urlWorker(s) {
  const q = new URLSearchParams({ u: s.url, token: TOKEN });
  if (s.metodo && s.metodo !== 'GET') q.set('m', s.metodo);
  if (s.cuerpo) q.set('b', s.cuerpo);
  if (s.ct) q.set('ct', s.ct);
  if (s.headers) q.set('h', JSON.stringify(s.headers));
  q.set('r', 'manual');
  return WORKER + '?' + q.toString();
}

function valoresJson(j, out = [], ruta = '') {
  if (Array.isArray(j)) {
    j.forEach((v, i) => valoresJson(v, out, ruta + '[' + i + ']'));
  } else if (j && typeof j === 'object') {
    for (const [k, v] of Object.entries(j)) {
      if (v && typeof v === 'object') valoresJson(v, out, ruta + '.' + k);
      else if (v !== null && v !== undefined && String(v).trim() !== '') out.push([ruta + '.' + k, k, String(v)]);
    }
  }
  return out;
}

function buscarJson(pares, re) {
  return pares.find(([, k, v]) => re.test(k) && !/^(null|undefined)$/i.test(v)) || null;
}

function extraerFecha(texto) {
  const m = String(texto).match(/(?:fecha[_ ]?nacimiento|birth_date|fechanacimiento)["'\\s:=]+([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{2}\/[0-9]{2}\/[0-9]{4})/i);
  return m ? m[1] : null;
}

function analizar(texto) {
  const t = String(texto || '');
  const tl = t.toLowerCase();
  const out = { nacimiento: null, domicilio: null, tramite: null, nombre: null, json: null, html: /<\/?[a-z][\s\S]*>/i.test(t) };

  /* JSON: solo cuentan VALORES no vacios (SISA devuelve el schema con nulls). */
  try {
    const j = JSON.parse(t);
    out.json = j;
    const pares = valoresJson(j);
    out.nacimiento = buscarJson(pares, /fecha_?nac|birth_?date|fechanac/i);
    out.domicilio = buscarJson(pares, /domicilio|address|calle/i);
    out.tramite = buscarJson(pares, /tramite|procedure_?number|id_tramite/i);
    out.nombre = buscarJson(pares, /razon_?social|apellido|^name$|first_?name|last_?name/i);
    if (j && Array.isArray(j.EntidadesEncontradas) && j.EntidadesEncontradas.length) out.nombre = ['EntidadesEncontradas', 'EntidadesEncontradas', j.EntidadesEncontradas[0].RazonSocial];
    return out;
  } catch (_) {}

  /* XML. */
  const xml = (tag) => {
    const m = t.match(new RegExp('<' + tag + '>([^<]+)</' + tag + '>', 'i'));
    return m && m[1].trim() && !/^null$/i.test(m[1].trim()) ? [tag, tag, m[1].trim()] : null;
  };
  out.nacimiento = xml('fechaNacimiento');
  out.domicilio = xml('domicilio');
  out.tramite = xml('tramite');

  /* HTML con datos visibles (cuitonline). */
  if (/cuitonline/i.test(t)) {
    const m = t.match(/([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){1,6})\s*-\s*(\d{11})/i);
    if (m) out.nombre = ['html', 'nombre', m[1] + ' (' + m[2] + ')'];
  }
  return out;
}

function veredicto(r, a, texto) {
  if (!r) return 'sin respuesta';
  if (r.status === 0) return 'timeout / no alcanza';
  if (r.status === 400) return /host no permitido/.test(texto) ? 'host no permitido' : 'bad request';
  if (r.status === 401 || r.status === 403) return 'auth / bloqueado';
  if (r.status === 405) return 'method not allowed (405)';
  if (r.status === 404) return 'no existe';
  if (r.status === 429) return 'rate limit';
  if (r.status >= 500) return 'error servidor (' + r.status + ')';

  if (a.json) {
    if (a.nacimiento || a.domicilio || a.tramite) return 'DATOS';
    if (a.json.scheme && a.json.bank) return 'datos BIN';
    if (/ERROR_AUTENTICACION|INVALID_LOGIN|token|login/i.test(texto)) return 'auth (sin credenciales)';
    if (a.json.ExigirCaptcha === true) return 'captcha';
    if (a.nombre) return 'datos nombre/CUIT';
    if (a.json.status && a.json.status.mode) return 'config (sin consulta)';
    return 'JSON sin datos';
  }
  if (a.nombre && /cuitonline/i.test(texto)) return 'datos nombre/CUIT';
  if (/<wsdl:definitions|<definitions/i.test(texto)) return 'WSDL (sin datos)';
  if (/incapsula|_Incapsula_Resource/i.test(texto)) return 'incapsula / bloqueado';
  if (/api - documentaci[oó]n|swagger|aglio/i.test(texto)) return 'documentacion (contrato)';
  if (/ag-captcha|recaptcha|captcha/i.test(texto)) return 'formulario + captcha';
  if (/<form/i.test(texto)) return 'formulario (sin datos)';
  if (a.nombre) return 'datos nombre/CUIT';
  return 'HTML (revisar)';
}

async function pedirDirecto(s) {
  try {
    const r = await fetch(s.url, {
      method: s.metodo || 'GET',
      headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...(s.headers || {}) },
      body: s.metodo && s.metodo !== 'GET' ? (s.cuerpo || '') : undefined,
      signal: AbortSignal.timeout(T),
      redirect: 'manual',
    });
    return { status: r.status, texto: await r.text(), final: r.headers.get('location') || '', headers: r.headers };
  } catch (e) {
    return { status: 0, texto: 'ERR ' + ((e && e.cause && e.cause.code) || (e && e.message) || String(e)), final: '', headers: new Headers() };
  }
}

async function pedirWorker(s) {
  try {
    const r = await fetch(urlWorker(s), { signal: AbortSignal.timeout(T + 10000) });
    return { status: r.status, texto: await r.text(), final: r.headers.get('x-final') || '', loc: r.headers.get('x-location') || '', headers: r.headers };
  } catch (e) {
    return { status: 0, texto: 'ERR ' + ((e && e.cause && e.cause.code) || (e && e.message) || String(e)), final: '', headers: new Headers() };
  }
}

function guardar(nombre, camino, texto) {
  try { fs.writeFileSync('/tmp/sonda-' + nombre + '-' + camino + '.txt', String(texto || '')); } catch (_) {}
}

const SONDAS = [
  { nombre: 'sisa-puco', host: 'sisa.msal.gov.ar', url: 'https://sisa.msal.gov.ar/sisa/services/rest/puco/' + DNI },
  { nombre: 'sisa-cmdb-sin', host: 'sisa.msal.gov.ar', url: 'https://sisa.msal.gov.ar/sisa/services/rest/cmdb/obtener?nrodoc=' + DNI },
  { nombre: 'sisa-cmdb-userpass', host: 'sisa.msal.gov.ar', url: 'https://sisa.msal.gov.ar/sisa/services/rest/cmdb/obtener?nrodoc=' + DNI + '&usuario=user&clave=pass' },
  { nombre: 'sisa-cmdb-generico', host: 'sisa.msal.gov.ar', url: 'https://sisa.msal.gov.ar/sisa/services/rest/cmdb/obtener?nrodoc=' + DNI + '&usuario=X&clave=Y' },
  { nombre: 'sisa-wsdl', host: 'sisa.msal.gov.ar', url: 'https://sisa.msal.gov.ar/sisa/services/pucoService?wsdl' },
  { nombre: 'mi-ejemplar', host: 'tramites.renaper.gob.ar', url: 'https://tramites.renaper.gob.ar/mi_ejemplar/' },
  { nombre: 'mi-ejemplar-busqueda', host: 'tramites.renaper.gob.ar', url: 'https://tramites.renaper.gob.ar/mi_ejemplar/busqueda.php', metodo: 'POST', ct: 'application/x-www-form-urlencoded', cuerpo: 'dni=' + DNI + '&fecha=1984-04-25&action=submit_tramite&token=' },
  { nombre: 'afip-constancia', host: 'seti.afip.gob.ar', url: 'https://seti.afip.gob.ar/padron-puc-constancia-internet/ConsultaConstanciaAction.do' },
  { nombre: 'afip-constancia-jsp', host: 'seti.afip.gob.ar', url: 'https://seti.afip.gob.ar/padron-puc-constancia-internet/jsp/Constancia.jsp' },
  { nombre: 'padron-home', host: 'www.padron.gob.ar', url: 'https://www.padron.gob.ar/' },
  { nombre: 'padron-config', host: 'www.padron.gob.ar', url: 'https://www.padron.gob.ar/padron-api/config/web.json' },
  { nombre: 'padron-consulta', host: 'www.padron.gob.ar', url: 'https://www.padron.gob.ar/padron-api/consulta', metodo: 'POST', ct: 'application/x-www-form-urlencoded', cuerpo: 'c=&e=&m=' + DNI + '&d=1&s=m' },
  { nombre: 'cuitonline', host: 'www.cuitonline.com', url: 'https://www.cuitonline.com/search.php?q=' + DNI },
  { nombre: 'binlist', host: 'lookup.binlist.net', url: 'https://lookup.binlist.net/' + BIN, headers: { accept: 'application/json' } },
  { nombre: 'bincheck', host: 'bincheck.io', url: 'https://bincheck.io/es/' + BIN },
  { nombre: 'nosis-buscar', host: 'informes.nosis.com', url: 'https://informes.nosis.com/Home/Buscar', metodo: 'POST', ct: 'application/x-www-form-urlencoded', cuerpo: 'Busqueda.Texto=' + DNI, headers: { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json' } },
  { nombre: 'anses-constacuil', host: 'servicioswww.anses.gob.ar', url: 'https://servicioswww.anses.gob.ar/C2-ConstaCUIL' },
  { nombre: 'apistore-docs', host: 'apistore.pcnt.io', url: 'https://apistore.pcnt.io/v1/information/persons/identification?dni=' + DNI },
  { nombre: 'apistore-login', host: 'apistore.pcnt.io', url: 'https://apistore.pcnt.io/v1/login/jwt', metodo: 'POST', ct: 'application/json', cuerpo: JSON.stringify({ username: 'x', password: 'y' }) },
  { nombre: 'apistore-cuit', host: 'apistore.pcnt.io', url: 'https://apistore.pcnt.io/v1/information/persons/' + DNI },
  { nombre: 'apistore-renaper', host: 'apistore.pcnt.io', url: 'https://apistore.pcnt.io/v1/information/person-renaper/' + DNI + '/gender/M' },
  { nombre: 'apistore-afip', host: 'apistore.pcnt.io', url: 'https://apistore.pcnt.io/v1/information/person/' + CUIT },
  { nombre: 'apistore-barcode', host: 'apistore.pcnt.io', url: 'https://apistore.pcnt.io/v1/information/barcode', metodo: 'POST', ct: 'application/json', cuerpo: '{}' },
  { nombre: 'dateas', host: 'www.dateas.com', url: 'https://www.dateas.com/' },
];

const resultados = [];
const costoDe = (nombre) => /^apistore/.test(nombre) ? 'pago' : (nombre === 'dateas' ? 'pago' : (nombre === 'nosis-buscar' ? 'pago' : 'gratis'));
console.log('SONDAS resolver-ar — ' + new Date().toISOString());
console.log('DNI=' + DNI + '  CUIT=' + CUIT + '  BIN=' + BIN + '  timeout=' + T + 'ms\n');

for (const s of SONDAS) {
  const host = new URL(s.url).hostname;
  const paths = [];
  if (await alcanza(host)) paths.push(['directo', pedirDirecto]);
  paths.push(['worker', pedirWorker]);

  for (const [camino, fn] of paths) {
    const r = await fn(s);
    guardar(s.nombre, camino, r.texto);
    const a = analizar(r.texto);
    const v = veredicto(r, a, r.texto);
    resultados.push({
      fuente: s.nombre, camino, costo: costoDe(s.nombre), status: r.status, bytes: r.texto.length,
      nacimiento: a.nacimiento, domicilio: a.domicilio, tramite: a.tramite,
      fecha: a.fecha, veredicto: v,
      final: r.final || r.loc || '',
    });
    await dormir(350);
  }
}

/* ------------------------------- tabla ---------------------------------- */
const W = [24, 8, 7, 7, 7, 5, 5, 6, 22];
const linea = (c) => c.map((v, i) => String(v).padEnd(W[i]).slice(0, W[i])).join(' | ');
console.log(linea(['fuente', 'camino', 'costo', 'status', 'bytes', 'nac', 'dom', 'tram', 'veredicto']));
console.log(W.map((n) => '-'.repeat(n)).join('-+-'));
for (const r of resultados) {
  console.log(linea([r.fuente, r.camino, r.costo, r.status || '-', r.bytes, r.nacimiento ? 'SI' : '-', r.domicilio ? 'SI' : '-', r.tramite ? 'SI' : '-', r.veredicto]));
}

/* ------------------------------- recon ---------------------------------- */
console.log('\n=== RECON (formularios / JS / captcha) ===');
const leer = (n, c) => { try { return fs.readFileSync('/tmp/sonda-' + n + '-' + c + '.txt', 'utf8'); } catch (_) { return ''; } };

const htmlMi = leer('mi-ejemplar', 'worker') || leer('mi-ejemplar', 'directo');
if (htmlMi) {
  const inputs = [...htmlMi.matchAll(/<input[^>]*name="([^"]+)"[^>]*>/gi)].map((m) => m[1]);
  const recaptcha = (htmlMi.match(/recaptcha\/api\.js\?render=([^"&]+)/i) || [, ''])[1];
  console.log('- mi_ejemplar: inputs=[' + inputs.join(',') + '] recaptcha_v3=' + (recaptcha ? 'SI (' + recaptcha.slice(0, 18) + '...)' : 'no'));
  console.log('  POST busqueda.php con dni+fecha+token recaptcha; la fecha de nacimiento es INPUT, no output.');
}
const jsMi = leer('mi-ejemplar', 'worker');
if (jsMi) {
  const src = [...jsMi.matchAll(/<script[^>]*src="([^"]+)"/gi)].map((m) => m[1]).filter((x) => /main\.js/.test(x));
  if (src.length) console.log('  bundle: ' + src[0]);
}

const htmlAfip = leer('afip-constancia', 'directo') || leer('afip-constancia', 'worker');
if (htmlAfip) {
  const iframe = (htmlAfip.match(/<iframe[^>]*src="([^"]+)"/i) || [, ''])[1];
  console.log('- afip_constancia: iframe=' + (iframe || 'no') + '; captcha=' + (/ag-captcha|captcha/i.test(htmlAfip) ? 'SI' : 'no'));
}
const jspAfip = leer('afip-constancia-jsp', 'directo') || leer('afip-constancia-jsp', 'worker');
if (jspAfip) {
  const campos = [...jspAfip.matchAll(/<(?:input|select)[^>]*name="([^"]+)"/gi)].map((m) => m[1]);
  console.log('  Constancia.jsp campos=[' + [...new Set(campos)].join(',') + '] captcha=' + (/ag-captcha|tokenCaptcha/i.test(jspAfip) ? 'SI (imagen + logica)' : 'no'));
}

const cfgPad = leer('padron-config', 'directo') || leer('padron-config', 'worker');
if (cfgPad) {
  try {
    const j = JSON.parse(cfgPad);
    console.log('- padron: status.mode=' + (j.status && j.status.mode) + ' distritos=' + ((j.distritos || []).length) + ' (consulta con captcha; hoy 503)');
  } catch (_) { console.log('- padron: config no-JSON (' + cfgPad.slice(0, 80) + ')'); }
}

const anses = leer('anses-constacuil', 'directo') || leer('anses-constacuil', 'worker');
if (anses) console.log('- anses: ' + (/incapsula/i.test(anses) ? 'Incapsula 403 (bloqueado)' : 'http ' + anses.slice(0, 60)));

const cuit = leer('cuitonline', 'directo') || leer('cuitonline', 'worker');
if (cuit) {
  const titulo = (cuit.match(/<title>([^<]*)/i) || [, ''])[1].trim();
  console.log('- cuitonline: title="' + titulo + '" (nombre/CUIT; sin nacimiento ni domicilio)');
}

const bin = leer('binlist', 'directo') || leer('binlist', 'worker');
if (bin) {
  try { const j = JSON.parse(bin); console.log('- binlist: scheme=' + j.scheme + ' type=' + j.type + ' bank=' + (j.bank && j.bank.name) + ' country=' + (j.country && j.country.alpha2)); } catch (_) {}
}

const nosis = leer('nosis-buscar', 'worker') || leer('nosis-buscar', 'directo');
if (nosis) {
  try { const j = JSON.parse(nosis); const e = (j.EntidadesEncontradas || [])[0]; console.log('- nosis_buscar: ' + (e ? e.RazonSocial + ' | ' + e.Documento + ' | ' + e.Provincia : 'sin entidad') + ' (sin sesion)'); } catch (_) {}
}

const apiStore = leer('apistore-docs', 'directo') || leer('apistore-docs', 'worker');
if (apiStore) {
  console.log('- apistore: documentacion viva en https://apistore.pcnt.io (auth POST /v1/login/jwt -> JWT; Authorization: JWT <token>)');
  console.log('  endpoints: GET /v1/information/persons/{dni} (CUITs), /v1/information/person/{cuit} (AFIP),');
  console.log('             /v1/information/person-renaper/{dni}/gender/{M|F} (ReNaPer), POST /v1/information/barcode (foto DNI)');
  console.log('  OJO: id_tramite_principal (ej. 162853884) tiene 9 digitos; el tramite impreso (procedure_number de barcode) tiene 11. NO son el mismo dato.');
}

/* ---------------------------- recomendacion ------------------------------ */
console.log('\n=== RECOMENDACION POR CAMPO (segun este sondeo) ===');
const tiene = (campo) => resultados.some((r) => r[campo] && r.status >= 200 && r.status < 400);
console.log('- Nacimiento: ' + (tiene('nacimiento') ? 'hay al menos una respuesta con campo/fecha (ver tabla)' : 'SIN fuente gratuita confirmada; SISA CMDB exige autenticacion y mi_ejemplar pide la fecha como input'));
console.log('- Domicilio : ' + (tiene('domicilio') ? 'hay respuesta con domicilio (ver tabla)' : 'SIN fuente gratuita confirmada; AFIP constancia tiene captcha y padron.gob.ar esta 503'));
console.log('- Tramite   : ' + (tiene('tramite') ? 'hay respuesta con tramite/ejemplar (ver tabla)' : 'SIN fuente gratuita confirmada; solo API paga / RENAPER'));
console.log('- Nombre    : personas (AFIP) + Nosis busqueda + cuitonline');
console.log('\nCrudos en /tmp/sonda-<nombre>-<camino>.txt');
