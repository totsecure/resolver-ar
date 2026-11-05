/* tienda.js — vidriera publica: sin sesion, sin dependencias. */
const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
let datos = null;
let bancoSel = null;
let topBancos = [];

const plata = (v) => '$' + nf.format(Number(v) || 0);
const corto = (b) => String(b || '')
  .replace(/^BANCO\s+/i, '')
  .replace(/\s*\(([^)]*)\)\s*$/, (m, dentro) => (/banco/i.test(dentro) ? '' : m))
  .replace(/[,\s]*S\.?\s?A\.?$/i, '')
  .trim();

function pintarChips() {
  const porBanco = {};
  for (const x of datos?.items || []) if (x.banco) porBanco[x.banco] = (porBanco[x.banco] || 0) + x.n;
  topBancos = Object.entries(porBanco).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([b]) => b);
  $('chips').innerHTML = topBancos.length
    ? '<span class="etq">Bancos con más stock</span>' +
      topBancos.map((b, i) => '<button data-i="' + i + '"' + (b === bancoSel ? ' class="on"' : '') + '>' + corto(b) + '</button>').join('')
    : '';
}

function pintar() {
  const f = ($('busca').value || '').trim().toLowerCase();
  const items = (datos?.items || []).filter((x) => (!f || x.bin.includes(f) || String(x.banco || '').toLowerCase().includes(f)) && (!bancoSel || x.banco === bancoSel));
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
  if (bancoSel && !(datos.items || []).some((x) => x.banco === bancoSel)) bancoSel = null;
  pintarChips();
  pintar();
}

$('busca').addEventListener('input', pintar);
$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const elegido = topBancos[Number(b.dataset.i)];
  bancoSel = elegido === bancoSel ? null : elegido;
  pintarChips();
  pintar();
});
$('refrescar').addEventListener('click', cargar);
cargar();
setInterval(cargar, 60000);
