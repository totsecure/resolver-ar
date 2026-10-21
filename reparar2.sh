#!/usr/bin/env bash
# reparar2.sh — diagnostica el error real de carga de cada modulo e inyecta lo que el paste se comio.
set -uo pipefail
cd "${RESOLVER_DIR:-$HOME/resolver}"

chk() { # $1 archivo  $2 export
  node -e "try{const m=require('./$1');if(typeof m['$2']!=='function'){console.log('no exporta $2');process.exit(1)}}catch(e){console.log(e.message);process.exit(1)}" 2>&1
}

echo "== Estado real de los 4 modulos =="
for par in "lib/faker-ar.js generarMail" "lib/cne.js asegurar" "lib/cobertura.js lineaCobertura" "lib/enriquecer.js enriquecerPersona"; do
  set -- $par
  printf '  %-22s ' "$1"
  if chk "$1" "$2" >/dev/null 2>&1; then echo "OK"; else echo "ROTO -> $(chk "$1" "$2")"; fi
done

echo
echo "== Inyeccion en lib/faker-ar.js =="
cp lib/faker-ar.js "lib/faker-ar.js.roto2.$(date +%s)" 2>/dev/null || true
cat > /tmp/rep_faker.js <<'JS'
const fs = require('fs');
const p = 'lib/faker-ar.js';
let s = fs.readFileSync(p, 'utf8');
let tocado = false;

function insertar(texto, bloque) {
  const m = texto.match(/^(['"]use strict['"];?[ \t]*\n)/m);
  return m ? texto.replace(m[0], m[0] + bloque) : bloque + texto;
}

if (!/\blet faker\b/.test(s)) {
  s = insertar(s, "let faker = null;\ntry { ({ fakerES: faker } = require('@faker-js/faker')); } catch (_) { faker = null; }\n");
  tocado = true; console.log('  + bloque faker / require(@faker-js/faker)');
}
if (!/\bVERSION\s*=/.test(s)) {
  s = insertar(s, "const VERSION = '1.0.0';\n");
  tocado = true; console.log('  + VERSION');
}
if (!/\bfunction fnv1a\b/.test(s)) {
  s += "\nfunction fnv1a(t){let h=0x811c9dc5;const x=String(t);for(let i=0;i<x.length;i++){h^=x.charCodeAt(i);h=Math.imul(h,0x01000193);}return h>>>0;}\n";
  tocado = true; console.log('  + fnv1a');
}
if (!/^module\.exports/m.test(s)) {
  s += "\nmodule.exports = { VERSION, fnv1a, generarMail, generarTelefono, generarSinteticos, fakerDisponible: Boolean(faker) };\n";
  tocado = true; console.log('  + module.exports');
}
if (tocado) { fs.writeFileSync(p, s); console.log('  archivo actualizado'); }
else { console.log('  no habia nada de eso faltando'); }
JS
node /tmp/rep_faker.js

echo
echo "== Prueba funcional de cada modulo =="
node -e "const f=require('./lib/faker-ar.js');console.log('  mail:', f.generarMail('3348',{nombre:'JUAN',apellido:'PEREZ'}).valor);console.log('  tel :', f.generarTelefono('3348',{provincia:'CORDOBA'}).valor)" 2>&1 | sed 's/^/  /'
node -e "const c=require('./lib/cne.js');c.asegurar();console.log('  cne ok:', JSON.stringify(c.obtenerSync('3348',{sinRed:true})))" 2>&1 | sed 's/^/  /'
node -e "console.log('  cobertura:', require('./lib/cobertura.js').calcular().personas)" 2>&1 | sed 's/^/  /'
node -e "console.log('  enriquecer:', JSON.stringify(require('./lib/enriquecer.js').enriquecerPersona({dni:'3348',nombre:'JUAN',apellido:'PEREZ'})))" 2>&1 | sed 's/^/  /'

echo
echo "== Resumen =="
todo=1
for par in "lib/faker-ar.js generarMail" "lib/cne.js asegurar" "lib/cobertura.js lineaCobertura" "lib/enriquecer.js enriquecerPersona"; do
  set -- $par
  if chk "$1" "$2" >/dev/null 2>&1; then printf '  OK    %s\n' "$1"; else printf '  ROTO  %-22s %s\n' "$1" "$(chk "$1" "$2")"; todo=0; fi
done
if [ "$todo" -eq 1 ]; then
  echo
  echo "  Todo verde. Ahora corré:   bash arreglo.sh"
else
  echo
  echo "  Queda algo roto: pegame las lineas ROTO de arriba y lo termino de arreglar."
fi