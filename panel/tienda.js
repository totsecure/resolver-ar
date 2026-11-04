/* tienda.js — vidriera publica: sin sesion, sin dependencias. */
const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
let datos = null;

const plata = (v) => '$' + nf.format(Number(v) || 0);

function pintar() {
  const f = ($('busca').value || '').trim().toLowerCase();
  const items = (datos?.items || []).filter((x) => !f || x.bin.includes(f) || String(x.banco || '').toLowerCase().includes(f));
  $('filas').innerHTML = items.length
    ? items.map((x) => '<tr><td class="bin">' + x.bin + '</td><td class="banco">' + (x.banco || '—') + '</td>' +
        '<td class="n">' + x.n + '</td><td>' + (x.saldo_max > 0 ? plata(x.saldo_min) + ' a ' + plata(x.saldo_max) : '—') + '</td></tr>').join('')
    : '<tr><td colspan="4" class="vacio">Sin resultados.</td></tr>';
  $('hora').textContent = 'visto ' + new Date(datos.actualizado).toLocaleTimeString('es-AR');
}

async function cargar() {
  const r = await fetch('/api/tienda');
  datos = await r.json();
  $('tot').textContent = nf.format(datos.total);
  $('bins').textContent = nf.format(datos.bins);
  $('saldo').textContent = plata(Math.max(0, ...datos.items.map((x) => Number(x.saldo_max) || 0)));
  if (datos.bot) $('bot').href = 'https://t.me/' + datos.bot;
  pintar();
}

$('busca').addEventListener('input', pintar);
$('refrescar').addEventListener('click', cargar);
cargar();
setInterval(cargar, 60000);
