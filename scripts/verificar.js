#!/usr/bin/env node
/* verificar.js — tests OFFLINE de resolver-ar (30).
 *
 * No usa red: el endpoint del CNE esta caido (HAProxy sin backends -> captcha 503)
 * y RENAPER es un free tier que puede dormir.
 * Salida: "  OK    <nombre>" / "  FAIL  <nombre> :: <motivo>" y "N OK / M FAIL".
 * Exit 0 solo si M = 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { VERSION, fnv1a, generarMail, generarTelefono, generarSinteticos } from '../lib/faker-ar.js';
import * as cne from '../lib/cne.js';
import * as renaper from '../lib/renaper.js';
import { enriquecerPersona } from '../lib/enriquecer.js';
import { modoNacimiento, mostrarTramitePendiente } from '../lib/config.js';
import { calcular } from '../lib/cobertura.js';
import { ficha, fichaDetalle } from '../lib/ficha.js';
import { armarBloque, generarLote, seleccionarTitulares } from '../lib/lote.js';
import { resolver } from '../lib/resolver.js';
import { renderizar } from '../lib/informe.js';
import { normalizarDni, parsearMensaje } from '../bot/telegram.js';
import { asegurarPool, sembrarPool, elegirDelPool } from './pool.js';
import {
  normalizarTexto, buscarPorPrefijo, ambiguedades, buscarPorCuit, personasPorDni,
} from '../lib/padron.js';

const RAIZ = path.join(import.meta.dirname, '..');
const RUTA_DB = path.join(RAIZ, 'datos', 'padron.db');
const RUTA_FIXTURE = path.join(RAIZ, 'tests', 'fixture-cne.json');
const RUTA_FIXTURE_RENAPER = path.join(RAIZ, 'tests', 'fixture-renaper.json');
const PERSONA = { nombre: 'JUAN', apellido: 'PEREZ', provincia: 'CORDOBA' };
const DNI = '3348';
const CARDS_LOTE = [
  '5456123412341234%7C11%7C25%7C575',
  '5456 1234 5678 9010|12|26|123',
  '5456123412341236|01|27|456',
];
const TITULARES_DEMO = [
  { dni: '3348', apellido: 'PEREZ', nombre: 'JUAN' },
  { dni: '30756789', apellido: 'BUCCINO', nombre: 'HERNAN CESAR GONZALO' },
  { dni: '39466006', apellido: 'GOMEZ', nombre: 'NALE MARINA' },
];

const AREAS_CORDOBA = ['351', '352', '353', '3541', '3543', '3571', '358'];
const PATRONES_ESPERADOS = ['nombre.apellido', 'nombreapellido', 'nombre.apellido##', 'inicial+apellido', 'nombre###'];
const DOMINIOS = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com.ar', 'live.com.ar'];

let ok = 0;
let fail = 0;
const fallos = [];

function assert(cond, motivo) {
  if (!cond) throw new Error(motivo || 'assert fallo');
}

const ETIQUETAS_FICHA = ['TITULAR', 'DNI', 'NRO TRAMITE', 'FECHA NAC', 'MAIL', 'TELEFONO', 'DIRECCION', 'CIUDAD', 'PROVINCIA', 'PAIS'];
const FORMATOS_FICHA = {
  DNI: /^\d{8}$/,
  'NRO TRAMITE': /^(\d{11}|\(pendiente\))$/,
  'FECHA NAC': /^(\d{2}\/\d{2}\/\d{4}|\(pendiente\))$/,
  MAIL: /^[a-z][a-z0-9._]*@[a-z0-9.-]+$/,
  TELEFONO: /^\d{2,4} \d{6,8}$/,
  PAIS: /^Argentina$/,
};

/* Valida las líneas esperadas (NRO TRAMITE puede omitirse si está pendiente). */
function validarFicha(texto, contexto = 'ficha') {
  const lineas = String(texto).split('\n');
  const etiquetas = ETIQUETAS_FICHA.filter((e) => e !== 'NRO TRAMITE' || /^NRO TRAMITE /m.test(texto));
  assert(lineas.length === etiquetas.length, contexto + ': lineas=' + lineas.length + '/' + etiquetas.length);
  etiquetas.forEach((etiqueta, i) => {
    assert(lineas[i].startsWith(etiqueta + ' '), contexto + ': linea ' + (i + 1) + ': ' + lineas[i]);
    const valor = lineas[i].slice(etiqueta.length + 1);
    if (valor !== '-' && FORMATOS_FICHA[etiqueta]) {
      assert(FORMATOS_FICHA[etiqueta].test(valor),
        contexto + ': ' + etiqueta + ' con formato invalido: ' + JSON.stringify(valor));
    }
  });
  return lineas;
}

