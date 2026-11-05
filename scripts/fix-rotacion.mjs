import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const P = '/Volumes/Boveda/resolver/bot/telegram.js';
let s = fs.readFileSync(P, 'utf8');
const notas = [];

if (s.includes('ultimoRandom')) { console.log('ya estaba'); process.exit(0); }

function ed(etiqueta, ancla, repl) {
  const n = s.split(ancla).length - 1;
  if (n !== 1) throw new Error(etiqueta + ': el ancla aparece ' + n + ' veces');
  s = s.replace(ancla, repl);
  notas.push('+ ' + etiqueta);
}

try {
  ed('memoria del ultimo',
    'let _colDni = null, _colListo = false;',
    'let _colDni = null, _colListo = false;\nlet ultimoRandom = null;');

  ed('padron sin repetir el anterior',
    '        if (row && row.d) return row.d;',
    '        if (row && row.d && String(row.d) !== String(ultimoRandom || "")) { ultimoRandom = row.d; return row.d; }');

  ed('respaldo del padron',
    '    return row2 ? row2.d : null;',
    '    if (row2 && row2.d) ultimoRandom = row2.d;\n    return row2 ? row2.d : null;');

  ed('pool sin repetir el anterior',
    '    const row = db.prepare("SELECT * FROM pool_random ORDER BY RANDOM() LIMIT 1").get();',
    '    const row = db.prepare("SELECT * FROM pool_random WHERE dni <> ? ORDER BY RANDOM() LIMIT 1").get(String(ultimoRandom || ""));');

  ed('pool recuerda el ultimo',
    '    for (const k of ["dni", "DNI", "documento", "doc"]) { if (row[k] != null && String(row[k]).trim()) return row[k]; }',
    '    for (const k of ["dni", "DNI", "documento", "doc"]) { if (row[k] != null && String(row[k]).trim()) { ultimoRandom = row[k]; return row[k]; } }');

  ed('pool respaldo recuerda el ultimo',
    '    for (const v of Object.values(row)) { const t = String(v == null ? "" : v).trim(); if (/^[0-9]{7,8}$/.test(t)) return t; }',
    '    for (const v of Object.values(row)) { const t = String(v == null ? "" : v).trim(); if (/^[0-9]{7,8}$/.test(t)) { ultimoRandom = t; return t; } }');
} catch (e) { console.log('ABORTO: ' + e.message); process.exit(1); }

fs.copyFileSync(P, P + '.bak-rotacion');
fs.writeFileSync(P, s);
console.log('rotacion parcheada');
console.log(notas.join('\n'));

try { execFileSync('node', ['--check', P], { stdio: 'inherit' }); console.log('node --check: OK'); }
catch (e) { console.log('node --check: FALLO'); process.exit(1); }
