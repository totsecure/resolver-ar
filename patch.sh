#!/bin/bash
set -u
cd /Users/bunker/resolver || { echo "No existe /Users/bunker/resolver"; exit 1; }
echo "Carpeta: $(pwd)"

D="_bak/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$D/lib" "$D/panel"
cp lib/panel.js "$D/lib/" && cp server.js "$D/" && cp panel/index.html "$D/panel/"
echo "Backup en $D"

echo
echo "-- limpiando appends anteriores (si los hay) --"
cut_at() {
  local n
  n=$(grep -nF "$2" "$1" | head -1 | cut -d: -f1)
  if [ -n "$n" ] && [ "$n" -gt 1 ]; then
    head -n $((n-1)) "$1" > "$1.tmp" && mv "$1.tmp" "$1"
    echo "   $1: corte en la linea $n"
  else
    echo "   $1: nada que cortar"
  fi
}
cut_at lib/panel.js 'export function movs'
cut_at server.js 'import { movs as panelMovs }'
cut_at panel/index.html 'function sel(){ return Array.from(SEL)'

echo
echo "-- agregando el parche --"
cat >> lib/panel.js <<'EOF'
export function movs(opts = {}) {
  migrar();
  const n = Math.min(500, Math.max(1, Number(opts.n) || 100));
  const filas = base().prepare('SELECT * FROM movs ORDER BY rowid DESC LIMIT ?').all(n);
  const cols = base().prepare('PRAGMA table_info(movs)').all().map((c) => c.name);
  return { cols: cols, movs: filas };
}
EOF

cat >> server.js <<'EOF'
import { movs as panelMovs } from './lib/panel.js';
app.get('/panel/movs', soloLectura, envolver((req) => panelMovs({ n: num(qs(req, 'n', 100), 100) })));
EOF

cat >> panel/index.html <<'EOF'

<script> (function(){ function sel(){ return Array.from(SEL); } function q(o){ return new URLSearchParams(o).toString(); } var barra=document.querySelector('.barra'); if(barra){ if(!document.getElementById('btnReservar')){ var b=document.createElement('span'); b.style.display='flex'; b.style.gap='6px'; b.style.flexWrap='wrap'; b.innerHTML='<button class="sec" id="btnReservar">Reservar</button>' @@'<button class="sec" id="btnDevolver">Devolver</button>' @@'<button class="sec" id="btnBaja">Baja</button>' @@'<button class="sec" id="btnPrecio">Precio</button>' @@'<button class="sec" id="btnEtiqueta">Etiqueta</button>' @@'<button class="sec" id="btnSaldo">Saldo</button>'; barra.insertBefore(b, barra.querySelector('.crecer')); } } async function acc(nombre){ var r=sel(); if(!r.length){ alert('Nada seleccionado'); return; } var j=await api('/accion?'@@q({accion:nombre, refs:r.join(',')})); if(j?.error){ alert('Error: '@@j.error); return; } SEL.clear(); cargar(); } async function porUno(nombre, campos){ var r=sel(); if(!r.length){ alert('Nada seleccionado'); return; } for(var i=0;i<r.length;i@@){ var o={accion:nombre, ref:r[i]}; for(var k in campos) o[k]=campos[k]; await api('/accion?'@@q(o)); } SEL.clear(); cargar(); } document.addEventListener('click', async function(e){ var t=e.target; if(t.id==='btnReservar'){ await acc('reservar'); return; } if(t.id==='btnDevolver'){ await acc('devolver'); return; } if(t.id==='btnBaja'){ await acc('baja'); return; } if(t.id==='btnPrecio'){ var v=prompt('Precio (vacio = sin precio):'); if(v===null) return; await porUno('precioCC',{valor:v}); return; } if(t.id==='btnEtiqueta'){ var v=prompt('Etiqueta:'); if(v===null) return; await porUno('etiqueta',{valor:v}); return; } if(t.id==='btnSaldo'){ var d=prompt('Saldo disponible:'); if(d===null) return; var tt=prompt('Saldo total:')||''; await porUno('saldo',{disp:d,total:tt}); return; } }); var cab=document.querySelector('header'); if(cab){ if(!document.getElementById('btnMovs')){ var bt=document.createElement('button'); bt.className='tab'; bt.id='btnMovs'; bt.textContent='Movimientos'; cab.appendChild(bt); } } var main=document.querySelector('main'); var cont=document.createElement('div'); cont.id='movsbox'; cont.style.display='none'; cont.style.marginTop='14px'; if(main) main.appendChild(cont); document.addEventListener('click', async function(e){ if(e.target.id!=='btnMovs') return; if(cont.style.display!=='none'){ cont.style.display='none'; cont.innerHTML=''; return; } cont.style.display='block'; cont.innerHTML='<div class="vacio">cargando...</div>'; var j=await api('/movs?n=200'); var cols=(j?.cols)||[]; var filas=(j?.movs)||[]; var h='<table><thead><tr>'; for(var i=0;i<cols.length;i@@) h@@='<th>'@@cols[i]@@'</th>'; h@@='</tr></thead><tbody>'; for(var f=0;f<filas.length;f@@){ h@@='<tr>'; for(var c=0;c<cols.length;c@@){ var val=filas[f][cols[c]]; h@@='<td>'@@String(val==null?'':val)@@'</td>'; } h@@='</tr>'; } h@@='</tbody></table>'; cont.innerHTML=h; }); })(); </script>
EOF

echo
echo "-- reemplazando los @@ por + --"
sed -i '' 's/@@)/++)/g; s/@@/+/g' lib/panel.js server.js panel/index.html
echo "   placeholders restantes: $(grep -c '@@' lib/panel.js) $(grep -c '@@' server.js) $(grep -c '@@' panel/index.html)"

echo
echo "-- verificando sintaxis --"
ok=1
node --check lib/panel.js && echo "   OK lib/panel.js" || ok=0
node --check server.js && echo "   OK server.js" || ok=0
grep -F 'function sel(){ return Array.from(SEL)' panel/index.html | sed 's|^<script> ||; s|</script>$||' > /tmp/patch.js
node --check /tmp/patch.js && echo "   OK bloque JS del panel" || ok=0

echo
if [ "$ok" = "1" ]; then
  echo "-- todo OK: reinicio el server en 8 segundos --"
  nohup sh -c 'sleep 8; bash scripts/server.sh --force' >/tmp/srv.log 2>/dev/null &
else
  echo "!! hubo errores de sintaxis, no reinicio (mira los mensajes de arriba)"
fi
echo "FIN"
