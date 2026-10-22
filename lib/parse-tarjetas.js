/* parse-tarjetas.js — parseo tolerante de lineas de tarjetas para /lote.
 *
 * Formato esperado (pero no obligatorio):
 *
 *   numero|MM|YY|CVV
 *
 * Reglas:
 *   - El numero se reconoce por prefijo de marca y longitud; LUHN se usa como
 *     validacion (se informa en `luhn`, no se descarta si falla: los lotes de
 *     prueba suelen traer numeros ficticios).
 *   - Vencimiento: los dos numeros de 2 digitos mas cercanos al numero, mes y
 *     despues anio. Tambien acepta MM/YY, MM-YY, MM.YY, MMYY y 2028.
 *   - CVV: run libre de 3 digitos (4 en Amex) o etiquetado CODIGO/CVV/CVC.
 *   - Etiquetas (CODIGO, VTO, MES, ANIO, ...) son pistas, no requisito.
 *   - Separadores: | / ; , - espacio y tab.
 *   - Un numero distinto = un registro nuevo.
 *   - Campo faltante = cadena vacia.
 *   - Lo que no se puede asignar se devuelve en `sobrantes`.
 */

import fs from 'node:fs';

/* Prefijos de marca. El orden importa: Amex antes que JCB. */
const MARCAS = [
  ['amex', /^3[47]/],
  ['visa', /^4/],
  ['mastercard', /^(?:5[1-5]|2[2-7])/],
  ['discover', /^(?:6011|65|64[4-9])/],
  ['diners', /^(?:30[0-5]|36|38)/],
  ['jcb', /^(?:2131|1800|35)/],
];

/* Etiquetas que no son datos: se ignoran al buscar sobrantes. */
const ETIQUETAS = new Set([
  'NUMERO', 'NRO', 'N', 'TARJETA', 'CC', 'PAN', 'CARD', 'CARDNUMBER',
  'TITULAR', 'DATOS', 'CREDITO', 'DEBITO', 'VISA', 'MASTERCARD',
  'AMEX', 'AMERICAN', 'EXPRESS', 'DISCOVER', 'DINERS', 'JCB',
  'MES', 'MM', 'ANIO', 'ANO', 'YY', 'YEAR',
  'VTO', 'VENC', 'VENCE', 'VENCIMIENTO', 'EXP', 'EXPIRA', 'EXPIRY',
  'FECHA', 'CODIGO', 'COD', 'CVV', 'CVC', 'CVV2', 'CVC2',
  'SEGURIDAD', 'SECURITY', 'CODE',
]);

/* Un numero de tarjeta puede venir:
 *   - 19 digitos agrupados 4-4-4-4-3
 *   - 16 digitos agrupados 4-4-4-4
 *   - 15 digitos Amex agrupados 4-6-5
 *   - 13..19 digitos corridos
 * Las alternativas largas van primero para no cortar el numero.
 */
const RE_NUMERO_FUENTE =
  '\\b(?:' +
  '\\d{4}[ -]\\d{4}[ -]\\d{4}[ -]\\d{4}' +
  '|\\d{4}[ -]\\d{6}[ -]\\d{5}' +
  '|\\d{13,19}' +
  ')\\b';

function soloDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

function pad2(valor) {
  return String(valor).padStart(2, '0').slice(-2);
}

function decodificar(valor) {
  let out = String(valor ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < 2; i++) {
    if (!/%[0-9a-f]{2}/i.test(out)) break;
    try {
      out = decodeURIComponent(out);
    } catch (_) {
      break;
    }
  }
  return out;
}

/** LUHN modulo 10. */
export function luhnValido(numero) {
  const s = soloDigitos(numero);
  if (s.length < 12) return false;
  let suma = 0;
  let doble = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (doble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    suma += d;
    doble = !doble;
  }
  return suma % 10 === 0;
}

/** Marca por prefijo, o null si no parece tarjeta. */
export function marcaDe(numero) {
  const s = soloDigitos(numero);
  for (const [marca, re] of MARCAS) {
    if (re.test(s)) return marca;
  }
  return null;
}

/**
 * Valida numero y detecta marca.
 * @returns {{numero:string, valido:boolean, marca:string|null, luhn:boolean}}
 */
export function validarNumero(numero) {
  const s = soloDigitos(numero);
  const luhn = luhnValido(s);
  return { numero: s, valido: luhn, marca: marcaDe(s), luhn };
}

function esCandidato(digitos) {
  if (digitos.length < 13 || digitos.length > 19) return false;
  return Boolean(marcaDe(digitos));
}

function normalizarVencimiento(mes, anio) {
  const m = Number.parseInt(soloDigitos(mes), 10);
  let a = soloDigitos(anio);
  if (a.length === 4) a = a.slice(-2);
  if (!(m >= 1 && m <= 12) || a.length !== 2) return null;
  return { mes: pad2(m), anio: a };
}

