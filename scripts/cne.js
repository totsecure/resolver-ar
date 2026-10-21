#!/usr/bin/env node
/* scripts/cne.js — CLI del padron CNE.
 *
 * Uso:
 *   node scripts/cne.js estado
 *   node scripts/cne.js captcha
 *   node scripts/cne.js cache <dni>
 *   node scripts/cne.js consultar <dni> <m|f|x> <distritoId> <codigo> <token>
 *   node scripts/cne.js probe
 *
 * "estado" NO sale a la red. "probe" prueba config + captcha con timeout corto
 * y reporta el estado real del endpoint (hoy 503 / timeout). Nunca lanza.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as cne from '../lib/cne.js';

const argv = process.argv.slice(2);
const cmd = argv[0];

const RUTA_CONFIG = path.join(import.meta.dirname, '..', 'datos', 'cne-config.json');

const imprimir = (obj) => console.log(JSON.stringify(obj, null, 2));

function leerConfigCache() {
  try {
    return JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
  } catch (_) {
    return null;
  }
}

function guardarConfigCache(cfg) {
  try {
    fs.mkdirSync(path.dirname(RUTA_CONFIG), { recursive: true });
    fs.writeFileSync(RUTA_CONFIG, JSON.stringify(cfg, null, 2));
  } catch (_) {}
}

/* online_since puede venir en ms o en segundos. */
function fechaLocal(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n);
}

function uso() {
  console.log('uso:');
  console.log('  node scripts/cne.js estado');
  console.log('  node scripts/cne.js config');
  console.log('  node scripts/cne.js captcha');
  console.log('  node scripts/cne.js cache <dni>');
  console.log('  node scripts/cne.js consultar <dni> <m|f|x> <distritoId> <codigo> <token>');
  console.log('  node scripts/cne.js probe');
}

