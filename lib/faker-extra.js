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

import { fnv1a, generarMail, generarTelefono, telefonoDigitos, provinciaSintetica } from './faker-ar.js';

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

/* Ciudad por area telefonica. La ciudad SIEMPRE pertenece al area elegida:
 * primero se sortea el area (en faker-ar, segun la provincia) y despues se
 * toma una ciudad de esta tabla. Asi NECOCHEA nunca sale con 249 (Tandil) ni
 * BAHIA BLANCA con 221 (La Plata). */
const CIUDADES_POR_AREA = {
  'BUENOS AIRES': {
    '11': [
      'LA MATANZA', 'SAN ISIDRO', 'VICENTE LOPEZ', 'SAN MARTIN', 'QUILMES',
      'LANUS', 'LOMAS DE ZAMORA', 'AVELLANEDA', 'MORENO', 'TIGRE',
      'SAN MIGUEL', 'JOSE C PAZ', 'EZEIZA', 'BERAZATEGUI', 'FLORENCIO VARELA',
    ],
    '221': ['LA PLATA'],
    '223': ['MAR DEL PLATA'],
    '249': ['TANDIL'],
    '291': ['BAHIA BLANCA'],
    '2262': ['NECOCHEA'],
    '2284': ['OLAVARRIA'],
    '2477': ['PERGAMINO'],
    '2362': ['JUNIN'],
    '3487': ['ZARATE'],
    '3489': ['CAMPANA'],
    '230': ['PILAR'],
    '348': ['ESCOBAR'],
    '3362': ['SAN NICOLAS'],
    '3327': ['SAN PEDRO'],
  },
  'CORDOBA': {
    '351': ['CORDOBA'],
    '352': ['DEAN FUNES', 'JESUS MARIA', 'CRUZ DEL EJE'],
    '353': ['VILLA MARIA', 'BELL VILLE', 'MONTE MAIZ'],
    '3541': ['VILLA CARLOS PAZ', 'VILLA ALLENDE', 'COSQUIN'],
    '3543': ['ALTA GRACIA'],
    '3571': ['RIO TERCERO'],
    '358': ['RIO CUARTO', 'SAN FRANCISCO'],
  },
  'SANTA FE': {
    '341': ['ROSARIO', 'VILLA CONSTITUCION', 'SAN LORENZO', 'CASILDA'],
    '342': ['SANTA FE', 'SANTO TOME', 'ESPERANZA'],
    '349': ['RAFAELA', 'FIRMAT', 'RUFINO'],
    '3400': ['VILLA GOBERNADOR GALVEZ'],
    '3462': ['VENADO TUERTO'],
    '3482': ['RECONQUISTA'],
  },
  'CABA': {
    '11': [
      'CABA', 'PALERMO', 'RECOLETA', 'BELGRANO', 'CABALLITO', 'VILLA CRESPO',
      'ALMAGRO', 'FLORES', 'VILLA URQUIZA', 'COLEGIALES', 'NUNEZ', 'SAN TELMO',
      'LA BOCA', 'BARRACAS', 'BOEDO', 'MONTSERRAT', 'RETIRO', 'BALVANERA',
      'PARQUE PATRICIOS', 'VILLA DEVOTO', 'LINIERS', 'MATADEROS', 'POMPEYA',
      'SAAVEDRA', 'CHACARITA', 'COGHLAN', 'VILLA DEL PARQUE', 'FLORESTA',
      'PARQUE CHAS', 'AGRONOMIA', 'CONSTITUCION',
    ],
  },
  'MENDOZA': {
    '261': [
      'MENDOZA', 'GODOY CRUZ', 'LAS HERAS', 'GUAYMALLEN', 'MAIPU',
      'LUJAN DE CUYO', 'CHACRAS DE CORIA',
    ],
    '263': ['SAN RAFAEL'],
    '262': ['SAN MARTIN', 'RIVADAVIA', 'TUNUYAN', 'VILLA NUEVA'],
    '260': ['GENERAL ALVEAR', 'MALARGUE'],
  },
  'TUCUMAN': {
    '381': ['SAN MIGUEL DE TUCUMAN', 'YERBA BUENA', 'TAFI VIEJO', 'LULES', 'BANDA DEL RIO SALI'],
    '3862': ['CONCEPCION', 'MONTEROS'],
    '3865': ['AGUILARES', 'FAMAILLA', 'TAFI DEL VALLE'],
  },
  'SALTA': {
    '387': ['SALTA', 'GENERAL GUEMES'],
    '3868': ['SAN RAMON DE LA NUEVA ORAN', 'TARTAGAL', 'EMBARCACION'],
    '3877': ['METAN', 'ROSARIO DE LA FRONTERA', 'CAFAYATE', 'JOAQUIN V GONZALEZ'],
  },
  'ENTRE RIOS': {
    '343': ['PARANA', 'COLON', 'VICTORIA', 'CRESPO'],
    '345': ['CONCORDIA', 'CHAJARI', 'FEDERAL'],
    '3442': ['GUALEGUAYCHU'],
    '3435': ['CONCEPCION DEL URUGUAY', 'VILLAGUAY'],
  },
  'MISIONES': {
    '376': ['POSADAS', 'GARUPA', 'MONTE CARLO', 'IGUAZU'],
    '3752': ['OBERA', 'APOSTOLES', 'LEANDRO N ALEM'],
    '3743': ['ELDORADO', 'SAN VICENTE', 'PUERTO IGUAZU'],
  },
  'CORRIENTES': {
    '379': ['CORRIENTES', 'MERCEDES', 'SALADAS', 'ITUZAINGO', 'BELLA VISTA'],
    '3777': ['GOYA'],
    '3782': ['PASO DE LOS LIBRES', 'CURUZU CUATIA', 'SANTO TOME', 'MONTE CASEROS'],
  },
  'CHACO': {
    '362': ['RESISTENCIA', 'BARRANQUERAS', 'LA LEONES'],
    '3644': ['PRESIDENCIA ROQUE SAENZ PENA', 'QUITILIPI'],
    '3721': ['VILLA ANGELA'],
    '3731': ['CHARATA', 'GENERAL JOSE DE SAN MARTIN', 'JUAN JOSE CASTELLI', 'MACHAGAI'],
  },
  'SANTIAGO DEL ESTERO': {
    '385': ['SANTIAGO DEL ESTERO', 'LA BANDA'],
    '3841': ['TERMAS DE RIO HONDO', 'FRIAS'],
    '3843': ['ANATUYA', 'QUIMILI', 'MONTE QUEMADO', 'CAMPO GALLO', 'LOS JURIES', 'BREA POZO'],
  },
  'SAN JUAN': {
    '264': ['SAN JUAN', 'RAWSON', 'RIVADAVIA', 'CHIMBAS', 'SANTA LUCIA', 'POCITO', 'CAUCETE'],
    '2645': ['IGLESIA', 'JACHAL', 'CALINGASTA'],
  },
  'JUJUY': {
    '388': ['SAN SALVADOR DE JUJUY', 'PALPALA', 'PERICO', 'EL CARMEN', 'MONTERRICO'],
    '3884': ['LIBERTADOR GENERAL SAN MARTIN', 'HUMAHUACA', 'TILCARA'],
    '3886': ['LA QUIACA', 'PUESTO VIEJO'],
  },
  'RIO NEGRO': {
    '2920': ['VIEDMA'],
    '298': ['GENERAL ROCA', 'CIPOLLETTI', 'ALLEN', 'CINCO SALTOS', 'CATRIEL', 'CHOELE CHOEL'],
    '2940': ['SAN CARLOS DE BARILOCHE', 'EL BOLSON'],
    '2929': ['RIO COLORADO'],
  },
  'NEUQUEN': {
    '299': ['NEUQUEN', 'CUTRAL CO', 'PLAZA HUINCUL', 'CENTENARIO', 'PLOTTIER'],
    '2942': ['SAN MARTIN DE LOS ANDES', 'JUNIN DE LOS ANDES'],
    '2946': ['ZAPALA', 'CHOS MALAL', 'LAS LAJAS'],
  },
  'FORMOSA': {
    '370': ['FORMOSA', 'CLORINDA', 'LAGUNA BLANCA'],
    '3718': ['PIRANE', 'EL COLORADO', 'BOUVIER'],
    '3717': ['INGENIERO JUAREZ', 'LAS LOMITAS', 'EL ESPINILLO'],
  },
  'CHUBUT': {
    '280': ['TRELEW', 'PUERTO MADRYN', 'RAWSON', 'GAIMAN', 'RADA TILLY'],
    '297': ['COMODORO RIVADAVIA', 'SARMIENTO'],
    '2965': ['PUERTO PIRAMIDES'],
    '2945': ['ESQUEL', 'TREVELIN'],
  },
  'SAN LUIS': {
    '266': ['SAN LUIS', 'JUANA KOSLAY', 'LA PUNTA'],
    '2652': ['VILLA MERCEDES', 'JUSTO DARACT'],
    '2664': ['CONCARAN', 'TILISARAO', 'SAN FRANCISCO DEL MONTE DE ORO', 'QUINES'],
  },
  'CATAMARCA': {
    '383': ['SAN FERNANDO DEL VALLE DE CATAMARCA', 'RECREO'],
    '3833': ['TINOGASTA', 'BELEN', 'ANDALGALA', 'FIAMBALA', 'POMAN', 'EL ALTO'],
    '3835': ['SANTA MARIA'],
  },
  'LA RIOJA': {
    '380': ['LA RIOJA', 'CORONEL FELIPE VARELA'],
    '3825': ['CHILECITO', 'AIMOGASTA', 'FAMATINA', 'VILLA UNION', 'PAGANZO', 'TAMA'],
    '3827': ['CHAMICAL'],
  },
  'LA PAMPA': {
    '2954': ['SANTA ROSA', 'TOAY', 'REALICO', 'GUATRACHE'],
    '2302': ['GENERAL PICO', 'EDUARDO CASTEX', 'QUIEMU'],
    '2953': ['GENERAL ACHA', 'MACACHIN', 'VICTORICA'],
  },
  'SANTA CRUZ': {
    '2966': ['RIO GALLEGOS', 'EL CALAFATE', 'EL CHALTEN', '28 DE NOVIEMBRE'],
    '2972': ['CALETA OLIVIA', 'PICO TRUNCADO', 'LAS HERAS', 'PERITO MORENO', 'GOBERNADOR GREGORES'],
    '2962': ['PUERTO DESEADO'],
  },
  'TIERRA DEL FUEGO': {
    '2901': ['USHUAIA', 'TOLHUIN'],
    '2964': ['RIO GRANDE'],
  },
};

