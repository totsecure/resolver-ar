/* faker-ar.js — datos SINTETICOS deterministas (mail, telefono) para resolver-ar.
 *
 * REGLA DE ORO: este modulo NO inventa datos del padron. Solo produce mail y
 * telefono marcados fuente='SINTETICO'. Nunca toca apellido, nombre, DNI, CUIT,
 * CUIL, sexo ni situacion impositiva.
 *
 * Determinismo: semilla = FNV-1a 32 bits de (dni + ':' + campo). Mismo DNI =>
 * mismo mail y mismo telefono, en este proceso y en cualquier otro, para siempre
 * (mientras no cambie VERSION). No se usa Math.random() ni @faker-js/faker.
 */

export const VERSION = '1.0.0';

/* FNV-1a de 32 bits. Devuelve un entero sin signo. */
export function fnv1a(texto) {
  let h = 0x811c9dc5;
  const s = String(texto ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* PRNG determinista (mulberry32) sembrado con FNV-1a. Devuelve uint32.
 * Cada llamada avanza el estado; el orden de consumo es fijo dentro de la version. */
function prng(semilla) {
  let a = fnv1a(semilla) || 0x9e3779b9;
  return function siguiente() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const elegir = (r, lista) => lista[r() % lista.length];
const digitos = (r, cantidad) => {
  let out = '';
  for (let i = 0; i < cantidad; i++) out += String(r() % 10);
  return out;
};

/* Normaliza texto: sin acentos, minusculas, solo [a-z0-9]. */
function limpiar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function tokens(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function dniDe(dni) {
  const d = String(dni ?? '').replace(/\D/g, '');
  if (!d) return '0';
  if (d.length === 11) return d.slice(2, 10);
  return d.length <= 8 ? d.padStart(8, '0') : d.slice(-8);
}

/* Provincia sintetica ponderada por poblacion. Es la UNICA fuente: la usan
 * faker-extra (ciudad/area) y el telefono cuando el llamador no declara
 * provincia. Asi el mismo DNI da el mismo telefono en ficha, informe, lote,
 * bot y endpoints. */
const PROVINCIAS = [
  { nombre: 'BUENOS AIRES', peso: 17500000 },
  { nombre: 'CORDOBA', peso: 3800000 },
  { nombre: 'SANTA FE', peso: 3600000 },
  { nombre: 'CABA', peso: 3100000 },
  { nombre: 'MENDOZA', peso: 2000000 },
  { nombre: 'TUCUMAN', peso: 1700000 },
  { nombre: 'SALTA', peso: 1400000 },
  { nombre: 'ENTRE RIOS', peso: 1400000 },
  { nombre: 'MISIONES', peso: 1300000 },
  { nombre: 'CORRIENTES', peso: 1200000 },
  { nombre: 'CHACO', peso: 1200000 },
  { nombre: 'SANTIAGO DEL ESTERO', peso: 1050000 },
  { nombre: 'SAN JUAN', peso: 820000 },
  { nombre: 'JUJUY', peso: 800000 },
  { nombre: 'RIO NEGRO', peso: 760000 },
  { nombre: 'NEUQUEN', peso: 730000 },
  { nombre: 'FORMOSA', peso: 600000 },
  { nombre: 'CHUBUT', peso: 600000 },
  { nombre: 'SAN LUIS', peso: 540000 },
  { nombre: 'CATAMARCA', peso: 430000 },
  { nombre: 'LA RIOJA', peso: 380000 },
  { nombre: 'LA PAMPA', peso: 360000 },
  { nombre: 'SANTA CRUZ', peso: 330000 },
  { nombre: 'TIERRA DEL FUEGO', peso: 190000 },
];

const PESO_TOTAL = PROVINCIAS.reduce((s, p) => s + p.peso, 0);

/** Provincia sintetica determinista para un DNI. */
export function provinciaSintetica(dni) {
  const d = dniDe(dni);
  const r = prng(`${d}:provincia`);
  let x = r() % PESO_TOTAL;
  for (const p of PROVINCIAS) {
    if (x < p.peso) return p.nombre;
    x -= p.peso;
  }
  return 'BUENOS AIRES';
}

/* Los 5 patrones de mail exigidos. */
const PATRONES = [
  { id: 1, nombre: 'nombre.apellido', armar: (n, a) => `${n}.${a}` },
  { id: 2, nombre: 'nombreapellido', armar: (n, a) => `${n}${a}` },
  { id: 3, nombre: 'nombre.apellido##', armar: (n, a, r) => `${n}.${a}${digitos(r, 2)}` },
  { id: 4, nombre: 'inicial+apellido', armar: (n, a) => `${n.slice(0, 1)}${a}` },
  { id: 5, nombre: 'nombre###', armar: (n, a, r) => `${n}${digitos(r, 3)}` },
];

const DOMINIOS = [
  'gmail.com', 'gmail.com', 'gmail.com',
  'hotmail.com', 'hotmail.com',
  'outlook.com',
  'yahoo.com.ar',
  'live.com.ar',
];

/* Areas telefonicas coherentes con cada provincia (tabla propia).
 * Las repetidas ponderan: el area metropolitana concentra la poblacion. */
const AREAS_POR_PROVINCIA = {
  'CIUDAD AUTONOMA DE BUENOS AIRES': ['11', '11', '11', '11'],
  'CABA': ['11', '11', '11', '11'],
  'CAPITAL FEDERAL': ['11', '11', '11', '11'],
  'BUENOS AIRES': ['11', '11', '11', '11', '11', '11', '221', '221', '223', '223', '249', '291', '291', '2262', '2284', '2477', '2362', '3487', '3489', '230', '348', '3362', '3327'],
  'CORDOBA': ['351', '351', '351', '352', '353', '3541', '3543', '3571', '358'],
  'SANTA FE': ['341', '341', '342', '342', '349', '3400', '3462', '3482'],
  'MENDOZA': ['261', '261', '263', '262', '260'],
  'TUCUMAN': ['381', '381', '3862', '3865'],
  'SALTA': ['387', '387', '3868', '3877'],
  'ENTRE RIOS': ['343', '345', '3442', '3435'],
  'CHACO': ['362', '3644', '3721', '3731'],
  'CORRIENTES': ['379', '3777', '3782'],
  'MISIONES': ['376', '3752', '3743'],
  'NEUQUEN': ['299', '2942', '2946'],
  'RIO NEGRO': ['2920', '298', '2940', '2929'],
  'CHUBUT': ['280', '297', '2965', '2945'],
  'SAN JUAN': ['264', '264', '2645'],
  'SAN LUIS': ['266', '2652', '2664'],
  'SANTIAGO DEL ESTERO': ['385', '3841', '3843'],
  'FORMOSA': ['370', '3718', '3717'],
  'JUJUY': ['388', '3884', '3886'],
  'LA PAMPA': ['2954', '2302', '2953'],
  'LA RIOJA': ['380', '3825', '3827'],
  'CATAMARCA': ['383', '3833', '3835'],
  'SANTA CRUZ': ['2966', '2972', '2962'],
  'TIERRA DEL FUEGO': ['2901', '2964'],
};

/* Fallback ponderado exigido: 11/221/351/341/261 (11 pesa mas). */
const AREAS_FALLBACK = ['11', '11', '11', '221', '351', '341', '261'];

const ALIAS_PROVINCIA = {
  'BSAS': 'BUENOS AIRES',
  'BS AS': 'BUENOS AIRES',
  'PBA': 'BUENOS AIRES',
  'PROVINCIA DE BUENOS AIRES': 'BUENOS AIRES',
  'GOBIERNO DE LA CIUDAD DE BUENOS AIRES': 'CIUDAD AUTONOMA DE BUENOS AIRES',
  'C A B A': 'CABA',
  'CORDOBA CAPITAL': 'CORDOBA',
  'SANTAFE': 'SANTA FE',
  'TUCUMAN': 'TUCUMAN',
};

function normalizarProvincia(provincia) {
  const clave = String(provincia ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^PROVINCIA (DE |DEL )?/, '');
  return ALIAS_PROVINCIA[clave] || clave;
}

function areaPara(r, provincia, dni) {
  const clave = normalizarProvincia(provincia) || provinciaSintetica(dni);
  const conocida = Object.prototype.hasOwnProperty.call(AREAS_POR_PROVINCIA, clave);
  const lista = conocida ? AREAS_POR_PROVINCIA[clave] : AREAS_FALLBACK;
  return {
    area: elegir(r, lista),
    conocida,
    clave: conocida ? clave : null,
    origen: conocida ? 'provincia' : 'fallback-nacional',
  };
}

/* Une tokens hasta el limite SIN partir palabras. Si la primera palabra sola
 * ya supera el limite se conserva entera (preferimos un mail algo mas largo
 * antes que un nombre cortado por la mitad). */
function unirPorPalabras(lista, maximo) {
  let out = '';
  for (const token of lista) {
    if (!out) {
      out = token;
      continue;
    }
    if (out.length + token.length > maximo) break;
    out += token;
  }
  return out;
}

/* Devuelve null cuando el dato no existe: NUNCA inventa "persona"/"titular". */
function armarNombre(persona) {
  const nom = tokens(persona?.nombre ?? persona?.nombres ?? persona?.NOMBRE);
  const ape = tokens(persona?.apellido ?? persona?.apellidos ?? persona?.APELLIDO);

  return {
    nombre: nom.length ? unirPorPalabras(nom, 16) : null,
    apellido: ape.length ? unirPorPalabras(ape, 20) : null,
  };
}

/* Limpia el local-part: minusculas, sin acentos, solo [a-z0-9._], empieza en letra. */
function usuarioValido(bruto, semilla) {
  let u = String(bruto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '')
    .replace(/^[._]+/, '')
    .replace(/[._]+$/, '')
    .replace(/\.{2,}/g, '.');
  if (!u) u = 'u' + (fnv1a(semilla) % 100000);
  if (!/^[a-z]/.test(u)) u = 'a' + u;
  return u.slice(0, 32);
}

/**
 * Mail sintetico determinista.
 * @param {string|number} dni
 * @param {{nombre?:string, apellido?:string, [k:string]:any}} [persona]
 * @returns {{valor:string, fuente:'SINTETICO', campo:'mail', patron:string, patronId:number, dominio:string, semilla:number, regla:string}}
 */
export function generarMail(dni, persona) {
  const d = dniDe(dni);
  const semillaTexto = `${d}:mail`;
  const r = prng(semillaTexto);

  const { nombre, apellido } = armarNombre(persona);

  let patron;
  let patronId;
  let dominio;
  let usuario;

  if (!nombre && !apellido) {
    /* Sin nombre ni apellido: u<dni sin ceros>, jamas "personatitular". */
    usuario = `u${d.replace(/^0+/, '') || '0'}`;
    patron = 'u<dni>';
    patronId = 0;
    dominio = 'gmail.com';
  } else if (nombre && !apellido) {
    /* Con nombre y sin apellido: solo el nombre. */
    usuario = usuarioValido(nombre, semillaTexto);
    patron = 'solo-nombre';
    patronId = 0;
    dominio = elegir(r, DOMINIOS);
  } else if (!nombre && apellido) {
    /* Con apellido y sin nombre: solo el apellido. */
    usuario = usuarioValido(apellido, semillaTexto);
    patron = 'solo-apellido';
    patronId = 0;
    dominio = elegir(r, DOMINIOS);
  } else {
    const p = PATRONES[r() % PATRONES.length];
    patron = p.nombre;
    patronId = p.id;
    dominio = elegir(r, DOMINIOS);
    usuario = usuarioValido(p.armar(nombre, apellido, r), semillaTexto);
  }

  const valor = `${usuario}@${dominio}`;

  return {
    valor,
    fuente: 'SINTETICO',
    campo: 'mail',
    patron,
    patronId,
    dominio,
    semilla: fnv1a(semillaTexto),
    regla:
      `faker-ar v${VERSION} mail | semilla=fnv1a(${d}:mail)=0x${fnv1a(semillaTexto).toString(16)} | ` +
      `patron=${patron} | dominio=${dominio} | motor=fnv1a/mulberry32`,
  };
}

/**
 * Telefono sintetico determinista.
 * 70% celular / 30% fijo. Area coherente con la provincia declarada.
 * @param {string|number} dni
 * @param {{provincia?:string, [k:string]:any}} [persona]
 * @returns {{valor:string, fuente:'SINTETICO', campo:'telefono', tipo:'celular'|'fijo', area:string, provincia:string|null, areaOrigen:string, semilla:number, regla:string}}
 */
export function generarTelefono(dni, persona) {
  const d = dniDe(dni);
  const semillaTexto = `${d}:telefono`;
  const r = prng(semillaTexto);

  const esCelular = r() % 100 < 70;
  const { area, conocida, clave, origen } = areaPara(r, persona?.provincia, d);

  let valor;
  if (esCelular) {
    // CABA-GBA: "11 XXXX-XXXX" (sin 15). Interior: "AREA 15-XXXX-XXXX".
    valor = area === '11'
      ? `11 ${digitos(r, 4)}-${digitos(r, 4)}`
      : `${area} 15-${digitos(r, 4)}-${digitos(r, 4)}`;
  } else {
    // Fijo: "AREA-XXX-XXXX".
    valor = `${area}-${digitos(r, 3)}-${digitos(r, 4)}`;
  }

  return {
    valor,
    fuente: 'SINTETICO',
    campo: 'telefono',
    tipo: esCelular ? 'celular' : 'fijo',
    area,
    provincia: conocida ? clave : null,
    areaOrigen: origen,
    semilla: fnv1a(semillaTexto),
    regla:
      `faker-ar v${VERSION} telefono | semilla=fnv1a(${d}:telefono)=0x${fnv1a(semillaTexto).toString(16)} | ` +
      `tipo=${esCelular ? 'celular' : 'fijo'} | area=${area} | origenArea=${origen}` +
      `${conocida ? ' (' + clave + ')' : ''} | motor=fnv1a/mulberry32`,
  };
}

/**
 * Telefono solo digitos: area + numero, sin 0 ni 15.
 * CABA/GBA: "11" + 8 digitos. Interior: area + 7 digitos.
 * Mismo DNI => mismos digitos, siempre (misma semilla que generarTelefono).
 * @returns {string}
 */
/* Areas válidas para normalizar un teléfono que viene sin separador. */
const AREAS_VALIDAS = new Set(['11']);
for (const lista of Object.values(AREAS_POR_PROVINCIA)) for (const a of lista) AREAS_VALIDAS.add(a);

/**
 * Formato de salida: "area numero" (un solo espacio). Acepta dígitos crudos
 * (35410227087 -> 3541 0227087) o un teléfono ya separado. El área se detecta
 * contra la tabla de áreas (4, 3 o 2 dígitos).
 */
export function formatearTelefono(valor) {
  const s = String(valor == null ? '' : valor).trim();
  if (!s) return null;
  const sep = s.match(/^(\d{2,4})\s*[-\s]\s*(\d+)$/);
  if (sep) {
    const resto = sep[2].replace(/\D/g, '');
    return resto ? sep[1] + ' ' + resto : sep[1];
  }
  const d = s.replace(/\D/g, '');
  if (!d) return null;
  for (const len of [4, 3, 2]) {
    const area = d.slice(0, len);
    const resto = d.length - len;
    const largoValido = len === 2 ? resto === 8 : resto === 7;
    if (AREAS_VALIDAS.has(area) && largoValido) return area + ' ' + d.slice(len);
  }
  if (d.length > 7) return d.slice(0, d.length - 7) + ' ' + d.slice(-7);
  return d;
}

export function telefonoDigitos(dni, persona) {
  const d = dniDe(dni);
  const r = prng(`${d}:telefono`);
  r(); // decision celular/fijo (mismo consumo que generarTelefono)
  const { area } = areaPara(r, persona?.provincia, d);
  if (area === '11') return '11' + digitos(r, 8);
  return area + digitos(r, 7);
}

/**
 * Ambos sinteticos de una persona.
 * @returns {{mail:object, telefono:object, fuente:'SINTETICO'}}
 */
export function generarSinteticos(dni, persona) {
  const telefono = generarTelefono(dni, persona);
  const digitos = telefonoDigitos(dni, persona);
  return {
    mail: generarMail(dni, persona),
    telefono: { ...telefono, valor: digitos, valorDigitos: digitos },
    fuente: 'SINTETICO',
  };
}