function esEtiqueta(token) {
  const limpio = String(token ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
  return ETIQUETAS.has(limpio);
}

function sobrantesDe(texto) {
  return String(texto ?? '')
    .split(/[|;,\t\s\/\-:=#]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !esEtiqueta(t));
}

/* Parsea el texto que sigue al numero hasta el proximo numero. */
function parsearResto(resto, marca) {
  let s = String(resto ?? '');
  let mes = '';
  let anio = '';
  let codigo = '';

  const quitar = (m) => {
    s = s.slice(0, m.index) + ' '.repeat(m[0].length) + s.slice(m.index + m[0].length);
  };

  /* CVV etiquetado: CODIGO/CVV/CVC 123 (o 1234 en Amex). */
  let m = s.match(
    /\b(?:cvv2?|cvc2?|cod(?:igo)?(?:\s+(?:de\s+)?seguridad)?|security\s+code)\b\s*[:=#-]?\s*(\d{3,4})\b/i
  );
  if (m) {
    codigo = m[1];
    quitar(m);
  }

  /* Vencimiento etiquetado: VTO/VENC/EXP/FECHA 12/28. */
  m = s.match(
    /\b(?:vto|venc(?:imiento)?|exp(?:ira|iry)?|fecha\s+(?:de\s+)?vencimiento)\b\s*[:=#-]?\s*(\d{1,2})\s*[\/\-.]?\s*(\d{2}|\d{4})\b/i
  );
  if (m) {
    const v = normalizarVencimiento(m[1], m[2]);
    if (v) {
      mes = v.mes;
      anio = v.anio;
      quitar(m);
    }
  }

  /* Etiquetas separadas MES / ANIO. */
  if (!mes) {
    m = s.match(/\bmes\b\s*[:=#-]?\s*(\d{1,2})\b/i);
    if (m) {
      const v = normalizarVencimiento(m[1], '01');
      if (v) {
        mes = v.mes;
        quitar(m);
      }
    }
  }
  if (!anio) {
    m = s.match(/\b(?:anio|año|year|yy)\b\s*[:=#-]?\s*(\d{2}|\d{4})\b/i);
    if (m) {
      const v = normalizarVencimiento(mes || '01', m[1]);
      if (v) {
        anio = v.anio;
        quitar(m);
      }
    }
  }

  /* Vencimiento con separador: 12/28, 12-2028, 12.28. */
  if (!mes || !anio) {
    m = s.match(/(?<!\d)(\d{1,2})\s*[\/.\-]\s*(\d{2}|\d{4})(?!\d)/);
    if (m) {
      const v = normalizarVencimiento(m[1], m[2]);
      if (v) {
        if (!mes) mes = v.mes;
        if (!anio) anio = v.anio;
        quitar(m);
      }
    }
  }

  const tokens = s
    .split(/[|;,\t\s\/\-:=#]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const usados = new Set();
  const dosDigitos = [];
  tokens.forEach((t, i) => {
    if (/^\d{2}$/.test(t)) dosDigitos.push(i);
  });

  /* Anio de 4 digitos (2028). */
  if (!anio) {
    const i = tokens.findIndex((t, idx) => !usados.has(idx) && /^(?:19|20)\d{2}$/.test(t));
    if (i >= 0) {
      anio = tokens[i].slice(-2);
      usados.add(i);
    }
  }

  /* Los dos 2 digitos mas cercanos: mes y despues anio. */
  if (!mes) {
    const i = dosDigitos.find((idx) => {
      const n = Number(tokens[idx]);
      return n >= 1 && n <= 12;
    });
    if (i !== undefined) {
      mes = tokens[i];
      usados.add(i);
    }
  }
  if (!anio) {
    const i = dosDigitos.find((idx) => !usados.has(idx));
    if (i !== undefined) {
      anio = tokens[i];
      usados.add(i);
    }
  }

  /* MMYY compacto (1228), solo si no habia dos numeros de 2 digitos. */
  if (!mes && !anio) {
    const i = tokens.findIndex(
      (t, idx) =>
        !usados.has(idx) &&
        /^\d{4}$/.test(t) &&
        !/^(?:19|20)\d{2}$/.test(t) &&
        normalizarVencimiento(t.slice(0, 2), t.slice(2))
    );
    if (i >= 0) {
      const v = normalizarVencimiento(tokens[i].slice(0, 2), tokens[i].slice(2));
      mes = v.mes;
      anio = v.anio;
      usados.add(i);
    }
  }

  /* CVV libre: 3 digitos (4 en Amex). */
  if (!codigo) {
    const largos = marca === 'amex' ? [4, 3] : [3];
    const i = tokens.findIndex(
      (t, idx) => !usados.has(idx) && largos.includes(t.length) && /^\d+$/.test(t)
    );
    if (i >= 0) {
      codigo = tokens[i];
      usados.add(i);
    }
  }

  const sobrantes = [];
  tokens.forEach((t, i) => {
    if (usados.has(i) || esEtiqueta(t)) return;
    sobrantes.push(t);
  });

  return { mes, anio, codigo, sobrantes };
}

function parsearTexto(entrada) {
  const s = decodificar(entrada);
  const re = new RegExp(RE_NUMERO_FUENTE, 'g');
  const matches = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    let bruto = m[0];
    let fin = m.index + bruto.length;
    let digitos = soloDigitos(bruto);

    /* 16 digitos agrupados + 3 digitos separados: por defecto el grupo de 3
     * es CVV, salvo que el numero completo (19) pase LUHN y los 16 no. */
    if (/^\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}$/.test(bruto)) {
      const cola = s.slice(fin).match(/^[ -](\d{3})(?!\d)/);
      if (cola) {
        const largo19 = digitos + cola[1];
        if (!luhnValido(digitos) && luhnValido(largo19)) {
          bruto += cola[0];
          fin += cola[0].length;
          digitos = largo19;
          re.lastIndex = fin;
        }
      }
    }

    if (!esCandidato(digitos)) continue;
    matches.push({ inicio: m.index, fin, numero: digitos });
  }

  if (!matches.length) {
    return { tarjetas: [], sobrantes: sobrantesDe(s) };
  }

  const tarjetas = [];
  const sobrantes = sobrantesDe(s.slice(0, matches[0].inicio));

  matches.forEach((actual, i) => {
    const siguiente = matches[i + 1];
    const resto = s.slice(actual.fin, siguiente ? siguiente.inicio : s.length);
    const marca = marcaDe(actual.numero);
    const r = parsearResto(resto, marca);
    tarjetas.push({
      numero: actual.numero,
      mes: r.mes,
      anio: r.anio,
      vencimiento: r.mes && r.anio ? `${r.mes}/${r.anio}` : '',
      codigo: r.codigo,
      cvv: r.codigo,
      marca: marca || '',
      luhn: luhnValido(actual.numero),
    });
    sobrantes.push(...r.sobrantes);
  });

  return { tarjetas, sobrantes };
}

function normalizarObjeto(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const numero = soloDigitos(
    obj.numero ?? obj.cc ?? obj.pan ?? obj.tarjeta ?? obj.nro ?? obj.cardNumber
  );
  if (!esCandidato(numero)) return null;

  let mes = soloDigitos(obj.mes ?? obj.mm ?? obj.month);
  let anio = soloDigitos(obj.anio ?? obj.año ?? obj.anioVencimiento ?? obj.yy ?? obj.year);
  let v = normalizarVencimiento(mes, anio);
  if (!v && obj.vencimiento) {
    const s = String(obj.vencimiento).trim();
    const m = s.match(/^(\d{1,2})\s*[\/\-.]?\s*(\d{2}|\d{4})$/);
    if (m) v = normalizarVencimiento(m[1], m[2]);
  }
  mes = v ? v.mes : '';
  anio = v ? v.anio : '';

  const codigo = soloDigitos(
    obj.codigo ?? obj.cvv ?? obj.cvc ?? obj.cod ?? obj.securityCode ?? obj.codigoSeguridad
  ).slice(0, 4);

  return {
    numero,
    mes,
    anio,
    vencimiento: mes && anio ? `${mes}/${anio}` : '',
    codigo,
    cvv: codigo,
    marca: marcaDe(numero) || '',
    luhn: luhnValido(numero),
  };
}

/**
 * Parsea una entrada (texto, array de textos/objetos) y devuelve registros y
 * sobrantes. Un numero distinto abre un registro nuevo.
 * @param {string|Array|object} entrada
 * @returns {{tarjetas:Array<object>, sobrantes:string[]}}
 */
export function parsearTarjetas(entrada) {
  const tarjetas = [];
  const sobrantes = [];

  const agregar = (valor) => {
    if (valor === null || valor === undefined) return;
    if (Array.isArray(valor)) {
      valor.forEach(agregar);
      return;
    }
    if (typeof valor === 'object') {
      const t = normalizarObjeto(valor);
      if (t) tarjetas.push(t);
      return;
    }
    const r = parsearTexto(valor);
    tarjetas.push(...r.tarjetas);
    sobrantes.push(...r.sobrantes);
  };

  agregar(entrada);
  return { tarjetas, sobrantes };
}

/**
 * Parsea un unico registro. Devuelve null si no hay numero reconocible.
 * @param {string|object} bruto
 * @returns {object|null}
 */
export function parsearTarjeta(bruto) {
  if (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) {
    return normalizarObjeto(bruto);
  }
  const { tarjetas } = parsearTarjetas(bruto);
  return tarjetas[0] || null;
}

/** Compatibilidad: array de registros. */
export function parsearEntrada(entrada) {
  return parsearTarjetas(entrada).tarjetas;
}

/** Lee un .txt y devuelve los registros parseados. */
export function cargarArchivo(ruta) {
  try {
    return parsearTarjetas(fs.readFileSync(ruta, 'utf8')).tarjetas;
  } catch (_) {
    return [];
  }
}

/** Resumen de un lote: total, LUHN validos/invalidos y sobrantes. */
export function analizar(entrada) {
  const { tarjetas, sobrantes } = parsearTarjetas(entrada);
  const validos = tarjetas.filter((t) => t.luhn).length;
  return {
    total: tarjetas.length,
    validos,
    invalidos: tarjetas.length - validos,
    sobrantes,
  };
}