/* Alias de CABA usados por faker-ar en otras entradas. */
CIUDADES_POR_AREA['CIUDAD AUTONOMA DE BUENOS AIRES'] = CIUDADES_POR_AREA['CABA'];
CIUDADES_POR_AREA['CAPITAL FEDERAL'] = CIUDADES_POR_AREA['CABA'];

/* ------------------- provincia derivada de la ciudad --------------------- */
const sinAcentos = (s) => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();

function provinciaCanonica(p) {
  let x = sinAcentos(p).replace(/^PROVINCIA (DE |DEL )?/, '');
  if (x === 'CIUDAD DE BUENOS AIRES' || x === 'CIUDAD AUTONOMA DE BUENOS AIRES'
    || x === 'CAPITAL FEDERAL' || x === 'C A B A') x = 'CABA';
  return x;
}

const CIUDAD_PROVINCIAS = new Map();
function registrarCiudad(ciudad, provincia) {
  const c = sinAcentos(ciudad);
  const p = provinciaCanonica(provincia);
  if (!c || !p) return;
  if (!CIUDAD_PROVINCIAS.has(c)) CIUDAD_PROVINCIAS.set(c, new Set());
  CIUDAD_PROVINCIAS.get(c).add(p);
}
for (const [provincia, lista] of Object.entries(CIUDADES)) {
  for (const ciudad of lista) registrarCiudad(ciudad, provincia);
}
for (const [provincia, areas] of Object.entries(CIUDADES_POR_AREA)) {
  for (const lista of Object.values(areas)) {
    for (const ciudad of lista) registrarCiudad(ciudad, provincia);
  }
}

