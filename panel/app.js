/* app.js — logica del panel RESOLVER STORE. Un solo archivo, sin scripts apilados. */
(function () {
  'use strict';

  /* ---------- estilos propios ---------- */
  var CSS = `
#cargarBox{display:none}
#cargarBox textarea{width:100%;min-height:150px;background:var(--bg);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:9px;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
#cc_preview{margin-top:12px}
#cc_preview table{font-size:12px}
tr.cc-ok td:first-child{border-left:4px solid var(--ok)}
tr.cc-dup td:first-child{border-left:4px solid var(--warn)}
tr.cc-bad td:first-child{border-left:4px solid var(--bad)}
.cc-resumen{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0;color:var(--dim)}
.cc-resumen b{color:var(--txt)}
.cc-link{display:inline-block;margin-top:8px;color:rgb(147,197,253)}
#barraAcciones{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
#sinPrecio{margin:10px 0;padding:10px 12px;border:1px solid var(--warn);border-radius:10px;background:rgba(245,158,11,.10);font-size:13px;display:none}
#dashBox{margin-top:14px;display:none}
#dashBox .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
#dashBox .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;color:var(--dim);font-size:12px}
#dashBox .card b{display:block;font-size:20px;margin-top:4px;color:var(--txt)}
#revBanner{display:none;margin:10px 0;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--panel2);font-size:13px;line-height:1.5}
#atajos{color:var(--dim);font-size:11.5px;margin-top:10px}
@media (max-width:860px){
  header{gap:8px}
  .kpis{width:100%;margin-left:0;gap:10px}
  .tab{padding:6px 9px;font-size:12px}
  .filtros{grid-template-columns:repeat(auto-fit,minmax(132px,1fr))}
  main{padding:10px 10px 70px}
  table{display:block;overflow-x:auto;white-space:nowrap}
  .barra{flex-wrap:wrap}
  .barra .crecer{margin-left:0}
  #barraAcciones button{font-size:12px;padding:7px 10px}
}
`;
  var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  /* ---------- helpers ---------- */
  var Q = new URLSearchParams(location.search);
  var TOKEN = Q.get('token') || localStorage.getItem('tok') || '';
  if (TOKEN) localStorage.setItem('tok', TOKEN);
  var SERVICIO = Q.get('token') || '';
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var num = function (v) { return Number(v || 0).toLocaleString('es-AR'); };
  var txt = function (id) { var e = $('#' + id); return e ? String(e.value || '').trim() : ''; };
  var qq = function (o) { return new URLSearchParams(o).toString(); };

  /* ---------- estado ---------- */
  var ESTADO = 'DISPONIBLE', PAGINA = 1, POR = 50, SEL = new Set(), DATOS = null, DASH = false, ACC = null;
  var HIST = [], TODO_FILTRO = false;
  var CSRF = sessionStorage.getItem('csrf') || '';
  var CSRF_LISTO = (async function () {
    if (SERVICIO) return;
    try {
      var r = await fetch('/api/auth/yo');
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return; }
      var j = await r.json();
      if (j && j.csrf) { CSRF = j.csrf; sessionStorage.setItem('csrf', CSRF); }
    } catch (_) {}
  })();
  async function api(ruta, opts) {
    opts = opts || {};
    await CSRF_LISTO;
    var sep = ruta.indexOf('?') >= 0 ? '&' : '?';
    var headers = Object.assign({}, opts.headers || {});
    if (CSRF) headers['x-csrf-token'] = CSRF;
    opts = Object.assign({}, opts, { headers: headers });
    var r = await fetch('/panel' + ruta + sep + 'token=' + encodeURIComponent(TOKEN), opts);
    if (r.status === 401 && !SERVICIO) location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    return r.json();
  }

  /* ---------- filtros ---------- */
  function filtros() {
    var f = { estado: txt('f_estado') || ESTADO, pagina: PAGINA, por: POR };
    var m = [['bins','f_bins'],['bin_desde','f_bin_desde'],['bin_hasta','f_bin_hasta'],['paises','f_paises'],['bancos','f_bancos'],['redes','f_redes'],['tipos','f_tipos'],['etiquetas','f_etiquetas'],['saldo_min','f_saldmin'],['saldo_max','f_saldmax'],['pmin','f_pmin'],['pmax','f_pmax'],['q','f_q']];
    for (var i = 0; i < m.length; i++) { var v = txt(m[i][1]); if (v) f[m[i][0]] = v; }
    if ($('#f_saldeadas') && $('#f_saldeadas').checked) f.saldeadas = '1';
    return f;
  }

  function pintarKpis(k) {
    var c = $('#kpis'); if (!c) return;
    var it = [['Disponibles', k.disponible], ['Vendidas', k.vendidas], ['Saldo', num(k.saldoTotal)], ['Sin precio', k.sinPrecio]];
    if (DASH) { it.push(['Ventas', k.ventas == null ? '-' : k.ventas], ['Alertas', (k.alertas || []).length]); var pe = k.porEstado || {}; Object.keys(pe).forEach(function (e) { it.push([e, pe[e]]); }); }
    c.innerHTML = it.map(function (x) { return '<span>' + esc(x[0]) + ' <b>' + esc(x[1]) + '</b></span>'; }).join('');
  }
  function pintarFacetas(fac) {
    var llenar = function (id, arr, label) {
      var el = $('#' + id); if (!el) return;
      var act = el.value;
      el.innerHTML = '<option value="">' + label + '</option>' + (arr || []).map(function (v) { return '<option value="' + esc(v.v) + '">' + esc(v.v) + ' (' + v.n + ')</option>'; }).join('');
      if (act) el.value = act;
    };
    llenar('f_paises', fac.paises, 'Todos');
    llenar('f_bancos', fac.bancos, 'Todos');
    llenar('f_redes', fac.redes, 'Todas');
    llenar('f_tipos', fac.tipos, 'Todos');
    llenar('f_etiquetas', fac.etiquetas, 'Todas');
    var pr = fac.precios || {};
    if ($('#f_pmin') && !$('#f_pmin').value && pr.min != null) $('#f_pmin').placeholder = pr.min;
    if ($('#f_pmax') && !$('#f_pmax').value && pr.max != null) $('#f_pmax').placeholder = pr.max;
  }
  function iconos(ft) {
    var d = [['holder','T'],['address','D'],['zip','Z'],['phone','P'],['email','E']];
    return '<span class="icons">' + d.map(function (x) { return '<span class="' + (ft[x[0]] ? 'si' : '') + '">' + x[1] + '</span>'; }).join('') + '</span>';
  }

  /* ---------- tabla (seleccion por ID) ---------- */
  function fila(f) {
    var on = SEL.has(String(f.id)) ? ' class="sel"' : '';
    var m = String(f.marca || '').toLowerCase();
    var cls = m.indexOf('visa') >= 0 ? 'visa' : (m.indexOf('master') >= 0 ? 'master' : '');
    var falta = f.sin_precio ? ' style="color:var(--warn)"' : '';
    return '<tr' + on + '>'
      + '<td><input type="checkbox" data-id="' + esc(f.id) + '"' + (SEL.has(String(f.id)) ? ' checked' : '') + '></td>'
      + '<td><div class="bin mono">' + esc(f.bin) + '</div><div class="sub">' + esc(f.banco || '-') + '</div></td>'
      + '<td><span class="badge ' + cls + '">' + esc(f.marca || '-') + '</span></td>'
      + '<td>' + esc(f.tipo || '-') + '</td>'
      + '<td class="mono">' + esc(f.exp || '') + '</td>'
      + '<td>' + esc(f.pais || '-') + '</td>'
      + '<td class="mono">' + esc(f.zip || '-') + '</td>'
      + '<td>' + iconos(f.features || {}) + '</td>'
      + '<td>' + esc(f.etiqueta || '-') + '</td>'
      + '<td>' + (f.refund ? 'SI' : 'NO') + '</td>'
      + '<td class="mono">' + esc(f.saldo || '-') + '</td>'
      + '<td class="precio"' + falta + '>' + (f.precio == null ? '-' : esc(num(f.precio))) + '</td>'
      + '<td class="precio"' + falta + '>' + esc(f.precio_cuotas == null ? '-' : num(f.precio_cuotas)) + '</td>'
      + '<td><button class="sec" data-ver="' + esc(f.id) + '">ver</button> <button class="sec" data-pedir-id="' + esc(f.id) + '" data-pedir-bin="' + esc(f.bin) + '">Pedir</button></td>'
      + '</tr>';
  }
  function pintarTabla() {
    var t = $('#cuerpo'); if (!t) return;
    if (!DATOS || !DATOS.filas.length) t.innerHTML = '<tr><td colspan="14" class="vacio">Sin resultados</td></tr>';
    else t.innerHTML = DATOS.filas.map(fila).join('');
    var s = $('#sel'); if (s) s.textContent = SEL.size + ' seleccionadas' + (TODO_FILTRO ? ' (todo el filtro)' : '');
    var b = $('#btnComprar'); if (b) b.disabled = !SEL.size;
    var i = $('#info'); if (i && DATOS) i.textContent = DATOS.total + ' resultados - pag ' + DATOS.pagina;
    var ct = $('#chkTodos');
    if (ct && DATOS) ct.checked = DATOS.filas.length > 0 && DATOS.filas.every(function (f) { return SEL.has(String(f.id)); });
  }
  function pintarPag(d) {
    var p = $('#pag'); if (!p) return;
    var pg = Math.max(1, Math.ceil((d.total || 0) / (d.por || POR)));
    p.innerHTML = '<button class="sec" data-pag="' + (d.pagina - 1) + '"' + (d.pagina <= 1 ? ' disabled' : '') + '>&lt;</button>'
      + '<span>' + d.pagina + ' / ' + pg + '</span>'
      + '<button class="sec" data-pag="' + (d.pagina + 1) + '"' + (d.pagina >= pg ? ' disabled' : '') + '>&gt;</button>';
  }
  async function cargar() {
    var f = filtros();
    var qs = Object.keys(f).map(function (k) { return k + '=' + encodeURIComponent(f[k]); }).join('&');
    var d;
    try { d = await api('/datos?' + qs); } catch (e) { var i = $('#info'); if (i) i.textContent = 'error de red'; return; }
    if (d.error) { var i2 = $('#info'); if (i2) i2.textContent = d.error; return; }
    DATOS = d;
    pintarKpis(d.kpis || {});
    pintarFacetas(d.facetas || {});
    pintarTabla();
    pintarPag(d);
    ajustarBotones();
    bannerRevision();
    bannerSinPrecio();
    if ($('#dashBox') && $('#dashBox').style.display !== 'none') dashboard();
  }
  var FILTRO_IDS = ['f_bins','f_bin_desde','f_bin_hasta','f_pmin','f_pmax','f_q','f_paises','f_bancos','f_redes','f_tipos','f_etiquetas','f_saldmin','f_saldmax','f_saldeadas','f_estado'];
  function limpiar() {
    FILTRO_IDS.forEach(function (id) { var e = $('#' + id); if (e) { if (e.type === 'checkbox') e.checked = false; else e.value = (id === 'f_estado' ? 'DISPONIBLE' : ''); } });
    ESTADO = 'DISPONIBLE'; PAGINA = 1; SEL.clear(); TODO_FILTRO = false; cargar();
  }

  /* ---------- filtros guardados ---------- */
  function filtrosGuardados() { try { return JSON.parse(localStorage.getItem('resolver_filtros') || '{}') || {}; } catch (_) { return {}; } }
  function refrescarGuardados() {
    var sel = $('#f_guardados'); if (!sel) return; var data = filtrosGuardados(); var act = sel.value;
    sel.innerHTML = '<option value="">—</option>' + Object.keys(data).sort().map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
    if (act) sel.value = act;
  }
  function guardarFiltro() {
    var n = txt('f_nombre'); if (!n) return alert('Pone un nombre para el filtro.');
    var data = filtrosGuardados(); var v = {};
    FILTRO_IDS.forEach(function (id) { var e = $('#' + id); if (!e) return; v[id] = e.type === 'checkbox' ? e.checked : e.value; });
    data[n] = v; localStorage.setItem('resolver_filtros', JSON.stringify(data)); refrescarGuardados(); $('#f_guardados').value = n;
  }
  function cargarFiltro() {
    var n = $('#f_guardados').value; if (!n) return; var v = filtrosGuardados()[n]; if (!v) return;
    FILTRO_IDS.forEach(function (id) { var e = $('#' + id); if (!e || v[id] === undefined) return; if (e.type === 'checkbox') e.checked = !!v[id]; else e.value = v[id]; });
    ESTADO = txt('f_estado') || 'DISPONIBLE'; PAGINA = 1; SEL.clear(); TODO_FILTRO = false; cargar();
  }
  function borrarFiltro() {
    var n = $('#f_guardados').value; if (!n) return; var data = filtrosGuardados(); delete data[n];
    localStorage.setItem('resolver_filtros', JSON.stringify(data)); refrescarGuardados();
  }

  /* ---------- modal ---------- */
  function abrir(t, c) { $('#m_titulo').textContent = t; $('#m_cuerpo').innerHTML = c; $('#m_aviso').textContent = ''; $('#modal').classList.add('abierto'); }
  function cerrar() { $('#modal').classList.remove('abierto'); }

  /* ---------- acciones en lote (por ID) ---------- */
  function ids() { return Array.from(SEL); }
  function registrarUndo(nombre, lista, mapa) {
    var porId = {};
    (DATOS && DATOS.filas || []).forEach(function (f) { porId[String(f.id)] = f; });
    var pares = [];
    for (var k = 0; k < lista.length; k++) {
      var id = lista[k], f = porId[String(id)];
      for (var campo in mapa) {
        var val = mapa[campo](f);
        if (val === undefined) continue;
        pares.push({ id: Number(id), campo: campo, valor: val });
      }
    }
    if (!pares.length) return;
    HIST.push({ nombre: nombre, pares: pares, n: lista.length });
    if (HIST.length > 25) HIST.shift();
    pintarUndo();
  }
  function pintarUndo() {
    var b = $('#btnDeshacer'); if (!b) return;
    var h = HIST[HIST.length - 1];
    b.disabled = !h; b.textContent = h ? 'Deshacer (' + h.nombre + ')' : 'Deshacer';
  }
  async function deshacer() {
    var h = HIST[HIST.length - 1]; if (!h) return;
    HIST.pop(); pintarUndo();
    var j = await api('/accion?' + qq({ accion: 'pares', pares: JSON.stringify(h.pares) }));
    if (j && j.error) { alert('Error: ' + j.error); HIST.push(h); pintarUndo(); }
    cargar();
  }
  async function mutar(nombre, params, undoMapa) {
    var lista = ids(); if (!lista.length) { alert('Nada seleccionado'); return; }
    registrarUndo(nombre, lista, undoMapa || {});
    var o = Object.assign({ accion: nombre, ids: lista.join(',') }, params || {});
    var j = await api('/accion?' + qq(o));
    if (j && j.error) { alert('Error: ' + j.error); HIST.pop(); pintarUndo(); return; }
    SEL.clear(); TODO_FILTRO = false; cargar();
  }
  async function selTodosFiltro() {
    var f = filtros(); f.accion = 'ids';
    var j = await api('/accion?' + qq(f));
    if (!j || j.error) { alert('Error: ' + ((j && j.error) || 'red')); return; }
    SEL = new Set((j.ids || []).map(String)); TODO_FILTRO = true; pintarTabla();
    var s = $('#sel'); if (s) s.textContent = SEL.size + ' seleccionadas (todo el filtro)';
  }
  async function exportar() {
    var f = filtros(); f.accion = 'export';
    var j = await api('/accion?' + qq(f));
    if (!j || j.error) { alert('Error: ' + ((j && j.error) || 'red')); return; }
    var blob = new Blob(['\uFEFF' + j.csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = j.nombre || 'stock.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  async function precioPorBin() {
    var bin = prompt('BIN a preciar (6 digitos):'); if (!bin) return;
    var v1 = prompt('Precio 1 pago para ' + bin + ' (vacio = quitar):'); if (v1 === null) return;
    await api('/accion?' + qq({ accion: 'precioBin', bin: bin, valor: v1 }));
    var v2 = prompt('Precio EN CUOTAS para ' + bin + ' (vacio = quitar):');
    if (v2 !== null && v2 !== '') await api('/accion?' + qq({ accion: 'precioCuotasBin', bin: bin, valor: v2 }));
    cargar();
  }

  /* ---------- banners ---------- */
  function bannerRevision() {
    var main = document.querySelector('main'); if (!main) return;
    var b = $('#revBanner');
    if (!b) { b = document.createElement('div'); b.id = 'revBanner'; main.insertBefore(b, main.firstChild); }
    if (ESTADO !== 'REVISION') { b.style.display = 'none'; return; }
    var n = (DATOS && DATOS.total) || 0;
    b.style.display = 'block';
    b.innerHTML = '<b>' + n + '</b> tarjeta(s) en Revision: todavia NO se venden. Marca las que quieras (o Todo el filtro) y toca Publicar. <button class="prim" id="revPubAll">Publicar todas</button> <button class="sec" id="revPriceBin">Precio por BIN</button>';
  }
  function bannerSinPrecio() {
    var main = document.querySelector('main'); if (!main) return;
    var b = $('#sinPrecio');
    if (!b) { b = document.createElement('div'); b.id = 'sinPrecio'; main.insertBefore(b, main.firstChild); }
    var n = (DATOS && DATOS.kpis && DATOS.kpis.sinPrecio) || 0;
    if (ESTADO === 'DISPONIBLE' && n > 0) {
      b.style.display = 'block';
      b.innerHTML = '<b>' + n + '</b> publicada(s) SIN PRECIO: no salen en Market ni en el bot. <button class="sec" id="spPrecioBin">Preciar por BIN</button> <button class="sec" id="spVer">Ver sin precio</button>';
    } else b.style.display = 'none';
  }
  function ajustarBotones() {
    var cb = $('#btnComprar'); if (cb) cb.textContent = (ESTADO === 'REVISION') ? 'Publicar seleccionadas' : 'Vender seleccionadas';
    var bb = $('#btnBorrar'); if (bb) bb.textContent = (ESTADO === 'PAPELERA') ? 'Borrar definitivo' : 'A papelera';
    var pr = $('#btnPublicar'); if (pr) pr.style.display = (ESTADO === 'REVISION') ? '' : 'none';
    var rs = $('#btnRestaurar'); if (rs) rs.style.display = (ESTADO === 'PAPELERA') ? '' : 'none';
    var rv = $('#btnReservar'); if (rv) rv.style.display = (ESTADO === 'DISPONIBLE') ? '' : 'none';
  }

  /* ---------- dashboard ---------- */
  function dashboard() {
    var main = document.querySelector('main'); if (!main) return;
    var box = $('#dashBox');
    if (!box) { box = document.createElement('div'); box.id = 'dashBox'; main.appendChild(box); }
    box.style.display = 'block';
    var k = (DATOS && DATOS.kpis) || {};
    var pe = k.porEstado || {};
    var estados = Object.keys(pe).map(function (e) { return '<div class="card">' + esc(e) + '<b>' + esc(pe[e]) + '</b></div>'; }).join('');
    var bins = ((DATOS && DATOS.facetas && DATOS.facetas.bins) || []).slice(0, 12).map(function (b) {
      return '<tr><td class="mono">' + esc(b.v) + '</td><td>' + esc(b.banco || '-') + '</td><td>' + esc(b.n) + '</td></tr>';
    }).join('');
    box.innerHTML = '<div class="grid">'
      + '<div class="card">Disponibles<b>' + esc(k.disponible || 0) + '</b></div>'
      + '<div class="card">Vendidas<b>' + esc(k.vendidas || 0) + '</b></div>'
      + '<div class="card">Saldo total<b>' + esc(num(k.saldoTotal)) + '</b></div>'
      + '<div class="card">Ventas<b>' + esc(k.ventas || 0) + '</b></div>'
      + '<div class="card">Sin precio<b>' + esc(k.sinPrecio || 0) + '</b></div>'
      + '<div class="card">Alertas<b>' + esc((k.alertas || []).length) + '</b></div>'
      + estados + '</div>'
      + (bins ? '<h3 style="margin:16px 0 6px">Top BIN</h3><table><thead><tr><th>BIN</th><th>Banco</th><th>CC</th></tr></thead><tbody>' + bins + '</tbody></table>' : '');
  }

  /* ---------- vender / pedir / ver ---------- */
  function comprar() {
    var lista = ids(); if (!lista.length) return;
    abrir('Vender ' + lista.length + ' CC', '<label>Comprador</label><input id="m_comprador" placeholder="opcional">');
    $('#m_ok').textContent = 'Confirmar';
    ACC = async function () {
      var c = $('#m_comprador') ? $('#m_comprador').value.trim() : '';
      $('#m_aviso').textContent = 'procesando...';
      var r = await api('/comprar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: lista.join(','), comprador: c }) });
      if (r.error) { $('#m_aviso').textContent = 'error: ' + r.error; return; }
      $('#m_aviso').textContent = 'Venta ' + r.codigo + ' - ' + r.n + ' CC enviada al bot';
      SEL.clear(); TODO_FILTRO = false; cargar();
    };
  }
  async function pedir(lista, filtro) {
    var q = (lista && lista.length) ? 'ids=' + lista.join(',') : 'filtro=' + encodeURIComponent(filtro || 'base');
    var j = await api('/pedido?' + q);
    if (!j || j.error) { alert('Error: ' + ((j && j.error) || 'sin stock')); return; }
    var texto = esc(j.texto || '');
    abrir('Pedir', '<pre id="m_pedido" style="white-space:pre-wrap;font:12.5px/1.45 ui-monospace,Menlo,monospace;max-height:55vh;overflow:auto;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px">' + texto + '</pre><div style="margin-top:8px"><button class="sec" id="m_copiar">Copiar</button></div>');
    $('#m_ok').textContent = 'Cerrar'; ACC = cerrar;
  }
  function ver(id) {
    var f = (DATOS && DATOS.filas || []).find(function (x) { return String(x.id) === String(id); }); if (!f) return;
    abrir('CC ' + f.ref, '<div class="mono">' + esc(f.numero || '') + '</div><div class="sub">' + esc(f.banco || '-') + ' - ' + esc(f.marca || '-') + ' - exp ' + esc(f.exp || '') + '</div><div class="sub">saldo ' + esc(f.saldo || '-') + ' - zip ' + esc(f.zip || '-') + ' - titular ' + (f.features.holder ? 'si' : 'no') + '</div>');
    $('#m_ok').textContent = 'Cerrar'; ACC = cerrar;
  }

  /* ---------- barra de acciones ---------- */
  function barraAcciones() {
    var barra = document.querySelector('.barra'); if (!barra || $('#barraAcciones')) return;
    var b = document.createElement('span'); b.id = 'barraAcciones';
    b.innerHTML = '<button class="sec" id="btnReservar">Reservar</button>'
      + '<button class="sec" id="btnPublicar">Publicar</button>'
      + '<button class="sec" id="btnDevolver">Devolver</button>'
      + '<button class="sec" id="btnBaja">Baja</button>'
      + '<button class="sec" id="btnPrecio">1 pago</button>'
      + '<button class="sec" id="btnPrecioCuotas">En cuotas</button>'
      + '<button class="sec" id="btnPrecioCuotasBin">Cuotas por BIN</button>'
      + '<button class="sec" id="btnEtiqueta">Etiqueta/Base</button>'
      + '<button class="sec" id="btnSaldo">Saldo</button>'
      + '<button class="sec" id="btnEstado">Estado</button>'
      + '<button class="sec" id="btnBorrar">A papelera</button>'
      + '<button class="sec" id="btnRestaurar">Restaurar</button>'
      + '<button class="sec" id="btnCSV">CSV</button>'
      + '<button class="sec" id="btnDeshacer" disabled>Deshacer</button>';
    barra.insertBefore(b, barra.querySelector('.crecer'));
    var main = document.querySelector('main');
    if (main && !$('#atajos')) {
      var h = document.createElement('div'); h.id = 'atajos';
      h.innerHTML = 'Atajos: <b>/</b> buscar &middot; <b>a</b> pagina &middot; <b>A</b> todo el filtro &middot; <b>d</b> deshacer &middot; <b>e</b> CSV &middot; <b>n/p</b> pag &middot; <b>Esc</b> limpiar';
      main.appendChild(h);
    }
  }

  /* ---------- clicks ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target;
    var tab = t.closest('.tab[data-estado]');
    if (tab) { Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.remove('on'); }); tab.classList.add('on'); ESTADO = tab.dataset.estado; var fe = $('#f_estado'); if (fe) fe.value = ESTADO; PAGINA = 1; SEL.clear(); TODO_FILTRO = false; cargar(); return; }
    if (t.closest('#btnDash')) { DASH = !DASH; $('#btnDash').classList.toggle('on', DASH); if (DATOS) pintarKpis(DATOS.kpis || {}); if (DASH) dashboard(); else if ($('#dashBox')) $('#dashBox').style.display = 'none'; return; }
    var p = t.closest('[data-pag]'); if (p && !p.disabled) { PAGINA = Number(p.dataset.pag); cargar(); return; }
    var v = t.closest('[data-ver]'); if (v) { ver(v.dataset.ver); return; }
    var pd = t.closest('[data-pedir-id]'); if (pd) { pedir(null, pd.dataset.pedirBin); return; }
    if (t.closest('#btnPedirSel')) { var l = ids(); if (!l.length) { alert('Nada seleccionado'); return; } pedir(l); return; }
    if (t.closest('#btnSelTodos')) { selTodosFiltro(); return; }
    if (t.closest('#btnCSV')) { exportar(); return; }
    if (t.closest('#btnDeshacer')) { deshacer(); return; }
    if (t.closest('#btnBuscar')) { PAGINA = 1; cargar(); return; }
    if (t.closest('#btnGuardarFiltro')) { guardarFiltro(); return; }
    if (t.closest('#btnCargarFiltro')) { cargarFiltro(); return; }
    if (t.closest('#btnBorrarFiltro')) { borrarFiltro(); return; }
    if (t.closest('#m_copiar')) { var t2 = $('#m_pedido') ? $('#m_pedido').textContent : ''; if (navigator.clipboard) navigator.clipboard.writeText(t2).then(function () { var b = $('#m_copiar'); if (b) b.textContent = 'Copiado'; }); return; }
    if (t.closest('#btnLimpiar')) { limpiar(); return; }
    if (t.closest('#btnComprar')) {
      if (ESTADO === 'REVISION') { if (!SEL.size) { alert('Nada seleccionado'); return; } mutar('publicar', {}, { estado: function () { return 'REVISION'; } }); return; }
      comprar(); return;
    }
    if (t.closest('#revPubAll')) { selTodosFiltro().then(function () { setTimeout(function () { mutar('publicar', {}, { estado: function () { return 'REVISION'; } }); }, 80); }); return; }
    if (t.closest('#revPriceBin') || t.closest('#spPrecioBin')) { precioPorBin(); return; }
    if (t.closest('#spVer')) { var fp = $('#f_pmax'); if (fp) fp.value = '0'; ESTADO = 'DISPONIBLE'; var fe2 = $('#f_estado'); if (fe2) fe2.value = 'DISPONIBLE'; PAGINA = 1; cargar(); return; }
    if (t.closest('#m_cancelar')) { cerrar(); return; }
    if (t.closest('#m_ok')) { if (ACC) ACC(); return; }

    if (t.id === 'btnReservar') { mutar('reservar', {}, { estado: function () { return 'DISPONIBLE'; }, reserva_vence: function () { return null; }, reservado_por: function () { return null; } }); return; }
    if (t.id === 'btnPublicar') { mutar('publicar', {}, { estado: function () { return 'REVISION'; } }); return; }
    if (t.id === 'btnDevolver') { if (!confirm('Devolver ' + ids().length + ' a disponible?')) return; mutar('devolver', {}, { estado: function () { return 'VENDIDA'; } }); return; }
    if (t.id === 'btnBaja') { if (!confirm('Dar de baja ' + ids().length + ' tarjeta(s)?')) return; mutar('baja', {}, { estado: function () { return ESTADO; } }); return; }
    if (t.id === 'btnPrecio') { var v1 = prompt('Precio 1 pago (vacio = sin precio):'); if (v1 === null) return; mutar('precioCC', { valor: v1 }, { precio_num: function (f) { return f ? f.precio_num : null; } }); return; }
    if (t.id === 'btnPrecioCuotas') { var v2 = prompt('Precio en cuotas (vacio = sin cuotas):'); if (v2 === null) return; mutar('precioCuotas', { valor: v2 }, { precio_cuotas: function (f) { return f ? f.precio_cuotas : null; } }); return; }
    if (t.id === 'btnPrecioCuotasBin') { precioPorBin(); return; }
    if (t.id === 'btnEtiqueta') { var v3 = prompt('Etiqueta:'); if (v3 === null) return; mutar('etiqueta', { valor: v3 }, { etiqueta: function (f) { return f ? f.etiqueta : null; } }); return; }
    if (t.id === 'btnSaldo') {
      var d1 = prompt('Saldo disponible:'); if (d1 === null) return;
      var t3 = prompt('Saldo ref (vacio = igual al saldo):') || '';
      mutar('saldo', { disp: d1, total: t3 }, { saldo: function (f) { return f ? f.saldo_num : null; }, saldo_ref: function (f) { return f ? f.saldo_ref_num : null; }, saldo_disp_num: function (f) { return f ? f.saldo_num : null; }, saldo_total_num: function (f) { return f ? f.saldo_ref_num : null; } });
      return;
    }
    if (t.id === 'btnEstado') { var est = prompt('Estado (DISPONIBLE, RESERVADA, PAGADA, VENDIDA, BAJA, RECLAMADA, ANULADA, REVISION):'); if (!est || !est.trim()) return; mutar('estado', { valor: est.trim().toUpperCase() }, { estado: function () { return ESTADO; } }); return; }
    if (t.id === 'btnBorrar') {
      var n = ids().length; if (!n) { alert('Nada seleccionado'); return; }
      if (ESTADO === 'PAPELERA') { if (!confirm('Borrar DEFINITIVAMENTE ' + n + ' tarjeta(s)? No se puede deshacer.')) return; mutar('borrarDef', {}, {}); return; }
      if (!confirm('Mover ' + n + ' tarjeta(s) a la papelera?')) return;
      mutar('borrar', {}, { eliminado: function () { return 0; } }); return;
    }
    if (t.id === 'btnRestaurar') { var m2 = ids().length; if (!m2) { alert('Nada seleccionado'); return; } if (!confirm('Restaurar ' + m2 + ' tarjeta(s)?')) return; mutar('restaurar', {}, { eliminado: function () { return 1; } }); return; }
  });

  /* ---------- change ---------- */
  document.addEventListener('change', function (e) {
    var c = e.target.closest('[data-id]');
    if (c) { if (c.checked) SEL.add(c.dataset.id); else SEL.delete(c.dataset.id); pintarTabla(); return; }
    if (e.target.closest('#chkTodos')) {
      var on = e.target.checked;
      (DATOS && DATOS.filas || []).forEach(function (f) { if (on) SEL.add(String(f.id)); else SEL.delete(String(f.id)); });
      TODO_FILTRO = false; pintarTabla(); return;
    }
    if (['f_paises','f_bancos','f_redes','f_tipos','f_etiquetas','f_estado'].indexOf(e.target.id) >= 0) { if (e.target.id === 'f_estado') ESTADO = e.target.value; PAGINA = 1; cargar(); }
    if (e.target.id === 'f_saldeadas') { PAGINA = 1; cargar(); }
  });

  /* ---------- teclado ---------- */
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toUpperCase();
    var enCampo = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    if (e.key === 'Escape') { if ($('#modal').classList.contains('abierto')) cerrar(); else { SEL.clear(); TODO_FILTRO = false; pintarTabla(); } return; }
    if (enCampo) { if (e.key === 'Enter' && (e.target.id === 'f_q' || e.target.id === 'f_bins')) { PAGINA = 1; cargar(); } return; }
    if (e.key === '/') { e.preventDefault(); var fq = $('#f_q'); if (fq) fq.focus(); return; }
    if (e.key === 'a') { (DATOS && DATOS.filas || []).forEach(function (f) { SEL.add(String(f.id)); }); TODO_FILTRO = false; pintarTabla(); return; }
    if (e.key === 'A') { selTodosFiltro(); return; }
    if (e.key === 'd') { deshacer(); return; }
    if (e.key === 'e') { exportar(); return; }
    if (e.key === 'n') { PAGINA = PAGINA + 1; cargar(); return; }
    if (e.key === 'p') { PAGINA = Math.max(1, PAGINA - 1); cargar(); return; }
  });

  /* ---------- toggle de fila clickeable ---------- */
  document.addEventListener('click', function (ev) {
    if (ev.target.closest('button') || ev.target.closest('input') || ev.target.closest('a')) return;
    var tr = ev.target.closest('tr');
    if (!tr || !tr.parentNode || tr.parentNode.tagName !== 'TBODY') return;
    var cb = tr.querySelector('input[type=checkbox]');
    if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); }
  });

  /* ---------- movimientos ---------- */
  function montarMovs() {
    var cab = document.querySelector('header');
    if (cab && !$('#btnMovs')) { var bt = document.createElement('button'); bt.className = 'tab'; bt.id = 'btnMovs'; bt.textContent = 'Movimientos'; cab.appendChild(bt); }
    var main = document.querySelector('main');
    var cont = document.createElement('div'); cont.id = 'movsbox'; cont.style.display = 'none'; cont.style.marginTop = '14px';
    if (main) main.appendChild(cont);
    document.addEventListener('click', async function (e) {
      if (e.target.id !== 'btnMovs') return;
      if (cont.style.display !== 'none') { cont.style.display = 'none'; cont.innerHTML = ''; return; }
      cont.style.display = 'block'; cont.innerHTML = '<div class="vacio">cargando...</div>';
      var j = await api('/movs?n=200');
      var cols = (j && j.cols) || []; var filas = (j && j.movs) || [];
      var h = '<table><thead><tr>';
      for (var i = 0; i < cols.length; i++) h += '<th>' + esc(cols[i]) + '</th>';
      h += '</tr></thead><tbody>';
      for (var f2 = 0; f2 < filas.length; f2++) { h += '<tr>'; for (var c2 = 0; c2 < cols.length; c2++) { var val = filas[f2][cols[c2]]; h += '<td>' + esc(val == null ? '' : val) + '</td>'; } h += '</tr>'; }
      h += '</tbody></table>';
      cont.innerHTML = h;
    });
  }

  /* ---------- carga de tarjetas ---------- */
  function montarCargar() {
    var box = document.createElement('div'); box.id = 'cargarBox';
    box.innerHTML = '<div class="filtros" style="grid-template-columns:1fr">'
      + '<div><label>Nombre del lote</label><input id="cc_nombre" placeholder="lote octubre"></div>'
      + '<div><label>Pegar tarjetas (numero, venc MM/YY, CVV, titular, DNI, banco, 1 pago, en cuotas, nota)</label><textarea id="cc_texto" placeholder="4111111111111111,12/28,123,Juan Perez,30123456,Banco,150,180"></textarea></div>'
      + '<div><label>O subir .txt / .csv</label><input type="file" id="cc_file" accept=".txt,.csv,text/plain"></div>'
      + '<div class="botones"><button class="prim" id="cc_analizar">Analizar</button>'
      + '<button class="prim" id="cc_confirmar" disabled>Confirmar</button>'
      + '<span class="aviso" id="cc_info"></span></div>'
      + '</div><div id="cc_preview"></div>';
    var main = document.querySelector('main'); if (main) main.appendChild(box);
    var cab = document.querySelector('header');
    if (cab && !$('#btnCargar')) {
      var bt = document.createElement('button'); bt.className = 'tab'; bt.id = 'btnCargar'; bt.textContent = 'Cargar tarjetas';
      cab.insertBefore(bt, cab.querySelector('.kpis'));
    }
    var ocultos = [];
    function mostrar(on) {
      if (on) {
        ocultos = [];
        Array.prototype.forEach.call(main.children, function (el) {
          if (el === box) return;
          if (el.style.display !== 'none') { ocultos.push([el, el.style.display]); el.style.display = 'none'; }
        });
        box.style.display = 'block';
      } else {
        box.style.display = 'none';
        ocultos.forEach(function (p) { p[0].style.display = p[1] || ''; });
        ocultos = [];
      }
    }
    function filaC(r) {
      var cls = (r.estado === 'ok' || r.estado === 'reactivada') ? 'cc-ok' : (r.estado === 'duplicada' ? 'cc-dup' : 'cc-bad');
      return '<tr class="' + cls + '"><td>' + esc(r.estado) + '</td>'
        + '<td class="mono">' + esc(r.numero_mask || '-') + '</td>'
        + '<td class="mono">' + esc((r.mes || '') + '/' + (r.anio || '')) + '</td>'
        + '<td>' + esc(r.titular || '-') + '</td><td class="mono">' + esc(r.dni || '-') + '</td>'
        + '<td>' + esc(r.banco || '-') + '</td><td>' + esc(r.precio || '-') + '</td>'
        + '<td class="sub">' + esc(r.aviso || r.codigo || r.motivo || '') + '</td></tr>';
    }
    function pintarC(r, confirmado) {
      var tp = (r.filas || []).slice(0, 300);
      var reactivables = (r.filas || []).filter(function (x) { return x.puede_reactivar; }).length;
      var h = '<div class="cc-resumen"><span>Total <b>' + esc(r.total || 0) + '</b></span>'
        + '<span>OK <b>' + esc(r.nuevas || 0) + '</b></span>'
        + '<span>Duplicadas <b>' + esc(r.duplicadas_count || 0) + '</b></span>'
        + '<span>Invalidas <b>' + esc(r.invalidas_count || 0) + '</b></span>'
        + (r.reactivadas_count ? '<span>Reactivadas <b>' + esc(r.reactivadas_count) + '</b></span>' : '')
        + (r.lote_id ? '<span>Lote <b>#' + esc(r.lote_id) + '</b></span>' : '') + '</div>';
      if (reactivables) h += '<label style="display:flex;gap:7px;align-items:center;margin:8px 0;font-size:13px"><input type="checkbox" id="cc_reactivar" data-nuevas="' + esc(r.nuevas || 0) + '"> Reactivar ' + reactivables + ' duplicada(s) en BAJA</label>';
      h += '<table><thead><tr><th>Estado</th><th>Numero</th><th>Venc</th><th>Titular</th><th>DNI</th><th>Banco</th><th>Precio</th><th>Codigo / motivo</th></tr></thead><tbody>'
        + tp.map(filaC).join('') + '</tbody></table>';
      if (confirmado && r.lote_id) h += '<a class="cc-link" href="/panel/cc/export?id=' + encodeURIComponent(r.lote_id) + '&token=' + encodeURIComponent(TOKEN) + '">Descargar resumen CSV</a>';
      $('#cc_preview').innerHTML = h;
      $('#cc_confirmar').disabled = !(r.nuevas > 0 || (reactivables && $('#cc_reactivar') && $('#cc_reactivar').checked));
    }
    async function post(ruta, cuerpo) {
      var h = { 'Content-Type': 'application/json' };
      var c = sessionStorage.getItem('csrf') || '';
      if (c) h['x-csrf-token'] = c;
      var ac = new AbortController(); var tm = setTimeout(function () { ac.abort(); }, 90000);
      var r = await fetch('/panel' + ruta + '?token=' + encodeURIComponent(TOKEN), { method: 'POST', headers: h, body: JSON.stringify(cuerpo), signal: ac.signal });
      clearTimeout(tm); return r.json();
    }
    function texto() { return $('#cc_texto') ? $('#cc_texto').value : ''; }
    async function analizar() {
      $('#cc_info').textContent = 'analizando...';
      try {
        var reac = $('#cc_reactivar');
        var r = await post('/cc/analizar', { texto: texto(), nombre: $('#cc_nombre').value, reactivar: !!(reac && reac.checked) });
        if (r.error) { $('#cc_info').textContent = 'error: ' + r.error; return; }
        pintarC(r, false); $('#cc_info').textContent = 'listo: ' + r.nuevas + ' validas';
      } catch (e) { $('#cc_info').textContent = 'error de red'; }
    }
    async function confirmar() {
      $('#cc_info').textContent = 'confirmando...';
      try {
        var reac = $('#cc_reactivar');
        var r = await post('/cc/confirmar', { texto: texto(), nombre: $('#cc_nombre').value, reactivar: !!(reac && reac.checked) });
        if (r.error) { $('#cc_info').textContent = 'error: ' + r.error; return; }
        pintarC(r, true); $('#cc_info').textContent = 'confirmado: ' + r.nuevas + ' cargadas';
        $('#cc_confirmar').disabled = true;
      } catch (e) { $('#cc_info').textContent = 'error de red'; }
    }
    document.addEventListener('click', function (e) {
      if (e.target.id === 'btnCargar') { var on = box.style.display === 'none' || !box.style.display; mostrar(on); e.target.classList.toggle('on', on); return; }
      if (e.target.id === 'cc_analizar') { analizar(); return; }
      if (e.target.id === 'cc_confirmar') { confirmar(); return; }
    });
    document.addEventListener('change', function (e) {
      if (e.target.id === 'cc_reactivar') { var n = Number(e.target.dataset.nuevas || 0); $('#cc_confirmar').disabled = !(n > 0 || e.target.checked); return; }
      if (e.target.id !== 'cc_file') return;
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { var t = $('#cc_texto'); if (t) t.value = String(fr.result || ''); $('#cc_info').textContent = f.name + ' (' + f.size + ' bytes)'; };
      fr.readAsText(f);
    });
  }

  /* ---------- tema / salir / logo ---------- */
  function montarTema() {
    var k = 'tema', b = document.body;
    function set(t) {
      b.classList.toggle('claro', t !== 'oscuro');
      try { localStorage.setItem(k, t); } catch (e) {}
      var x = $('#btnTema'); if (x) x.textContent = b.classList.contains('claro') ? 'Oscuro' : 'Claro';
    }
    set(localStorage.getItem(k) || 'claro');
    var btn = $('#btnTema'); if (btn) btn.onclick = function () { set(b.classList.contains('claro') ? 'oscuro' : 'claro'); };
  }
  function montarSalir() {
    var b = $('#btnSalir'); if (!b) return;
    b.addEventListener('click', async function () {
      try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': sessionStorage.getItem('csrf') || '' }, body: '{}' }); } catch (_) {}
      localStorage.removeItem('tok'); sessionStorage.removeItem('csrf');
      location.href = '/login';
    });
  }
  function montarLogo() {
    var lg = document.querySelector('.logo');
    if (lg && lg.tagName !== 'A') {
      var a = document.createElement('a'); a.href = '/panel/'; a.className = lg.className; a.title = 'Inicio';
      a.style.textDecoration = 'none'; a.style.color = 'inherit'; a.style.cursor = 'pointer'; a.innerHTML = lg.innerHTML;
      lg.parentNode.replaceChild(a, lg);
    }
  }

  /* ---------- arranque ---------- */
  refrescarGuardados();
  barraAcciones();
  montarMovs();
  montarCargar();
  montarTema();
  montarSalir();
  montarLogo();
  ajustarBotones();
  if (!TOKEN) { var i3 = $('#info'); if (i3) i3.textContent = 'falta token'; }
  cargar();
  setInterval(function () { if (!document.hidden && !$('#modal').classList.contains('abierto')) cargar(); }, 20000);
})();