async function correr(nombre, fn) {
  try {
    await fn();
    ok++;
    console.log('  OK    ' + nombre);
  } catch (e) {
    fail++;
    const motivo = String(e?.message || e).replace(/\s+/g, ' ').trim().slice(0, 300);
    fallos.push({ nombre, motivo });
    console.log('  FAIL  ' + nombre + ' :: ' + motivo);
  }
}

const tests = [
  ['mail determinista en proceso', () => {
    const a = generarMail(DNI, PERSONA);
    const b = generarMail(DNI, PERSONA);
    assert(a.valor === b.valor, 'dos llamadas dieron distinto: ' + a.valor + ' != ' + b.valor);
    assert(typeof a.valor === 'string' && a.valor.includes('@'), 'mail vacio o invalido');
    assert(typeof fnv1a(DNI + ':mail') === 'number', 'fnv1a no devuelve numero');
    assert(typeof VERSION === 'string' && VERSION.length > 0, 'VERSION ausente');
  }],

  ['mail determinista entre procesos', () => {
    const url = pathToFileURL(path.join(RAIZ, 'lib', 'faker-ar.js')).href;
    const codigo = [
      `import { generarMail } from ${JSON.stringify(url)};`,
      `process.stdout.write(generarMail(${JSON.stringify(DNI)}, ${JSON.stringify(PERSONA)}).valor);`,
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', codigo], {
      encoding: 'utf8',
      timeout: 30000,
    }).trim();
    const local = generarMail(DNI, PERSONA).valor;
    assert(out === local, 'otro proceso dio "' + out + '" y este "' + local + '"');
  }],

  ['teléfono determinista', () => {
    const a = generarTelefono(DNI, PERSONA);
    const b = generarTelefono(DNI, PERSONA);
    assert(a.valor === b.valor, 'dos llamadas dieron distinto: ' + a.valor + ' != ' + b.valor);
    const c = generarTelefono(DNI, { nombre: 'OTRO', apellido: 'APELLIDO', provincia: 'CORDOBA' });
    assert(c.valor === a.valor, 'el telefono depende del nombre y no solo del DNI');
    assert(a.fuente === 'SINTETICO', 'fuente distinta de SINTETICO');
  }],

  ['los 5 patrones de mail alcanzables', () => {
    const vistos = new Set();
    for (let i = 1; i <= 400 && vistos.size < 5; i++) {
      const m = generarMail(String(i).padStart(8, '0'), PERSONA);
      vistos.add(m.patron);
    }
    for (const p of PATRONES_ESPERADOS) assert(vistos.has(p), 'patron no alcanzado: ' + p);
    assert(vistos.size === 5, 'se alcanzaron ' + vistos.size + ' patrones: ' + [...vistos].join(','));
  }],

  ['celular entre 64% y 76%', () => {
    const N = 2000;
    let cel = 0;
    for (let i = 1; i <= N; i++) {
      const t = generarTelefono(String(i).padStart(8, '0'), { provincia: 'CORDOBA' });
      if (t.tipo === 'celular') cel++;
    }
    const pct = (100 * cel) / N;
    assert(pct >= 64 && pct <= 76, 'proporcion de celular fuera de rango: ' + pct.toFixed(2) + '%');
  }],

  ['área coherente con la provincia (CÓRDOBA)', () => {
    for (let i = 1; i <= 100; i++) {
      const t = generarTelefono(String(i).padStart(8, '0'), { provincia: 'Córdoba' });
      assert(AREAS_CORDOBA.includes(t.area), 'area ' + t.area + ' no corresponde a Cordoba');
      assert(t.provincia === 'CORDOBA', 'provincia declarada incorrecta: ' + t.provincia);
      assert(t.valor.startsWith(t.area), 'el valor no empieza con el area: ' + t.valor);
    }
  }],

  ['mail válido, sin acentos, <=64', () => {
    const re = new RegExp(
      '^[a-z][a-z0-9._]{0,31}@(' + DOMINIOS.map((d) => d.replace(/\./g, '\\.')).join('|') + ')$'
    );
    for (let i = 1; i <= 500; i++) {
      const m = generarMail(String(i).padStart(8, '0'), { nombre: 'JOSÉ MARÍA', apellido: 'MUÑOZ ÁVILA' });
      assert(m.valor.length <= 64, 'mail de ' + m.valor.length + ' chars: ' + m.valor);
      assert(m.valor === m.valor.normalize('NFD').replace(/[\u0300-\u036f]/g, ''), 'mail con acentos: ' + m.valor);
      assert(!/[A-ZÁÉÍÓÚÑ]/.test(m.valor), 'mail con mayusculas o acentos: ' + m.valor);
      assert(re.test(m.valor), 'mail con formato invalido: ' + m.valor);
      assert(m.valor.split('@').length === 2, 'mail con mas de un @: ' + m.valor);
    }
  }],

  ['fuente SINTETICO + regla presente', () => {
    const m = generarMail(DNI, PERSONA);
    const t = generarTelefono(DNI, PERSONA);
    const s = generarSinteticos(DNI, PERSONA);
    for (const [nombre, campo] of [['mail', m], ['telefono', t], ['mail/sinteticos', s.mail], ['telefono/sinteticos', s.telefono]]) {
      assert(campo.fuente === 'SINTETICO', nombre + ': fuente=' + campo.fuente);
      assert(typeof campo.regla === 'string' && campo.regla.length > 0, nombre + ': falta regla');
    }
    assert(s.fuente === 'SINTETICO', 'generarSinteticos no declara fuente');
  }],

  ['tabla cne creada y legible', () => {
    assert(cne.asegurar() === true, 'asegurar() no devolvio true');
    const db = new DatabaseSync(RUTA_DB);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      assert(tablas.includes('cne'), 'falta la tabla cne');
      assert(tablas.includes('cne_intentos'), 'falta la tabla cne_intentos');
      const cols = db.prepare("SELECT name FROM pragma_table_info('cne')").all().map((r) => r.name);
      for (const c of ['dni', 'domicilio', 'localidad', 'fechaEjemplar', 'circuito', 'seccion',
        'establecimiento', 'direccionVoto', 'mesa', 'orden', 'lat', 'lng', 'codRef', 'distrito',
        'fuente', 'capturado', 'ttl_dias', 'crudo']) {
        assert(cols.includes(c), 'falta columna cne.' + c);
      }
      assert(Array.isArray(db.prepare('SELECT * FROM cne LIMIT 1').all()), 'cne ilegible');
      assert(Array.isArray(db.prepare('SELECT * FROM cne_intentos LIMIT 1').all()), 'cne_intentos ilegible');
      const s = cne.stats();
      assert(typeof s.cacheados === 'number' && typeof s.intentos === 'number', 'stats invalido');
    } finally {
      try { db.close(); } catch (_) {}
    }
  }],

  ['cne sin red -> AUSENTE sin lanzar', async () => {
    const sync = cne.obtenerSync('99999999', { sinRed: true });
    assert(sync && sync.fuente === 'AUSENTE', 'sync no devolvio AUSENTE: ' + JSON.stringify(sync));
    assert(typeof sync.motivo === 'string' && sync.motivo.length > 0, 'sync sin motivo');
    const asyn = await cne.obtener('99999998', { sinRed: true });
    assert(asyn && asyn.fuente === 'AUSENTE', 'async no devolvio AUSENTE');
    assert(typeof asyn.motivo === 'string' && asyn.motivo.length > 0, 'async sin motivo');
    const raro = await cne.obtener('no-es-un-dni', { sinRed: true });
    assert(raro && raro.fuente === 'AUSENTE', 'dni invalido no devolvio AUSENTE');
  }],

  ['interpretar() mapea tests/fixture-cne.json', () => {
    const fixture = JSON.parse(fs.readFileSync(RUTA_FIXTURE, 'utf8'));
    const d = cne.interpretar(fixture);
    assert(d.fuente === 'REAL_CNE', 'fuente=' + d.fuente);
    const esperado = {
      domicilio: 'AV SIEMPREVIVA 742',
      localidad: 'LA PLATA',
      fechaEjemplar: '12/05/2015',
      circuito: '0123',
      seccion: '1',
      establecimiento: 'ESCUELA 5',
      direccionVoto: 'CALLE 50 1234',
      mesa: '45',
      orden: '12',
      lat: -34.9,
      lng: -57.9,
      codRef: 'ABC123',
      estado: 'A',
    };
    for (const [k, v] of Object.entries(esperado)) {
      assert(d[k] === v, k + ' = ' + JSON.stringify(d[k]) + ', esperaba ' + JSON.stringify(v));
    }
    assert(!('anioNac' in d), 'interpretar invento anioNac (el CNE devuelve fecha de EJEMPLAR)');
    assert(!('fechaNacimiento' in d), 'interpretar invento fechaNacimiento');
  }],

  ['enriquecer agrega SINTETICO, marca AUSENTE, no re-enriquece, no pisa reales', () => {
    const base = {
      dni: '3348', nombre: 'JUAN', apellido: 'PEREZ', provincia: 'CORDOBA',
      mail: 'real@empresa.com', mail_fuente: 'REAL_AFIP',
      domicilio: 'CALLE REAL 123', domicilio_fuente: 'REAL_AFIP',
    };
    const p = enriquecerPersona(base);
    assert(p.mail === 'real@empresa.com', 'piso el mail real');
    assert(p.mail_fuente === 'REAL_AFIP', 'cambio la fuente del mail real');
    assert(p.domicilio === 'CALLE REAL 123', 'piso el domicilio real');
    assert(p.domicilio_fuente === 'REAL_AFIP', 'cambio la fuente del domicilio real');
    assert(typeof p.telefono === 'string' && p.telefono_fuente === 'SINTETICO', 'no agrego telefono SINTETICO');
    assert(p._fuente.telefono === 'SINTETICO', '_fuente.telefono != SINTETICO');
    assert(p.fechaEjemplar === null, 'invento fechaEjemplar sin CNE');
    assert(p.fechaEjemplar_fuente === 'AUSENTE', 'fechaEjemplar no quedo AUSENTE');
    assert(p._fuente.fechaEjemplar === 'AUSENTE', '_fuente.fechaEjemplar != AUSENTE');

    const nuevo = enriquecerPersona({ dni: '3348', nombre: 'JUAN', apellido: 'PEREZ' });
    assert(nuevo.mail_fuente === 'SINTETICO' && nuevo._fuente.mail === 'SINTETICO', 'no agrego mail SINTETICO');
    assert(nuevo.mail === generarMail('3348', PERSONA).valor, 'el mail enriquecido no es el determinista');

    const antes = JSON.stringify(p);
    const otra = enriquecerPersona(p);
    assert(otra === p, 'la segunda llamada devolvio otro objeto');
    assert(JSON.stringify(p) === antes, 'la segunda llamada modifico el objeto');

    const noEncontrado = enriquecerPersona({ dni: '99999999', encontrado: false, motivo: 'no figura' });
    assert(noEncontrado.mail === undefined, 'invento un mail para un DNI no encontrado');
    assert(noEncontrado._fuente.mail === 'AUSENTE', 'no marco AUSENTE el mail de un no encontrado');
  }],

  ['cobertura calcula >1M personas y 0<pct<100', () => {
    const c = calcular();
    assert(c && typeof c === 'object', 'calcular no devolvio objeto');
    assert(c.personas > 1000000, 'personas=' + c.personas + ' (esperaba >1.000.000)');
    assert(c.coberturaPct > 0 && c.coberturaPct < 100, 'coberturaPct=' + c.coberturaPct);
    assert(c.electores === 35000000, 'electores=' + c.electores);
    assert(typeof c.tabla === 'string' && c.tabla.length > 0, 'tabla=' + c.tabla);
    assert(c.ambiguos >= 0, 'ambiguos invalido');
  }],

  ['renaper.interpretar mapea el fixture a fechaNac, nroTramite y direccion', () => {
    const fixture = JSON.parse(fs.readFileSync(RUTA_FIXTURE_RENAPER, 'utf8'));
    const d = renaper.interpretar(fixture);
    assert(d.fuente === 'REAL_RENAPER', 'fuente=' + d.fuente);
    assert(d.apellido === 'GOMEZ' && d.nombres === 'MARIA', 'apellido/nombres no mapeados');
    assert(d.fechaNac === '15/05/1985', 'fechaNac=' + JSON.stringify(d.fechaNac));
    /* El servicio no devuelve nroTramite: debe quedar AUSENTE, no inventarse. */
    assert(d.nroTramite === null, 'nroTramite=' + JSON.stringify(d.nroTramite));
    assert(d.direccion === 'AV. CORRIENTES 1234', 'direccion=' + JSON.stringify(d.direccion));
    assert(d.ciudad === 'CABA', 'ciudad=' + JSON.stringify(d.ciudad));
    assert(d.provincia === 'BUENOS AIRES', 'provincia=' + JSON.stringify(d.provincia));
    assert(d.cpostal === 'C1043', 'cpostal=' + JSON.stringify(d.cpostal));
    assert(d.cuilRenaper === null, 'cuilRenaper=' + JSON.stringify(d.cuilRenaper));

    const conError = renaper.interpretar({ codigoError: 200, error: true, descripcionError: 'sin datos' });
    assert(conError.fuente === 'AUSENTE' && conError.motivo === 'sin datos', 'no degrado a AUSENTE');
    const vacio = renaper.interpretar({ codigoError: 200, error: false, apellido: '', calle: null });
    assert(vacio.fuente === 'AUSENTE', 'payload vacio no degrado a AUSENTE');
    assert(vacio.fechaNac === null && vacio.direccion === null, 'invento datos en payload vacio');
  }],

  ['renaper sin red -> AUSENTE sin lanzar', async () => {
    const sync = renaper.obtenerSync('99999996', { sinRed: true });
    assert(sync && sync.fuente === 'AUSENTE', 'sync no devolvio AUSENTE');
    assert(typeof sync.motivo === 'string' && sync.motivo.length > 0, 'sync sin motivo');
    const asyn = await renaper.obtener('99999996', { red: false });
    assert(asyn && asyn.fuente === 'AUSENTE', 'async no devolvio AUSENTE');
    assert(typeof asyn.motivo === 'string' && asyn.motivo.length > 0, 'async sin motivo');
    const invalido = await renaper.obtener('no-es-un-dni', { red: false });
    assert(invalido && invalido.fuente === 'AUSENTE', 'dni invalido no devolvio AUSENTE');
    assert(renaper.asegurar() === true, 'asegurar() no devolvio true');
    const s = renaper.stats();
    assert(typeof s.cacheados === 'number' && typeof s.intentos === 'number', 'stats invalido');
  }],

  ['ficha() devuelve las lineas en orden y con las etiquetas exactas', async () => {
    const texto = await ficha('3348', { red: false });
    const lineas = validarFicha(texto, 'ficha 3348');
    assert(lineas[0].startsWith('TITULAR '), 'TITULAR: ' + lineas[0]);
    assert(lineas[1] === 'DNI 00003348', 'DNI: ' + lineas[1]);
    assert(lineas[lineas.length - 1] === 'PAIS Argentina', 'PAIS: ' + lineas[lineas.length - 1]);
  }],

  ['ficha() sin red para un DNI inexistente: sin lanzar, nacimiento según modo y trámite omitido/pendiente', async () => {
    const modo = modoNacimiento();
    const texto = await ficha('99999997', { red: false });
    const lineas = validarFicha(texto, 'ficha inexistente');
    const valor = (etiqueta) => {
      const l = lineas.find((x) => x.startsWith(etiqueta + ' '));
      return l ? l.slice(etiqueta.length + 1) : null;
    };
    assert(lineas[0] === 'TITULAR -', 'TITULAR: ' + lineas[0]);
    assert(lineas[1] === 'DNI 99999997', 'DNI: ' + lineas[1]);
    if (modo === '1') {
      assert(/^\d{11}$/.test(valor('NRO TRAMITE') || ''), 'NRO TRAMITE modo 1: ' + valor('NRO TRAMITE'));
    } else {
      assert(valor('NRO TRAMITE') === null, 'NRO TRAMITE no debería imprimirse: ' + valor('NRO TRAMITE'));
    }
    if (modo === '0') {
      assert(valor('FECHA NAC') === '(pendiente)', 'FECHA NAC modo 0: ' + valor('FECHA NAC'));
    } else {
      assert(/^\d{2}\/\d{2}\/\d{4}$/.test(valor('FECHA NAC') || ''), 'FECHA NAC sintética: ' + valor('FECHA NAC'));
    }
    assert((valor('MAIL') || '').startsWith('u99999997@'), 'MAIL sin nombre deberia ser u<dni>: ' + valor('MAIL'));
    assert(valor('PAIS') === 'Argentina', 'PAIS: ' + valor('PAIS'));
  }],

  ['ficha() con cache renaper: NRO TRAMITE 11 digitos, FECHA NAC dd/mm/aaaa y TITULAR AUSENTE "-"', async () => {
    const dni = '87654321';
    assert(renaper.asegurar() === true, 'renaper.asegurar fallo');
    const guardado = renaper.guardar(dni, {
      fechaNac: '05/08/1979',
      nroTramite: '9876543',
      direccion: 'AV TEST 123',
      ciudad: 'CORDOBA',
      provincia: 'CORDOBA',
      cpostal: '5000',
      cuilRenaper: '20123456789',
    }, {
      crudo: {
        codigoError: 200,
        error: false,
        fechaNacimiento: '1979-08-05',
        idTramitePrincipal: '9876543',
        calle: 'AV TEST',
        numeroCalle: '123',
        ciudad: 'CORDOBA',
        provincia: 'CORDOBA',
        cpostal: '5000',
        cuil: '20123456789',
      },
    });
    assert(guardado && guardado.fuente === 'MANUAL', 'no se guardo la cache manual');

    const { texto, fuentes } = await fichaDetalle(dni, { red: false });
    const lineas = validarFicha(texto, 'ficha cache renaper');
    assert(lineas[0] === 'TITULAR -', 'TITULAR: ' + lineas[0]);
    assert(lineas[2] === 'NRO TRAMITE 00009876543', 'NRO TRAMITE sin padding: ' + lineas[2]);
    assert(lineas[3] === 'FECHA NAC 05/08/1979', 'FECHA NAC: ' + lineas[3]);
    assert(lineas[6] === 'DIRECCION AV TEST 123', 'DIRECCION: ' + lineas[6]);
    assert(fuentes.TITULAR === 'AUSENTE', 'TITULAR fuente=' + fuentes.TITULAR);
    assert(fuentes['NRO TRAMITE'] === 'MANUAL', 'NRO TRAMITE fuente=' + fuentes['NRO TRAMITE']);
    assert(fuentes['FECHA NAC'] === 'MANUAL', 'FECHA NAC fuente=' + fuentes['FECHA NAC']);
  }],

  ['lote: 3 tarjetas devuelven 3 bloques numerados desde 1', () => {
    const texto = generarLote(CARDS_LOTE, { desde: 1 });
    const bloques = texto.split(/\n\n(?=TARJETA #\d+\n)/);
    assert(bloques.length === 3, 'bloques=' + bloques.length);
    bloques.forEach((bloque, i) => {
      assert(bloque.startsWith('TARJETA #' + (i + 1) + '\n'), 'cabecera del bloque ' + (i + 1) + ': ' + bloque.split('\n')[0]);
      assert(bloque.includes('\nDATOS TITULAR\n'), 'bloque ' + (i + 1) + ' sin DATOS TITULAR');
      assert(bloque.includes('\nDATOS TARJETA\n'), 'bloque ' + (i + 1) + ' sin DATOS TARJETA');
      assert(/^DNI \d{8}$/m.test(bloque), 'bloque ' + (i + 1) + ' con DNI invalido');
      const conTramite = /^NRO TRAMITE (\d{11}|\(pendiente\))$/m.test(bloque);
      const conPendiente = /^NRO TRAMITE \(pendiente\)$/m.test(bloque);
      if (conPendiente) {
        assert(mostrarTramitePendiente(), 'bloque ' + (i + 1) + ' imprime tramite pendiente con flag 0');
      } else if (!conTramite) {
        assert(!mostrarTramitePendiente(), 'bloque ' + (i + 1) + ' sin tramite y flag 0');
      }
      assert(/^FECHA NAC (\d{2}\/\d{2}\/\d{4}|\(pendiente\))$/m.test(bloque), 'bloque ' + (i + 1) + ' con fecha invalida');
      assert(/^VENCIMIENTO \d{2}\/\d{2}$/m.test(bloque), 'bloque ' + (i + 1) + ' con vencimiento invalido');
      assert(/^CODIGO \d{3}$/m.test(bloque), 'bloque ' + (i + 1) + ' con codigo invalido');
    });
  }],

  ['lote: desde=51 numera desde 51', () => {
    const texto = generarLote(CARDS_LOTE, { desde: 51, titulares: TITULARES_DEMO });
    const cabeceras = texto.match(/^TARJETA #\d+$/gm) || [];
    assert(cabeceras.length === 3, 'cabeceras=' + cabeceras.length);
    assert(cabeceras[0] === 'TARJETA #51', 'primera cabecera: ' + cabeceras[0]);
    assert(cabeceras[1] === 'TARJETA #52', 'segunda cabecera: ' + cabeceras[1]);
    assert(cabeceras[2] === 'TARJETA #53', 'tercera cabecera: ' + cabeceras[2]);
  }],

  ['lote: orden precalculado conserva los 3 primeros DNIs', () => {
    const texto = generarLote(CARDS_LOTE, { desde: 1, saltar: 0 });
    const dnis = (texto.match(/^DNI (\d{8})$/gm) || []).map((l) => l.slice(4));
    assert(dnis.length === 3, 'DNIs=' + dnis.length);
    assert(dnis.join(',') === '30756789,39466006,06219380', 'primeros DNIs: ' + dnis.join(','));
  }],

  ['lote: saltar=100 no repite DNIs contra saltar=0', () => {
    const dnis = (texto) => (texto.match(/^DNI (\d{8})$/gm) || []).map((l) => l.slice(4));
    const base = dnis(generarLote(CARDS_LOTE, { desde: 1, saltar: 0 }));
    const saltados = dnis(generarLote(CARDS_LOTE, { desde: 1, saltar: 100 }));
    assert(base.length === 3, 'base=' + base.length);
    assert(saltados.length === 3, 'saltados=' + saltados.length);
    assert(new Set(base).size === 3, 'DNIs repetidos en saltar=0: ' + base.join(','));
    assert(new Set(saltados).size === 3, 'DNIs repetidos en saltar=100: ' + saltados.join(','));
    const repetidos = saltados.filter((d) => base.includes(d));
    assert(repetidos.length === 0, 'repite DNIs: ' + repetidos.join(','));
  }],

  ['sinteticos unificados: mismo DNI => mismo mail y telefono en ficha/informe/lote/titulares', async () => {
    const db = new DatabaseSync(RUTA_DB);
    try {
      const titulares = seleccionarTitulares(db, { cantidad: 3, saltar: 0 });
      const dnis = titulares.map((t) => t.dni);
      assert(dnis.join(',') === '30756789,39466006,06219380', 'primeros DNIs: ' + dnis.join(','));

      const lote = generarLote(CARDS_LOTE, { desde: 1, saltar: 0 });
      const bloquesLote = lote.split(/\n\n(?=TARJETA #\d+\n)/);
      const bloquesTitulares = titulares.map((t) => armarBloque(t, null, null));

      const extraer = (texto) => {
        const mail = String(texto).match(/^MAIL\s+(.+)$/m)?.[1]?.trim() || null;
        const telefono = String(texto).match(/^TELEFONO\s+(.+)$/m)?.[1]?.trim() || null;
        return { mail, telefono, digitos: String(telefono ?? '').replace(/\D/g, '') };
      };

      for (let i = 0; i < dnis.length; i++) {
        const dni = dnis[i];
        const ficha = extraer((await fichaDetalle(dni, { red: false })).texto);
        const informe = extraer(renderizar(resolver(db, dni), null));
        const loteBloque = extraer(bloquesLote[i]);
        const titularBloque = extraer(bloquesTitulares[i]);

        assert(ficha.mail, dni + ': ficha sin mail');
        assert(ficha.digitos, dni + ': ficha sin telefono');
        for (const [origen, valor] of [
          ['informe', informe], ['lote', loteBloque], ['titulares', titularBloque],
        ]) {
          assert(valor.mail === ficha.mail,
            dni + ': mail distinto en ' + origen + ' (' + valor.mail + ' != ' + ficha.mail + ')');
          assert(valor.digitos === ficha.digitos,
            dni + ': telefono distinto en ' + origen + ' (' + valor.digitos + ' != ' + ficha.digitos + ')');
        }
      }
    } finally {
      db.close();
    }
  }],

  ['normaliza DNI con puntos, espacios, 7/8 y basura', () => {
    assert(normalizarDni('30.123.456') === '30123456', 'puntos: ' + normalizarDni('30.123.456'));
    assert(normalizarDni('30 123 456') === '30123456', 'espacios: ' + normalizarDni('30 123 456'));
    assert(normalizarDni('3012345') === '03012345', '7 digitos: ' + normalizarDni('3012345'));
    assert(normalizarDni('30123456') === '30123456', '8 digitos: ' + normalizarDni('30123456'));
    assert(normalizarDni('DNI: 30.123.456') === '30123456', 'texto con DNI: ' + normalizarDni('DNI: 30.123.456'));
    assert(normalizarDni('basura') === null, 'basura devolvio ' + normalizarDni('basura'));
    assert(normalizarDni('123') === null, '123 devolvio ' + normalizarDni('123'));
    assert(normalizarDni('21/10/2026') === null, 'fecha devolvio ' + normalizarDni('21/10/2026'));
  }],

  ['rutea comandos y DNI', () => {
    const start = parsearMensaje('/start@resolver_bot');
    assert(start.tipo === 'comando' && start.cmd === 'start', 'start: ' + JSON.stringify(start));
    const random = parsearMensaje('/random afip');
    assert(random.tipo === 'comando' && random.cmd === 'random' && random.args[0] === 'afip',
      'random afip: ' + JSON.stringify(random));
    const refresh = parsearMensaje('/refresh 30.123.456');
    assert(refresh.tipo === 'comando' && refresh.cmd === 'refresh' && refresh.args[0] === '30.123.456',
      'refresh: ' + JSON.stringify(refresh));
    const help = parsearMensaje('/help');
    assert(help.tipo === 'comando' && help.cmd === 'help', 'help: ' + JSON.stringify(help));
    const dni = parsearMensaje('hola 30.123.456');
    assert(dni.tipo === 'dni' && dni.dni === '30123456', 'dni en texto: ' + JSON.stringify(dni));
    const texto = parsearMensaje('hola');
    assert(texto.tipo === 'texto', 'texto: ' + JSON.stringify(texto));
  }],

  ['detecta lote sin /lote (regresión del estado perdido por keepalive)', () => {
    const lineas = Array.from({ length: 26 }, (_, i) =>
      `41111111111111${String(i).padStart(2, '0')}|12|28|123`);
    const lote = parsearMensaje(lineas.join('\n'));
    assert(lote.tipo === 'lote', '26 lineas de tarjetas sin /lote: ' + JSON.stringify(lote));
    assert(parsearMensaje('4111111111111111|12|28|123').tipo === 'lote',
      'una linea canonica debe ser lote');
    assert(parsearMensaje('4111111111111111\n5456123412341234').tipo === 'lote',
      'dos lineas con numeros de 13-19 deben ser lote');
    assert(parsearMensaje('4111111111111111').tipo === 'texto',
      'una sola linea suelta no es lote');
    assert(parsearMensaje('30123456').tipo === 'dni', 'un DNI sigue siendo DNI');
    assert(parsearMensaje('hola').tipo === 'texto', 'texto suelto no es DNI ni lote');
  }],

  ['/random devuelve un DNI que esta en el pool', () => {
    const db = new DatabaseSync(RUTA_DB);
    try {
      asegurarPool(db);
      sembrarPool(db);
      const dni = elegirDelPool(db);
      assert(dni && /^\d{8}$/.test(dni), 'DNI de pool invalido: ' + dni);
      const fila = db.prepare('SELECT 1 x FROM pool_random WHERE dni = ?').get(dni);
      assert(Boolean(fila), 'el DNI ' + dni + ' no esta en pool_random');
    } finally {
      db.close();
    }
  }],

  ['normaliza texto de busqueda (mayusculas, sin acentos)', () => {
    assert(normalizarTexto('Pérez') === 'PEREZ', 'Pérez: ' + normalizarTexto('Pérez'));
    assert(normalizarTexto('  JosÉ   María ') === 'JOSE MARIA', 'Jose Maria: ' + normalizarTexto('  JosÉ   María '));
    assert(normalizarTexto('MUÑOZ') === 'MUNOZ', 'MUÑOZ: ' + normalizarTexto('MUÑOZ'));
    assert(normalizarTexto('PEREZ-JUAN') === 'PEREZ JUAN', 'guion: ' + normalizarTexto('PEREZ-JUAN'));
  }],

  ['paginacion de /nombre y /ambig', () => {
    const db = new DatabaseSync(RUTA_DB);
    try {
      const p1 = buscarPorPrefijo(db, 'PEREZ', 0, 10);
      assert(p1.filas.length > 0 && p1.filas.length <= 10, 'pagina 1: ' + p1.filas.length);
      assert(typeof p1.haySiguiente === 'boolean', 'haySiguiente no es boolean');
      if (p1.haySiguiente) {
        const p2 = buscarPorPrefijo(db, 'PEREZ', 10, 10);
        assert(p2.filas.length > 0, 'pagina 2 vacia');
        const cuits1 = new Set(p1.filas.map((f) => f.cuit));
        assert(!p2.filas.some((f) => cuits1.has(f.cuit)), 'paginas solapadas');
      }
      const a = ambiguedades(db, 0, 10);
      assert(a.filas.length === 10 && a.haySiguiente === true, 'ambig pagina 1 invalida');
      assert(a.filas.every((x) => x.personas.length > 1), 'ambig con un solo CUIT');
    } finally {
      db.close();
    }
  }],

  ['/cuit devuelve el mismo registro que la consulta por DNI', () => {
    const db = new DatabaseSync(RUTA_DB);
    try {
      const porCuit = buscarPorCuit(db, '20000033481');
      const porDni = personasPorDni(db, '3348')[0];
      assert(porCuit && porDni, 'no encontrado por cuit o dni');
      assert(porCuit.cuit === porDni.cuit, 'CUIT distinto');
      assert(porCuit.dni === porDni.dni, 'DNI distinto');
      assert(porCuit.apellido === porDni.apellido, 'apellido distinto');
      assert(porCuit.nombre === porDni.nombre, 'nombre distinto');
    } finally {
      db.close();
    }
  }],

  ['invariantes de dominio (ledger, pedidos, API keys)', () => {
    try {
      execFileSync(process.execPath, [path.join(RAIZ, 'scripts', 'verificar-invariantes.mjs')], {
        cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const salida = String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').slice(-8).join(' | ');
      throw new Error(salida);
    }
  }],

  ['asientos por camino de saldo', () => {
    try {
      execFileSync(process.execPath, [path.join(RAIZ, 'scripts', 'test-asientos.mjs')], {
        cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const salida = String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').slice(-8).join(' | ');
      throw new Error(salida);
    }
  }],
];

console.log('VERIFICACION OFFLINE — resolver-ar');
console.log('');

for (const [nombre, fn] of tests) {
  await correr(nombre, fn);
}

console.log('');
console.log(ok + ' OK / ' + fail + ' FAIL');

if (fail > 0) {
  console.log('');
  for (const f of fallos) console.log('  - ' + f.nombre + ' :: ' + f.motivo);
  process.exit(1);
}
process.exit(0);