/**
 * Devuelve la provincia que corresponde a una ciudad. Si se pasa una provincia
 * sugerida y la ciudad pertenece a ella, se conserva la sugerida (para no
 * cambiar "CIUDAD DE BUENOS AIRES" por "CABA"). Si la ciudad es única, se
 * devuelve esa provincia. Si es ambigua y no hay contexto, null.
 */
export function areasDeCiudad(ciudad) {
  const c = sinAcentos(ciudad);
  const out = [];
  for (const [provincia, areas] of Object.entries(CIUDADES_POR_AREA)) {
    for (const [area, lista] of Object.entries(areas)) {
      if (lista.some((x) => sinAcentos(x) === c)) out.push({ provincia, area });
    }
  }
  return out;
}

export function provinciaDeCiudad(ciudad, sugerida = null) {
  const set = CIUDAD_PROVINCIAS.get(sinAcentos(ciudad));
  if (!set || !set.size) return null;
  if (sugerida) {
    const s = provinciaCanonica(sugerida);
    if (set.has(s)) return String(sugerida).trim();
  }
  if (set.size === 1) return [...set][0];
  return null;
}

/* Ciudad tomada de la lista del area elegida (y de la provincia). */
function ciudadPara(d, provincia, area) {
  const porArea = CIUDADES_POR_AREA[provincia] || {};
  const lista = porArea[area] || CIUDADES[provincia] || [provincia];
  return elegir(prng(`${d}:ciudad`), lista);
}

