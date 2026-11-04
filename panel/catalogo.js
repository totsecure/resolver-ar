/* Extraído de catalogo.html (CSP script-src 'self'). */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => Number(v || 0).toLocaleString('es-AR');
const monto = (v) => (Number(v) > 0 ? '$ ' + num(v) : 's/precio');
let CSRF = '', SALDO = 0, ITEMS = [], SEL = new Set(), RESERVAS = [], PEDIDOS = [], TIMER = null;

async function api(ruta, cuerpo, metodo) {
  const r = await fetch(ruta, {
    method: metodo || (cuerpo ? 'POST' : 'GET'),
    headers: Object.assign({ 'content-type': 'application/json' }, CSRF ? { 'x-csrf-token': CSRF } : {}),
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return null; }
  return j || {};
}
function decir(sel, t, ok) { const e = $(sel); if (!e) return; e.textContent = t || ''; e.classList.toggle('ok', Boolean(ok)); }
function pintarSaldo() { $('#saldo').textContent = '$ ' + num(SALDO); $('#saldo2').textContent = '$ ' + num(SALDO); }

const COPY = new Map();
let copySeq = 0;
function botonCopiar(texto, etiqueta) {
  const k = 'c' + (++copySeq);
  COPY.set(k, String(texto));
  return '<button class="sec mini" data-copiar="' + k + '">' + esc(etiqueta || 'Copiar') + '</button>';
}
function lineaCc(d) {
  return [d.numero, d.mes, d.anio, d.cvv].filter((x) => x !== null && x !== undefined && x !== '').join('|');
}
function mostrarDatos(items, titulo) {
  const box = $('#datosBox');
  if (!box || !items || !items.length) return;
  $('#datosTitulo').textContent = titulo || 'Datos asignados';
  $('#datosLista').innerHTML = items.map((d) => {
    const titular = [d.titular, d.dni ? 'DNI ' + d.dni : ''].filter(Boolean).join(' · ');
    const extra = [d.direccion, d.ciudad, d.provincia].filter(Boolean).join(', ');
    const contacto = [d.mail, d.telefono].filter(Boolean).join(' · ');
    return '<div class="reserva">'
      + '<div class="linea"><span class="num">' + esc(d.numero) + '</span>'
      + '<span class="badge">' + esc(d.marca || '') + ' ' + esc(d.bin) + '</span>'
      + (d.codigo ? '<span class="badge">#' + esc(d.codigo) + '</span>' : '')
      + '<span class="badge ok">' + esc(d.estado || '') + '</span></div>'
      + '<div class="meta sub" style="margin-top:4px">Vence ' + esc(d.exp) + ' · CVV ' + esc(d.cvv) + ' · ' + monto(d.precio) + '</div>'
      + '<div style="margin-top:6px"><b>' + esc(titular || 'Titular sin datos') + '</b></div>'
      + (d.nro_tramite ? '<div class="meta sub">Trámite ' + esc(d.nro_tramite) + ' · Nac. ' + esc(d.fecha_nac || '-') + '</div>' : '')
      + (extra ? '<div class="meta sub">' + esc(extra) + '</div>' : '')
      + (contacto ? '<div class="meta sub">' + esc(contacto) + '</div>' : '')
      + '<div class="acciones">' + botonCopiar(lineaCc(d), 'Copiar número') + botonCopiar([lineaCc(d), d.titular || '', d.dni || ''].join(' | '), 'Copiar todo') + '</div>'
      + '</div>';
  }).join('');
  box.classList.remove('oculto');
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function opciones(sel, arr, label) {
  const el = $(sel); if (!el) return;
  const act = el.value;
  el.innerHTML = '<option value="">' + label + '</option>' + (arr || []).map((x) => '<option value="' + esc(x.v) + '">' + esc(x.v) + ' (' + x.n + ')</option>').join('');
  if (act) el.value = act;
}

function item(f) {
  const on = SEL.has(f.id);
  return '<div class="item ' + (on ? 'sel' : '') + '">'
    + '<input class="chk" type="checkbox" data-id="' + esc(f.id) + '"' + (on ? ' checked' : '') + '>'
    + '<div class="cuerpo"><div class="num">' + esc(f.numero_mask) + '</div>'
    + '<div class="meta">' + esc(f.bin) + ' · ' + esc(f.banco || '-') + ' · ' + esc(f.marca || '-') + ' · ' + esc(f.exp) + '</div></div>'
    + '<div class="precio">' + monto(f.precio) + '</div></div>';
}

async function cargarCatalogo() {
  const f = { orden: $('#f_orden').value };
  const mapa = [['bins', 'f_bins'], ['bancos', 'f_bancos'], ['marcas', 'f_marcas'], ['pmin', 'f_pmin'], ['pmax', 'f_pmax']];
  for (const [k, id] of mapa) { const v = $(id).value.trim(); if (v) f[k] = v; }
  const q = Object.keys(f).map((k) => k + '=' + encodeURIComponent(f[k])).join('&');
  const j = await api('/api/catalogo?' + q);
  if (!j || !j.ok) { decir('#msgCat', (j && j.error) || 'No pudimos cargar el catálogo.'); return; }
  ITEMS = j.items || [];
  if (j.ventana_min) { const vt = $('#ventanaTxt'); if (vt) vt.textContent = j.ventana_min; }
  SEL.clear();
  if (j.saldo != null) { SALDO = j.saldo; pintarSaldo(); }
  opciones('#f_bancos', j.facetas.bancos, 'Todos');
  opciones('#f_marcas', j.facetas.marcas, 'Todas');
  $('#info').textContent = j.total + ' disponibles';
  $('#lista').innerHTML = ITEMS.length ? ITEMS.map(item).join('') : '<div class="tarjeta"><p class="sub">No hay tarjetas con esos filtros.</p></div>';
  pintarSel();
}
function pintarSel() {
  $('#sel').textContent = SEL.size + ' seleccionadas';
  $('#btnReservar').disabled = SEL.size === 0;
  document.querySelectorAll('.item').forEach((el) => {
    const c = el.querySelector('.chk');
    if (c) el.classList.toggle('sel', c.checked);
  });
}

async function reservar(cuerpo, msgSel) {
  decir(msgSel, 'Reservando...');
  const j = await api('/api/catalogo/reservar', cuerpo);
  if (!j || !j.ok) {
    const map = {
      saldo_insuficiente: 'Saldo insuficiente. Cargá saldo para reservar.',
      sin_stock: 'Ya no hay stock suficiente: otro vendedor se adelantó.',
      sin_precio: 'Esas tarjetas no tienen precio asignado. Mirá tu precio con /precio en el bot o pedile al admin que te lo cargue.',
      limite_simultaneas: j && j.detalle,
      limite_diario: j && j.detalle,
      csrf: 'Recargá la página.',
    };
    decir(msgSel, map[j && j.error] || (j && j.error) || 'No se pudo reservar.');
    return false;
  }
  SALDO = j.saldo;
  pintarSaldo();
  decir(msgSel, 'Reservadas ' + j.cantidad + ' · total $ ' + num(j.total) + ' · grupo ' + j.grupo + ' · vence ' + fecha(j.expira), true);
  mostrarDatos(j.items, 'Reserva ' + j.grupo + ' · revisá y pagá antes de que venza');
  await cargarCatalogo();
  await cargarReservas();
  await cargarPedidos();
  await cargarWallet();
  await cargarRecargas();
  return true;
}

function fecha(iso) { return iso ? String(iso).slice(0, 16).replace('T', ' ') : '-'; }
function restante(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'vencida';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

let RECARGA_PENDIENTE = false;
async function cargarReservas() {
  const j = await api('/api/catalogo/mis-reservas?n=50');
  if (!j || !j.ok) return;
  RESERVAS = (j.reservas || []).filter((r) => ['activa', 'pagada', 'ok', 'falla'].includes(r.estado));
  $('#badgeReservas').textContent = RESERVAS.filter((r) => r.estado === 'activa' || r.estado === 'pagada').length;
  if (!RESERVAS.length) { $('#reservas').innerHTML = '<p class="sub">Sin reservas activas.</p>'; return; }
  $('#reservas').innerHTML = RESERVAS.map((r) => {
    const activa = r.estado === 'activa';
    const pagada = r.estado === 'pagada';
    const cls = activa ? 'warn' : (pagada ? '' : (r.estado === 'ok' ? 'ok' : 'bad'));
    const vence = activa || pagada;
    const botones = (activa ? '<button class="sec mini" data-ver-res="' + esc(r.id) + '">Ver datos</button>'
      + ' <button class="mini" data-pagar="' + esc(r.id) + '">Pagar</button>'
      + ' <button class="peligro mini" data-cancelar="' + esc(r.id) + '">Cancelar</button>' : '')
      + (pagada || r.estado === 'ok' || r.estado === 'falla' ? ' <button class="sec mini" data-ver-res="' + esc(r.id) + '">Ver datos</button>' : '')
      + ' <button class="sec mini" data-chk="' + esc(r.id) + '">Verificar</button>';
    return '<div class="reserva"><div class="linea">'
      + '<span class="num">' + esc(r.numero_mask) + '</span>'
      + '<span class="badge ' + cls + '">' + esc(r.estado) + '</span>'
      + (vence ? '<span class="timer" data-vence="' + esc(r.expira) + '">' + restante(r.expira) + '</span>' : '')
      + '<span style="margin-left:auto;font-weight:800">' + monto(r.precio) + '</span></div>'
      + '<div class="meta sub">' + (r.codigo ? '#' + esc(r.codigo) + ' · ' : '') + esc(r.bin) + ' · ' + esc(r.banco || '-') + ' · grupo ' + esc(r.grupo) + (pagada ? ' · auto-OK al vencer la ventana' : '') + '</div>'
      + '<div class="acciones">' + botones + '</div></div>';
  }).join('');
  if (TIMER) clearInterval(TIMER);
  TIMER = setInterval(() => {
    let vencio = false;
    document.querySelectorAll('[data-vence]').forEach((el) => {
      const iso = el.dataset.vence;
      if (!iso) return;
      el.textContent = restante(iso);
      if (new Date(iso).getTime() <= Date.now()) vencio = true;
    });
    if (vencio && !RECARGA_PENDIENTE) {
      RECARGA_PENDIENTE = true;
      setTimeout(() => { RECARGA_PENDIENTE = false; cargarReservas(); cargarCatalogo(); cargarWallet(); }, 3000);
    }
  }, 1000);
}

async function cargarPedidos() {
  const q = new URLSearchParams({ n: '100' });
  const est = $('#ped_estado')?.value; const des = $('#ped_desde')?.value; const has = $('#ped_hasta')?.value;
  if (est) q.set('estado', est);
  if (des) q.set('desde', des + 'T00:00:00.000Z');
  if (has) q.set('hasta', has + 'T23:59:59.999Z');
  const j = await api('/api/pedidos?' + q.toString());
  if (!j || !j.ok) return;
  PEDIDOS = j.pedidos || [];
  if (!PEDIDOS.length) { $('#pedidos').innerHTML = '<p class="sub">Sin pedidos.</p>'; return; }
  $('#pedidos').innerHTML = PEDIDOS.map((p) => {
    const linkP = location.origin + '/p/' + p.codigo;
    const tarjetas = (p.items || []).slice(0, 3).map((t) => {
      const linkC = location.origin + '/c/' + t.token;
      return '<div class="fila"><span class="k">' + esc(t.numero_mask || t.numero) + ' · ' + esc(t.bin || '') + '</span>' + botonCopiar(linkC, 'Copiar link tarjeta') + '</div>';
    }).join('');
    return '<div class="reserva"><div class="linea"><span class="num">' + esc(p.codigo) + '</span>'
      + '<span class="badge ' + (p.estado === 'entregado' || p.estado === 'verificado' ? 'ok' : (p.estado === 'vencido' || p.estado === 'reclamo' ? 'bad' : 'warn')) + '">' + esc(p.estado) + '</span>'
      + '<span style="margin-left:auto;font-weight:800">$ ' + num(p.total) + '</span></div>'
      + '<div class="meta sub">' + esc(fecha(p.creado)) + ' · ' + esc(p.cantidad) + ' CC · grupo ' + esc(p.grupo) + '</div>'
      + '<div class="acciones">' + botonCopiar(linkP, 'Copiar link pedido')
      + ' <a class="sec mini" href="/api/pedidos/' + encodeURIComponent(p.id) + '/comprobante.html">Comprobante</a>'
      + '</div>'
      + (tarjetas ? '<div style="margin-top:6px">' + tarjetas + '</div>' : '')
      + '</div>';
  }).join('');
}

async function cargarWallet() {
  const j = await api('/api/wallet?n=30');
  if (!j || !j.ok) return;
  SALDO = j.saldo; pintarSaldo();
  const movs = j.movimientos || [];
  $('#movs').innerHTML = movs.length ? movs.map((m) =>
    '<div class="fila"><span class="k">' + esc(fecha(m.creado)) + ' · ' + esc(m.tipo) + (m.nota ? ' · ' + esc(m.nota) : '') + '</span>'
    + '<b style="color:' + (m.monto >= 0 ? 'var(--ok)' : 'var(--bad)') + '">' + (m.monto >= 0 ? '+' : '') + num(m.monto) + '</b></div>').join('')
    : '<p class="sub">Sin movimientos.</p>';
}

async function cargarRecargas() {
  const j = await api('/api/recargas?n=10');
  if (!j || !j.ok) return;
  const r = j.recargas || [];
  $('#misRecargas').innerHTML = r.length ? r.map((x) =>
    '<div class="fila"><span class="k">' + esc(fecha(x.creado)) + ' · $ ' + num(x.monto) + '</span>'
    + '<span class="badge ' + (x.estado === 'aprobada' ? 'ok' : (x.estado === 'rechazada' ? 'bad' : 'warn')) + '">' + esc(x.estado) + '</span></div>').join('')
    : '';
}

async function enviarRecarga() {
  const monto = Number($('#r_monto').value);
  if (!Number.isInteger(monto) || monto <= 0) return decir('#msgRec', 'Ingresá un monto entero mayor a 0.');
  const comp = $('#r_comp').value.trim();
  const file = $('#r_file').files[0];
  let archivo = null, nombre = null;
  if (!comp && !file) return decir('#msgRec', 'Adjuntá un comprobante o una referencia.');
  if (file) {
    if (file.size > 2.5 * 1024 * 1024) return decir('#msgRec', 'El archivo supera 2.5 MB.');
    archivo = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
    nombre = file.name;
  }
  $('#btnRecarga').disabled = true;
  const j = await api('/api/recargas', { monto, comprobante: comp, archivo, archivo_nombre: nombre });
  $('#btnRecarga').disabled = false;
  if (!j || !j.ok) return decir('#msgRec', (j && j.error) || 'No pudimos enviar la recarga.');
  decir('#msgRec', 'Recarga enviada. Queda pendiente de revisión.', true);
  $('#r_monto').value = ''; $('#r_comp').value = ''; $('#r_file').value = '';
  cargarRecargas();
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#btnPedidos')) { cargarPedidos(); return; }
  if (e.target.closest('#btnBuscar')) { cargarCatalogo(); return; }
  if (e.target.closest('#btnLimpiar')) {
    ['f_bins', 'f_bancos', 'f_marcas', 'f_pmin', 'f_pmax'].forEach((id) => { $('#' + id).value = ''; });
    cargarCatalogo(); return;
  }
  if (e.target.closest('#btnReservar')) {
    if (!SEL.size) return;
    await reservar({ refs: [...SEL] }, '#msgCat');
    return;
  }
  if (e.target.closest('#btnLote')) {
    const bin = $('#lote_bin').value.trim();
    const cantidad = Number($('#lote_cant').value) || 1;
    if (!bin) return decir('#msgLote', 'Poné un BIN.');
    await reservar({ bin, cantidad }, '#msgLote');
    return;
  }
  if (e.target.closest('#btnRecarga')) { enviarRecarga(); return; }
  const c = e.target.closest('[data-cancelar]');
  if (c) {
    const j = await api('/api/catalogo/cancelar', { id: Number(c.dataset.cancelar) });
    if (!j || !j.ok) decir('#msgRes', (j && j.error) || 'No se pudo cancelar.');
    else decir('#msgRes', 'Cancelada. Se devolvieron $ ' + num(j.devuelto) + ' al saldo.', true);
    await cargarCatalogo(); await cargarReservas(); await cargarWallet();
    return;
  }
  const pg = e.target.closest('[data-pagar]');
  if (pg) {
    const j = await api('/api/catalogo/pagar', { id: Number(pg.dataset.pagar) });
    if (!j || !j.ok) { decir('#msgRes', j && j.error === 'reserva_no_activa' ? 'Esa reserva ya no está activa.' : ((j && j.error) || 'No se pudo pagar.')); return; }
    decir('#msgRes', 'Pago confirmado. Auto-OK al vencer la ventana.', true);
    mostrarDatos(j.items, 'Pago confirmado · ' + j.grupo + ' · auto-OK ' + fecha(j.expira));
    await cargarReservas(); await cargarPedidos(); await cargarCatalogo(); await cargarWallet();
    return;
  }
  const vr = e.target.closest('[data-ver-res]');
  if (vr) {
    const j = await api('/api/catalogo/reserva/' + vr.dataset.verRes + '/datos');
    if (!j || !j.ok) { decir('#msgRes', (j && j.error) || 'No se pudieron traer los datos.'); return; }
    mostrarDatos([j.item], 'Reserva ' + j.reserva.grupo + ' · ' + j.reserva.estado);
    return;
  }
  const ck = e.target.closest('[data-chk]');
  if (ck) {
    const j = await api('/api/catalogo/chk', { reserva_id: Number(ck.dataset.chk) }, 'POST');
    if (!j || !j.ok) { decir('#msgRes', (j && j.error) || 'No se pudo verificar.'); return; }
    decir('#msgRes', 'Checker ' + (j.codigo || '') + ': ' + j.estado + (j.motivo ? ' · ' + j.motivo : ''), true);
    cargarReservas();
    return;
  }
  const cp = e.target.closest('[data-copiar]');
  if (cp) {
    const texto = COPY.get(cp.dataset.copiar) || '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(texto);
      else {
        const ta = document.createElement('textarea');
        ta.value = texto; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      const previo = cp.textContent; cp.textContent = 'Copiado';
      setTimeout(() => { cp.textContent = previo; }, 1500);
    } catch (_) { decir('#msgRes', 'No se pudo copiar. Seleccioná el texto manualmente.'); }
  }
});

document.addEventListener('change', (e) => {
  const c = e.target.closest('.chk[data-id]');
  if (c) {
    const id = Number(c.dataset.id);
    if (c.checked) SEL.add(id); else SEL.delete(id);
    pintarSel();
  }
  if (['f_bancos', 'f_marcas', 'f_orden'].includes(e.target.id)) cargarCatalogo();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && ['f_bins', 'f_pmin', 'f_pmax', 'lote_bin', 'lote_cant'].includes(e.target.id)) {
    if (e.target.id.startsWith('lote_')) $('#btnLote').click(); else cargarCatalogo();
  }
});

(async function iniciar() {
  const yo = await fetch('/api/auth/yo').then((r) => r.ok ? r.json() : null).catch(() => null);
  if (!yo) { location.href = '/login?next=%2Fcatalogo'; return; }
  CSRF = yo.csrf;
  await cargarCatalogo();
  await cargarReservas();
  await cargarPedidos();
  await cargarWallet();
  await cargarRecargas();
})();
