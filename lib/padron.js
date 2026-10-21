/* padron.js — consultas locales contra la tabla personas.
 *
 * Columnas normalizadas (las llena scripts/indexar.js):
 *   apellido_norm, nombre_norm  (MAYUSCULAS, sin acentos)
 *
 * Búsqueda por prefijo con LIKE 'TEXTO%' sobre índices. Para que SQLite use
 * los índices se activa PRAGMA case_sensitive_like=ON (las columnas ya están
 * en mayúsculas).
 */

const ORDEN_CUIT = "CASE substr(cuit,1,2) WHEN '20' THEN 0 WHEN '27' THEN 1 WHEN '23' THEN 2 WHEN '24' THEN 3 ELSE 4 END, cuit";

/** MAYUSCULAS, sin acentos, sin puntuacion, espacios colapsados. */
export function normalizarTexto(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizarDni(dni) {
  const d = String(dni ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11) return d.slice(2, 10);
  return d.length <= 8 ? d.padStart(8, '0') : d.slice(-8);
}

export function formatearCuit(cuit) {
  const s = String(cuit ?? '').replace(/\D/g, '');
  if (s.length !== 11) return cuit == null || cuit === '' ? '-' : String(cuit);
  return `${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}`;
}

export function sexoDeCuit(cuit) {
  const pref = String(cuit ?? '').slice(0, 2);
  if (pref === '27') return 'F';
  if (pref === '20' || pref === '23' || pref === '24') return 'M';
  return null;
}

export function personasPorDni(db, dni) {
  const d = normalizarDni(dni);
  if (!d) return [];
  return db.prepare('SELECT * FROM personas WHERE dni = ? ORDER BY ' + ORDEN_CUIT).all(d);
}

export function buscarPorCuit(db, cuit) {
  const c = String(cuit ?? '').replace(/\D/g, '');
  if (c.length !== 11) return null;
  return db.prepare('SELECT * FROM personas WHERE cuit = ?').get(c) ?? null;
}

/** Cantidad de CUITs por DNI, para marcar los ambiguos con asterisco. */
export function cuitsPorDni(db, dnis) {
  const lista = [...new Set((dnis || []).filter(Boolean))];
  if (!lista.length) return new Map();
  const ph = lista.map(() => '?').join(',');
  const filas = db.prepare(`SELECT dni, COUNT(*) n FROM personas WHERE dni IN (${ph}) GROUP BY dni`).all(...lista);
  return new Map(filas.map((f) => [f.dni, f.n]));
}

/**
 * Búsqueda por prefijo en apellido_norm o nombre_norm.
 * Devuelve {filas, haySiguiente}. Pagina de 10 en 10 por defecto.
 */
export function buscarPorPrefijo(db, texto, offset = 0, limit = 10) {
  db.exec('PRAGMA case_sensitive_like = ON');
  const prefijo = normalizarTexto(texto);
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Number(limit) || 10);
  if (!prefijo) return { filas: [], haySiguiente: false, prefijo: '' };

  const like = prefijo + '%';
  /* Se traen hasta TOPE de cada indice y se pagina sobre una lista estable.
   * Con un limite variable por pagina, las paginas podian solaparse. */
  const TOPE = 1000;
  const porApellido = db.prepare(
    `SELECT cuit, dni, apellido, nombre, apellido_norm, nombre_norm
     FROM personas WHERE apellido_norm LIKE ?
     ORDER BY apellido_norm, nombre_norm, cuit LIMIT ?`
  ).all(like, TOPE);
  const porNombre = db.prepare(
    `SELECT cuit, dni, apellido, nombre, apellido_norm, nombre_norm
     FROM personas WHERE nombre_norm LIKE ?
     ORDER BY nombre_norm, apellido_norm, cuit LIMIT ?`
  ).all(like, TOPE);

  /* Merge de las dos ramas por CUIT y orden determinista. */
  const mapa = new Map();
  for (const f of [...porApellido, ...porNombre]) mapa.set(f.cuit, f);
  const todas = [...mapa.values()].sort((a, b) => {
    const aa = a.apellido_norm || '';
    const bb = b.apellido_norm || '';
    if (aa !== bb) return aa < bb ? -1 : 1;
    const na = a.nombre_norm || '';
    const nb = b.nombre_norm || '';
    if (na !== nb) return na < nb ? -1 : 1;
    return a.cuit < b.cuit ? -1 : a.cuit > b.cuit ? 1 : 0;
  });

  return {
    filas: todas.slice(off, off + lim),
    haySiguiente: todas.length > off + lim,
    prefijo,
  };
}

/** DNIs con mas de un CUIT, paginados. */
export function ambiguedades(db, offset = 0, limit = 10) {
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Number(limit) || 10);
  const dnis = db.prepare(
    `SELECT dni FROM personas GROUP BY dni HAVING COUNT(*) > 1
     ORDER BY dni LIMIT ? OFFSET ?`
  ).all(lim + 1, off);

  const haySiguiente = dnis.length > lim;
  const pagina = dnis.slice(0, lim);
  const consulta = db.prepare(
    `SELECT cuit, apellido, nombre FROM personas WHERE dni = ?
     ORDER BY CASE substr(cuit,1,2) WHEN '20' THEN 0 WHEN '27' THEN 1 WHEN '23' THEN 2 WHEN '24' THEN 3 ELSE 4 END, cuit`
  );
  return {
    filas: pagina.map(({ dni }) => ({ dni, personas: consulta.all(dni) })),
    haySiguiente,
  };
}

/** Datos basicos de un DNI, solo con lo que hay en el padron. */
export function basico(db, dni) {
  const d = normalizarDni(dni);
  if (!d) return null;
  const filas = personasPorDni(db, d);
  const p = filas[0] ?? null;
  return {
    dni: d,
    apellido: p?.apellido ?? null,
    nombre: p?.nombre ?? null,
    cuit: p?.cuit ?? null,
    cuil: p?.cuit ?? null,
    sexo: p ? sexoDeCuit(p.cuit) : null,
    nacionalidad: p ? 'ARGENTINA' : null,
    ambiguo: filas.length > 1,
    filas,
  };
}