/* Rango de CP de 4 digitos por provincia (cabecera del CPA real).
 * Alcanza para que el CP sea plausible y coherente con la ciudad elegida. */
const CP_POR_PROVINCIA = {
  'BUENOS AIRES': [[1600, 1999], [6000, 8999]],
  'CABA': [[1000, 1499]],
  'CATAMARCA': [[4700, 4799]],
  'CHACO': [[3500, 3599]],
  'CHUBUT': [[9000, 9199]],
  'CORDOBA': [[5000, 5299]],
  'CORRIENTES': [[3400, 3499]],
  'ENTRE RIOS': [[3100, 3299]],
  'FORMOSA': [[3600, 3699]],
  'JUJUY': [[4600, 4699]],
  'LA PAMPA': [[6300, 6399]],
  'LA RIOJA': [[5300, 5399]],
  'MENDOZA': [[5500, 5599]],
  'MISIONES': [[3300, 3399]],
  'NEUQUEN': [[8300, 8399]],
  'RIO NEGRO': [[8500, 8599]],
  'SALTA': [[4400, 4499]],
  'SAN JUAN': [[5400, 5499]],
  'SAN LUIS': [[5700, 5799]],
  'SANTA CRUZ': [[9400, 9499]],
  'SANTA FE': [[2000, 2599]],
  'SANTIAGO DEL ESTERO': [[4200, 4299]],
  'TIERRA DEL FUEGO': [[9410, 9420]],
  'TUCUMAN': [[4000, 4199]],
};
const CP_FALLBACK = [[1000, 9999]];

/* CP sintetico determinista, coherente con la provincia. */
function cpostalPara(d, provincia) {
  const rangos = CP_POR_PROVINCIA[provincia] || CP_FALLBACK;
  const r = prng(`${d}:cp`);
  const [min, max] = rangos[r() % rangos.length];
  return String(min + (r() % (max - min + 1)));
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
  const r = prng(`${d}:fecha`);
  const ref = new Date(`${REFERENCIA}T00:00:00Z`);

  /* Franja alta: los DNI de 90-99 millones son posteriores a 2009 (chicos y
   * adolescentes). No deben caer en 2007-2008 como el tramo 50M. */
  if (n >= 90000000) {
    const anio = Math.min(2024, 2010 + Math.floor(((n - 90000000) * 2) / 1500000));
    const fecha = new Date(Date.UTC(anio, r() % 12, 1 + (r() % 28)));
    const dd = String(fecha.getUTCDate()).padStart(2, '0');
    const mm = String(fecha.getUTCMonth() + 1).padStart(2, '0');
    return { fechaNac: `${dd}/${mm}/${fecha.getUTCFullYear()}`, edad: ref.getUTCFullYear() - anio };
  }

  const fraccion = Math.min(1, Math.max(0, n / 50000000));
  const base = 85 - Math.round(fraccion * 67);
  const edad = Math.min(85, Math.max(18, base + ((r() % 3) - 1)));

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
      cpostal: null,
      fechaNac: null,
      edad: null,
      nroTramite: null,
      mail: null,
      fuente: 'SINTETICO',
      regla: `faker-extra v${VERSION} | dni invalido`,
    };
  }

  const provincia = provinciaSintetica(d);

  /* Primero el area telefonica (faker-ar, coherente con la provincia) y
   * despues la ciudad, que sale de la lista de esa area. */
  const tel = generarTelefono(d, { provincia });
  const ciudad = ciudadPara(d, provincia, tel.area);
  const dir = direccionPara(d);
  const fecha = fechaNacimientoPara(d);
  const nroTramite = tramitePara(d);

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
    cpostal: cpostalPara(d, provincia),
    fechaNac: fecha.fechaNac,
    edad: fecha.edad,
    nroTramite,
    mail,
    fuente: 'SINTETICO',
    regla: `faker-extra v${VERSION} | semilla=fnv1a(${d}:extra) | motor=fnv1a/mulberry32`,
  };
}
