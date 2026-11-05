import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const P = '/Volumes/Boveda/resolver/bot/telegram.js';
let s = fs.readFileSync(P, 'utf8');

if (s.includes('dniAlAzarPadron')) { console.log('ya estaba'); process.exit(0); }

const ancla = '      const dni = afip ? randomAfip(db) : (elegirDelPool(db) || randomAfip(db));';
if (s.split(ancla).length - 1 !== 1) { console.log('ABORTO: no encontre el ancla del /random'); process.exit(1); }

s = s.replace(ancla, '      const dni = afip ? dniAlAzarPadron(db) : (dniAlAzarPool(db) || dniAlAzarPadron(db));');

s = s + '\n' + [
  '/* === random firme === */',
  'let _colDni = null, _colListo = false;',
  'function colDni(db) {',
  '  if (_colListo) return _colDni;',
  '  _colListo = true;',
  '  try {',
  '    const cols = db.prepare("PRAGMA table_info(personas)").all().map((c) => String(c.name));',
  '    for (const k of ["dni", "DNI", "documento", "doc", "nro_doc", "nrodoc"]) { if (cols.indexOf(k) >= 0) { _colDni = k; break; } }',
  '  } catch (e) {}',
  '  return _colDni;',
  '}',
  '',
  'function dniAlAzarPadron(db) {',
  '  try {',
  '    const col = colDni(db) || "dni";',
  '    let max = 0;',
  '    try { const m = db.prepare("SELECT MAX(rowid) AS m FROM personas").get(); max = Number(m && m.m) || 0; } catch (e) {}',
  '    if (max > 0) {',
  '      for (let k = 0; k < 10; k++) {',
  '        const r = 1 + Math.floor(Math.random() * max);',
  '        const row = db.prepare("SELECT " + col + " AS d FROM personas WHERE rowid >= ? AND " + col + " IS NOT NULL ORDER BY rowid LIMIT 1").get(r);',
  '        if (row && row.d) return row.d;',
  '      }',
  '    }',
  '    const row2 = db.prepare("SELECT " + col + " AS d FROM personas WHERE " + col + " IS NOT NULL ORDER BY RANDOM() LIMIT 1").get();',
  '    return row2 ? row2.d : null;',
  '  } catch (e) { return null; }',
  '}',
  '',
  'function dniAlAzarPool(db) {',
  '  try {',
  '    const c = db.prepare("SELECT COUNT(*) AS n FROM pool_random").get();',
  '    if (!c || Number(c.n) < 2) return null;',
  '    const row = db.prepare("SELECT * FROM pool_random ORDER BY RANDOM() LIMIT 1").get();',
  '    if (!row) return null;',
  '    for (const k of ["dni", "DNI", "documento", "doc"]) { if (row[k] != null && String(row[k]).trim()) return row[k]; }',
  '    for (const v of Object.values(row)) { const t = String(v == null ? "" : v).trim(); if (/^[0-9]{7,8}$/.test(t)) return t; }',
  '    return null;',
  '  } catch (e) { return null; }',
  '}',
  '/* === fin random firme === */',
].join('\n') + '\n';

fs.copyFileSync(P, P + '.bak-random');
fs.writeFileSync(P, s);
console.log('random parcheado');

try { execFileSync('node', ['--check', P], { stdio: 'inherit' }); console.log('node --check: OK'); }
catch (e) { console.log('node --check: FALLO'); process.exit(1); }