async function main() {
  if (!cmd || cmd === '-h' || cmd === '--help') {
    uso();
    return 0;
  }

  if (cmd === 'estado') {
    const s = cne.stats();
    console.log('CNE — estado (sin red)');
    console.log('BASE:      ' + cne.BASE);
    console.log('TTL:       ' + cne.TTL_DIAS + ' dias');
    console.log('distritos: ' + Object.entries(cne.DISTRITOS).map(([id, n]) => id + '=' + n).join(' | '));
    console.log('tabla cne: ' + (s.error ? 'ERROR ' + s.error : 'OK') +
      ' | filas=' + s.cacheados + ' | con domicilio=' + s.conDomicilio +
      ' | con fechaEjemplar=' + s.conFechaEjemplar);
    console.log('intentos:  ' + s.intentos);
    if (s.ultimoIntento) {
      console.log('ultimo:    ' + s.ultimoIntento.ts + ' dni=' + s.ultimoIntento.dni +
        ' http=' + (s.ultimoIntento.http ?? '-') + ' motivo=' + (s.ultimoIntento.motivo ?? '-'));
    } else {
      console.log('ultimo:    (sin intentos registrados)');
    }
    console.log('endpoint:  no probado en "estado"; usar "probe" para verificar');
    return 0;
  }

  if (cmd === 'config') {
    const timeout = Number(process.env.CNE_CONFIG_TIMEOUT_MS || 5000);
    let cfg = null;
    let origen = 'RED';
    let error = null;

    const r = await cne.pedirConfig(timeout);
    if (r.ok && r.json) {
      cfg = r.json;
      guardarConfigCache(cfg);
    } else {
      error = r.motivo || `HTTP ${r.http}`;
      cfg = leerConfigCache();
      origen = cfg ? 'CACHE' : 'SIN_DATOS';
    }

    if (!cfg) {
      console.error('config: NO DISPONIBLE | ' + error);
      return 1;
    }

    const online = fechaLocal(cfg.status?.online_since);
    const faltan = online ? Math.ceil((online.getTime() - Date.now()) / 86400000) : null;

    console.log('CNE — config');
    console.log('origen:             ' + origen + (error ? ' (fallo de red: ' + error + ')' : ''));
    const mode = cfg.status?.mode ?? 'AUSENTE';
    console.log('status.mode:        ' + mode);
    console.log('status.online_since:' + (online ? ' ' + online.toLocaleString('es-AR') + ' (' + online.toISOString() + ')' : ' AUSENTE'));
    if (faltan !== null && faltan > 0) console.log('faltan:             ' + faltan + ' dias para online_since');
    if (faltan !== null && faltan <= 0) console.log('online_since:       ya paso (hace ' + Math.abs(faltan) + ' dias)');
    console.log('dictamen:           ' + (mode === 'on'
      ? 'SERVICIO ABIERTO (mode=on)'
      : `SERVICIO CERRADO (mode=${mode}, distritos deshabilitados)`));
    console.log('votacion.instancia: ' + (cfg.votacion?.instancia ?? 'AUSENTE'));
    console.log('votacion.fecha:     ' + (cfg.votacion?.fecha ?? 'AUSENTE'));
    console.log('nacional.enabled:   ' + (cfg.nacional?.enabled ?? 'AUSENTE (el config no trae la clave)'));
    console.log('provincial.enabled: ' + (cfg.provincial?.enabled ?? 'AUSENTE (el config no trae la clave)'));
    console.log('');
    console.log('distritos:');
    console.log('  id  | distrito                   | estado');
    console.log('  ----+----------------------------+-------');
    const distritos = Array.isArray(cfg.distritos) ? cfg.distritos : [];
    for (const x of distritos) {
      const nombre = cne.DISTRITOS[x.id] ?? '(sin nombre)';
      console.log('  ' + String(x.id).padEnd(4) + '| ' + nombre.padEnd(26) + '| ' + (x.estado ?? 'AUSENTE'));
    }
    return 0;
  }

  if (cmd === 'captcha') {
    const r = await cne.pedirCaptcha();
    imprimir(r);
    return r.ok ? 0 : 1;
  }

  if (cmd === 'cache') {
    const dni = argv[1];
    if (!dni) { uso(); return 1; }
    const fila = cne.leer(dni);
    if (!fila) {
      console.log('sin cache para DNI ' + dni);
      return 0;
    }
    imprimir(fila);
    return 0;
  }

  if (cmd === 'consultar') {
    const [dni, sexo, distrito, codigo, token] = argv.slice(1);
    if (!dni || !sexo || !distrito || !codigo || !token) {
      console.error('faltan argumentos: <dni> <m|f|x> <distritoId> <codigo> <token>');
      uso();
      return 1;
    }
    const r = await cne.consultarRemoto(dni, { sexo, distrito, codigo, token });
    if (r.ok) {
      const guardado = cne.guardar(dni, r.datos, { distrito: r.distrito, crudo: r.crudo });
      imprimir({ ...r, guardado: Boolean(guardado) });
      return 0;
    }
    imprimir(r);
    return 1;
  }

  if (cmd === 'probe') {
    console.log('probando ' + cne.BASE + ' ...');
    const config = await cne.pedirConfig(5000);
    console.log('config:  ' + (config.ok ? 'OK' : 'FALLA') +
      ' | http=' + (config.http ?? '-') + (config.motivo ? ' | ' + config.motivo : ''));
    const captcha = await cne.pedirCaptcha();
    console.log('captcha: ' + (captcha.ok
      ? 'OK | token=' + captcha.token + ' | segundos=' + captcha.segundos + ' | ' + captcha.ruta
      : 'FALLA | http=' + (captcha.http ?? '-') + ' | ' + captcha.motivo));
    console.log('diagnostico: ' +
      (config.ok || captcha.ok
        ? 'endpoint responde parcialmente'
        : 'endpoint NO DISPONIBLE (hoy: HAProxy sin backends). El sistema usa cache/AUSENTE.'));
    return 0;
  }

  console.error('comando desconocido: ' + cmd);
  uso();
  return 1;
}

try {
  process.exit(await main());
} catch (e) {
  console.error('cne: error inesperado: ' + (e?.message || e));
  process.exit(2);
}
