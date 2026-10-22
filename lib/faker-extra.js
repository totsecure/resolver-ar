/* faker-extra.js — datos SINTETICOS deterministas por DNI para lotes.
 *
 * REGLA: este modulo NO inventa datos del padron. Solo completa los campos que
 * los endpoints de lote necesitan (provincia, ciudad, telefono, direccion,
 * fecha de nacimiento y nro de tramite) de forma reproducible.
 *
 * Determinismo: semilla = FNV-1a 32 bits de (dni + ':' + campo) y PRNG
 * mulberry32. Mismo DNI => mismos datos, en este proceso y en cualquier otro.
 * No se usa Math.random().
 *
 * El mail NO se genera aca: se delega en generarMail() de faker-ar.js para
 * respetar los patrones y la regla de nombres ya existente.
 */

import { fnv1a, generarMail, generarTelefono, telefonoDigitos } from './faker-ar.js';

export const VERSION = '1.0.0';

/* Fecha de referencia de la version. Fijarla mantiene el determinismo aunque
 * pasen los dias; las edades quedan entre 18 y 85 al momento de esta version. */
export const REFERENCIA = '2026-10-21';

/* PRNG mulberry32. Acepta un entero o un texto (lo hashea con FNV-1a). */
export function mulberry32(semilla) {
  let a = (typeof semilla === 'number' ? semilla : fnv1a(semilla)) >>> 0;
  if (!a) a = 0x9e3779b9;
  return function siguiente() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const prng = (semilla) => mulberry32(fnv1a(semilla));
const elegir = (r, lista) => lista[r() % lista.length];
const digitos = (r, cantidad) => {
  let out = '';
  for (let i = 0; i < cantidad; i++) out += String(r() % 10);
  return out;
};

/** Normaliza cualquier DNI/CUIT a 8 digitos. Devuelve null si no hay digitos. */
export function normalizarDni(dni) {
  const d = String(dni ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11) return d.slice(2, 10);
  if (d.length <= 8) return d.padStart(8, '0');
  return d.slice(-8);
}

/* Provincias ponderadas por poblacion (censo aproximado). Las cinco primeras
 * son, en orden, las mas frecuentes: Buenos Aires, Cordoba, Santa Fe, CABA y
 * Mendoza. */
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

const CIUDADES = {
  'BUENOS AIRES': [
    'LA PLATA', 'MAR DEL PLATA', 'BAHIA BLANCA', 'SAN ISIDRO', 'VICENTE LOPEZ',
    'SAN MARTIN', 'QUILMES', 'LANUS', 'LOMAS DE ZAMORA', 'AVELLANEDA', 'MORENO',
    'LA MATANZA', 'TIGRE', 'SAN MIGUEL', 'JOSE C PAZ', 'PILAR', 'ESCOBAR',
    'EZEIZA', 'BERAZATEGUI', 'FLORENCIO VARELA', 'TANDIL', 'OLAVARRIA',
    'PERGAMINO', 'JUNIN', 'ZARATE', 'CAMPANA', 'NECOCHEA',
  ],
  'CORDOBA': [
    'CORDOBA', 'VILLA MARIA', 'RIO CUARTO', 'VILLA CARLOS PAZ', 'ALTA GRACIA',
    'SAN FRANCISCO', 'RIO TERCERO', 'JESUS MARIA', 'VILLA ALLENDE', 'COSQUIN',
    'CRUZ DEL EJE', 'DEAN FUNES', 'BELL VILLE', 'MONTE MAIZ',
  ],
  'SANTA FE': [
    'SANTA FE', 'ROSARIO', 'VENADO TUERTO', 'RAFAELA', 'RECONQUISTA',
    'VILLA CONSTITUCION', 'SAN LORENZO', 'CASILDA', 'RUFINO', 'SANTO TOME',
    'ESPERANZA', 'FIRMAT', 'VILLA GOBERNADOR GALVEZ',
  ],
  'CABA': [
    'CABA', 'PALERMO', 'RECOLETA', 'BELGRANO', 'CABALLITO', 'VILLA CRESPO',
    'ALMAGRO', 'FLORES', 'VILLA URQUIZA', 'COLEGIALES', 'NUNEZ', 'SAN TELMO',
    'LA BOCA', 'BARRACAS', 'BOEDO', 'MONTSERRAT', 'RETIRO', 'BALVANERA',
    'PARQUE PATRICIOS', 'VILLA DEVOTO', 'LINIERS', 'MATADEROS', 'POMPEYA',
    'SAAVEDRA', 'CHACARITA', 'COGHLAN', 'VILLA DEL PARQUE', 'FLORESTA',
    'PARQUE CHAS', 'AGRONOMIA', 'CONSTITUCION',
  ],
  'MENDOZA': [
    'MENDOZA', 'SAN RAFAEL', 'GODOY CRUZ', 'LAS HERAS', 'GUAYMALLEN', 'MAIPU',
    'LUJAN DE CUYO', 'TUNUYAN', 'SAN MARTIN', 'RIVADAVIA', 'MALARGUE',
    'GENERAL ALVEAR', 'CHACRAS DE CORIA', 'VILLA NUEVA',
  ],
  'TUCUMAN': [
    'SAN MIGUEL DE TUCUMAN', 'YERBA BUENA', 'TAFI VIEJO', 'CONCEPCION',
    'AGUILARES', 'BANDA DEL RIO SALI', 'MONTEROS', 'FAMAILLA', 'LULES',
    'TAFI DEL VALLE',
  ],
  'SALTA': [
    'SALTA', 'SAN RAMON DE LA NUEVA ORAN', 'TARTAGAL', 'METAN',
    'ROSARIO DE LA FRONTERA', 'CAFAYATE', 'JOAQUIN V GONZALEZ',
    'GENERAL GUEMES', 'EMBARCACION',
  ],
  'ENTRE RIOS': [
    'PARANA', 'CONCORDIA', 'GUALEGUAYCHU', 'COLON', 'VICTORIA',
    'CONCEPCION DEL URUGUAY', 'VILLAGUAY', 'FEDERAL', 'CRESPO', 'CHAJARI',
  ],
  'MISIONES': [
    'POSADAS', 'OBERA', 'ELDORADO', 'SAN VICENTE', 'APOSTOLES',
    'LEANDRO N ALEM', 'PUERTO IGUAZU', 'GARUPA', 'MONTE CARLO', 'IGUAZU',
  ],
  'CORRIENTES': [
    'CORRIENTES', 'GOYA', 'PASO DE LOS LIBRES', 'CURUZU CUATIA', 'SANTO TOME',
    'MERCEDES', 'MONTE CASEROS', 'SALADAS', 'ITUZAINGO', 'BELLA VISTA',
  ],
  'CHACO': [
    'RESISTENCIA', 'PRESIDENCIA ROQUE SAENZ PENA', 'VILLA ANGELA', 'CHARATA',
    'GENERAL JOSE DE SAN MARTIN', 'BARRANQUERAS', 'JUAN JOSE CASTELLI',
    'QUITILIPI', 'MACHAGAI', 'LA LEONES',
  ],
  'SANTIAGO DEL ESTERO': [
    'SANTIAGO DEL ESTERO', 'LA BANDA', 'TERMAS DE RIO HONDO', 'FRIAS',
    'ANATUYA', 'QUIMILI', 'MONTE QUEMADO', 'CAMPO GALLO', 'LOS JURIES',
    'BREA POZO',
  ],
  'SAN JUAN': [
    'SAN JUAN', 'RAWSON', 'RIVADAVIA', 'CHIMBAS', 'SANTA LUCIA', 'POCITO',
    'CAUCETE', 'IGLESIA', 'JACHAL', 'CALINGASTA',
  ],
  'JUJUY': [
    'SAN SALVADOR DE JUJUY', 'PALPALA', 'LIBERTADOR GENERAL SAN MARTIN',
    'PERICO', 'HUMAHUACA', 'LA QUIACA', 'TILCARA', 'EL CARMEN', 'MONTERRICO',
    'PUESTO VIEJO',
  ],
  'RIO NEGRO': [
    'VIEDMA', 'SAN CARLOS DE BARILOCHE', 'GENERAL ROCA', 'CIPOLLETTI',
    'RIO COLORADO', 'EL BOLSON', 'ALLEN', 'CINCO SALTOS', 'CATRIEL',
    'CHOELE CHOEL',
  ],
  'NEUQUEN': [
    'NEUQUEN', 'SAN MARTIN DE LOS ANDES', 'ZAPALA', 'CUTRAL CO',
    'PLAZA HUINCUL', 'CENTENARIO', 'PLOTTIER', 'JUNIN DE LOS ANDES',
    'CHOS MALAL', 'LAS LAJAS',
  ],
  'FORMOSA': [
    'FORMOSA', 'CLORINDA', 'PIRANE', 'EL COLORADO', 'LAGUNA BLANCA',
    'INGENIERO JUAREZ', 'LAS LOMITAS', 'EL ESPINILLO', 'BOUVIER',
  ],
  'CHUBUT': [
    'RAWSON', 'TRELEW', 'PUERTO MADRYN', 'COMODORO RIVADAVIA', 'ESQUEL',
    'TREVELIN', 'GAIMAN', 'RADA TILLY', 'SARMIENTO', 'PUERTO PIRAMIDES',
  ],
  'SAN LUIS': [
    'SAN LUIS', 'VILLA MERCEDES', 'JUANA KOSLAY', 'LA PUNTA', 'CONCARAN',
    'TILISARAO', 'SAN FRANCISCO DEL MONTE DE ORO', 'QUINES', 'JUSTO DARACT',
  ],
  'CATAMARCA': [
    'SAN FERNANDO DEL VALLE DE CATAMARCA', 'TINOGASTA', 'BELEN', 'ANDALGALA',
    'SANTA MARIA', 'RECREO', 'FIAMBALA', 'POMAN', 'EL ALTO',
  ],
  'LA RIOJA': [
    'LA RIOJA', 'CHILECITO', 'AIMOGASTA', 'CHAMICAL', 'FAMATINA',
    'VILLA UNION', 'PAGANZO', 'TAMA', 'CORONEL FELIPE VARELA',
  ],
  'LA PAMPA': [
    'SANTA ROSA', 'GENERAL PICO', 'TOAY', 'GENERAL ACHA', 'EDUARDO CASTEX',
    'MACACHIN', 'REALICO', 'VICTORICA', 'QUIEMU', 'GUATRACHE',
  ],
  'SANTA CRUZ': [
    'RIO GALLEGOS', 'CALETA OLIVIA', 'EL CALAFATE', 'PUERTO DESEADO',
    'PICO TRUNCADO', 'LAS HERAS', 'PERITO MORENO', 'GOBERNADOR GREGORES',
    'EL CHALTEN', '28 DE NOVIEMBRE',
  ],
  'TIERRA DEL FUEGO': ['USHUAIA', 'RIO GRANDE', 'TOLHUIN'],
};

const CALLES = [
  'AV SAN MARTIN', 'AV BELGRANO', 'AV 9 DE JULIO', 'AV RIVADAVIA', 'AV MITRE',
  'AV SARMIENTO', 'AV URQUIZA', 'AV ALSINA', 'AV MORENO', 'AV LAVALLE',
  'AV ITALIA', 'AV ESPANA', 'AV LOS ANDES', 'AV 25 DE MAYO', 'AV GENERAL PAZ',
  'AV SAN LORENZO', 'AV INDEPENDENCIA', 'AV LIBERTAD', 'AV ARGENTINA',
  'AV CENTENARIO', 'CALLE 50', 'CALLE 9', 'CALLE 13', 'CALLE 25', 'CALLE 60',
  'SARMIENTO', 'BELGRANO', 'RIVADAVIA', 'MITRE', 'URQUIZA', 'ALSINA', 'MORENO',
  'LAVALLE', 'ITALIA', 'ESPANA', 'LOS ANDES', '25 DE MAYO', 'SAN LORENZO',
  'INDEPENDENCIA', 'LIBERTAD', 'ARGENTINA', 'CENTENARIO', 'BOULOGNE SUR MER',
  'GUEMES', 'SAAVEDRA', 'MAIPU', 'CHACABUCO', 'BALCARCE', 'ENTRE RIOS',
  'CORRIENTES', 'CORDOBA', 'SALTA', 'JUJUY', 'MENDOZA', 'SAN JUAN', 'LA RIOJA',
  'CATAMARCA', 'TUCUMAN',
];

/* Provincia ponderada por poblacion. */
function provinciaPara(d) {
  const r = prng(`${d}:provincia`);
  let x = r() % PESO_TOTAL;
  for (const p of PROVINCIAS) {
    if (x < p.peso) return p.nombre;
    x -= p.peso;
  }
  return 'BUENOS AIRES';
}

/* Ciudad tomada de la lista de la provincia elegida. */
function ciudadPara(d, provincia) {
  const lista = CIUDADES[provincia] || [provincia];
  return elegir(prng(`${d}:ciudad`), lista);
}

/* Calle generica argentina + altura de 3 o 4 digitos. */
function direccionPara(d) {
  const r = prng(`${d}:direccion`);
  const calle = elegir(r, CALLES);
  const tresDigitos = r() % 2 === 0;
  const min = tresDigitos ? 100 : 1000;
  const max = tresDigitos ? 999 : 9999;
  const altura = min + (r() % (max - min + 1));
  return { calle, altura: String(altura), direccion: `${calle} ${altura}` };
}

/* Fecha de nacimiento con edad 18..85 y coherente con el rango del DNI:
 * los DNI bajos quedan en los mayores y los altos en los menores. */
function fechaNacimientoPara(d) {
  const n = Number(d) || 0;
  const fraccion = Math.min(1, Math.max(0, n / 50000000));
  const base = 85 - Math.round(fraccion * 67);
  const r = prng(`${d}:fecha`);
  const edad = Math.min(85, Math.max(18, base + ((r() % 3) - 1)));

  const ref = new Date(`${REFERENCIA}T00:00:00Z`);
  const cumple = new Date(ref.getTime());
  cumple.setUTCFullYear(cumple.getUTCFullYear() - edad);
  const fecha = new Date(cumple.getTime() - (r() % 365) * 86400000);
  const dd = String(fecha.getUTCDate()).padStart(2, '0');
  const mm = String(fecha.getUTCMonth() + 1).padStart(2, '0');

  return { fechaNac: `${dd}/${mm}/${fecha.getUTCFullYear()}`, edad };
}

/* Numero de tramite de 11 digitos (el primero no es cero). */
function tramitePara(d) {
  const r = prng(`${d}:tramite`);
  return String(1 + (r() % 9)) + digitos(r, 10);
}

/**
 * Genera los datos sinteticos de un DNI.
 * @param {string|number} dni
 * @param {{nombre?:string, apellido?:string}} [persona] para el mail
 * @returns {object}
 */
export function generarExtra(dni, persona = {}) {
  const d = normalizarDni(dni);
  if (!d) {
    return {
      dni: null,
      provincia: null,
      ciudad: null,
      area: null,
      numero: null,
      telefono: null,
      calle: null,
      altura: null,
      direccion: null,
      fechaNac: null,
      edad: null,
      nroTramite: null,
      mail: null,
      fuente: 'SINTETICO',
      regla: `faker-extra v${VERSION} | dni invalido`,
    };
  }

  const provincia = provinciaPara(d);
  const ciudad = ciudadPara(d, provincia);
  const dir = direccionPara(d);
  const fecha = fechaNacimientoPara(d);
  const nroTramite = tramitePara(d);

  /* El area y el numero telefonico salen de faker-ar, que ya tiene la tabla
   * de areas coherente con cada provincia. */
  const tel = generarTelefono(d, { provincia });
  const digitosTel = telefonoDigitos(d, { provincia });
  const numero = digitosTel.slice(tel.area.length);

  const mail = generarMail(d, persona).valor;

  return {
    dni: d,
    provincia,
    ciudad,
    area: tel.area,
    numero,
    telefono: `${tel.area} ${numero}`,
    calle: dir.calle,
    altura: dir.altura,
    direccion: dir.direccion,
    fechaNac: fecha.fechaNac,
    edad: fecha.edad,
    nroTramite,
    mail,
    fuente: 'SINTETICO',
    regla: `faker-extra v${VERSION} | semilla=fnv1a(${d}:extra) | motor=fnv1a/mulberry32`,
  };
}
