/* app.js — logica del panel RESOLVER STORE. Un solo archivo, sin scripts apilados. */
(function () {
  'use strict';

  /* ---------- estilos propios ---------- */
  /* El CSS vive en /panel/panel.css (cargado en <head> para evitar CLS). */

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

  /* ---------- avisos y diálogos (SweetAlert2 + Toastify) ---------- */
  var ACCION_TXT = {
    publicar: 'Publicadas', reservar: 'Reservadas', devolver: 'Devueltas',
    baja: 'Dadas de baja', precioCC: 'Precio actualizado', precioCuotas: 'Cuotas actualizadas',
    etiqueta: 'Etiqueta actualizada', saldo: 'Saldo actualizado', borrar: 'A la papelera',
    restaurar: 'Restauradas', borrarDef: 'Borradas', estado: 'Estado actualizado',
  };
  function toast(msg, tipo) {
    if (window.Toastify) {
      Toastify({
        text: msg, duration: 3200, gravity: 'bottom', position: 'right', close: true,
        style: { background: tipo === 'error' ? '#b91c1c' : '#15803d' },
      }).showToast();
      return;
    }
    console.log((tipo === 'error' ? 'ERROR: ' : '') + msg);
  }
  function confirmar(titulo, texto, boton) {
    if (!window.Swal) { toast('Falta SweetAlert2', 'error'); return Promise.resolve(false); }
    return Swal.fire({
      title: titulo, text: texto, icon: 'warning', showCancelButton: true,
      confirmButtonText: boton || 'Confirmar', cancelButtonText: 'Cancelar',
      confirmButtonColor: '#2563eb', cancelButtonColor: '#475569',
    }).then(function (r) { return r.isConfirmed; });
  }
  function pedirTexto(titulo, placeholder) {
    if (!window.Swal) { toast('Falta SweetAlert2', 'error'); return Promise.resolve(null); }
    return Swal.fire({
      title: titulo, input: 'text', inputPlaceholder: placeholder || '',
      showCancelButton: true, confirmButtonText: 'Guardar', cancelButtonText: 'Cancelar',
      confirmButtonColor: '#2563eb',
    }).then(function (r) { return r.isConfirmed ? (r.value == null ? '' : String(r.value)) : null; });
  }

  /* ---------- estado ---------- */
  var ESTADO = 'DISPONIBLE', PAGINA = 1, POR = 50, SEL = new Set(), DATOS = null, DASH = false, ACC = null;
  var HIST = [], TODO_FILTRO = false, SIN_PRECIO = false;
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
    if (SIN_PRECIO) f.sin_precio = '1';
    return f;
  }

  function pintarKpis(k) {
    var c = $('#kpis'); if (!c) return;
    var it = [['Disponibles', k.disponible], ['Vendidas', k.vendidas], ['Saldo', num(k.saldoTotal)], ['Sin precio', k.sinPrecio]];
    if (DASH) { it.push(['Ventas', k.ventas == null ? '-' : k.ventas], ['Alertas', (k.alertas || []).length]); paresEstado(k).forEach(function (p) { it.push([p[0], p[1]]); }); }
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
    ['f_paises', 'f_bancos', 'f_redes', 'f_tipos', 'f_etiquetas'].forEach(function (id) {
      var el = $('#' + id);
      if (el && el.tomselect) { try { el.tomselect.sync(); } catch (_) {} }
    });
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
      + '<td><input type="checkbox" data-id="' + esc(f.id) + '" aria-label="Seleccionar tarjeta ref ' + esc(f.ref) + '"' + (SEL.has(String(f.id)) ? ' checked' : '') + '></td>'
      + '<td><div class="bin mono">' + esc(f.bin) + '</div><div class="sub">' + esc(f.banco || '-') + '</div></td>'
      + '<td><span class="badge ' + cls + '">' + esc(f.marca || '-') + '</span></td>'
      + '<td>' + esc(f.tipo || '-') + '</td>'
      + '<td class="mono">' + esc(f.exp || '') + '</td>'
      + '<td>' + esc(f.pais || '-') + '</td>'
      + '<td class="mono">' + esc(f.zip || '-') + '</td>'
      + '<td>' + iconos(f.features || {}) + '</td>'
      + '<td>' + esc(f.etiqueta || '-') + '</td>'
      + '<td>' + (f.refund ? 'SI' : 'NO') + '</td>'
      + '<td><span class="badge-estado estado-' + esc(String(f.estado || ESTADO).toLowerCase()) + '">' + esc(f.estado || ESTADO) + '</span></td>'
      + '<td class="mono saldo">' + esc(f.saldo || '-') + '</td>'
      + '<td class="precio"' + falta + '>' + (f.precio == null ? '-' : esc(num(f.precio))) + '</td>'
      + '<td class="precio"' + falta + '>' + esc(f.precio_cuotas == null ? '-' : num(f.precio_cuotas)) + '</td>'
      + '<td><details class="acciones"><summary aria-label="Acciones"><svg class="icon"><use href="/panel/vendor/iconos.svg#tabler-dots-vertical"></use></svg></summary>'
      + '<div class="acciones-menu"><button class="sec" data-ver="' + esc(f.id) + '">Ver</button>'
      + '<button class="sec" data-pedir-id="' + esc(f.id) + '" data-pedir-bin="' + esc(f.bin) + '">Pedir</button></div></details></td>'
      + '</tr>';
  }
  function pintarTabla() {
    var t = $('#cuerpo'); if (!t) return;
    if (!DATOS || !DATOS.filas.length) t.innerHTML = '<tr><td colspan="15" class="vacio">Sin resultados</td></tr>';
    else t.innerHTML = DATOS.filas.map(fila).join('');
    var s = $('#sel'); if (s) s.textContent = SEL.size + ' seleccionadas' + (TODO_FILTRO ? ' (todo el filtro)' : '');
    var b = $('#btnComprar'); if (b) b.disabled = !SEL.size;
    actualizarBarraContextual();
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
    actualizarChipSinPrecio();
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
    ESTADO = 'DISPONIBLE'; PAGINA = 1; SEL.clear(); TODO_FILTRO = false; SIN_PRECIO = false; cargar();
  }

  /* ---------- filtros guardados ---------- */
  function filtrosGuardados() { try { return JSON.parse(localStorage.getItem('resolver_filtros') || '{}') || {}; } catch (_) { return {}; } }
  function refrescarGuardados() {
    var sel = $('#f_guardados'); if (!sel) return; var data = filtrosGuardados(); var act = sel.value;
    sel.innerHTML = '<option value="">—</option>' + Object.keys(data).sort().map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
    if (act) sel.value = act;
  }
  function guardarFiltro() {
    var n = txt('f_nombre'); if (!n) return toast('Pone un nombre para el filtro.', 'error');
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
  function actualizarBarraContextual() {
    var ctx = $('#barraContextual'); if (!ctx) return;
    var visible = SEL.size > 0 || TODO_FILTRO || HIST.length > 0;
    ctx.hidden = !visible;
    document.body.classList.toggle('tiene-seleccion', visible);
  }
  function pintarUndo() {
    var b = $('#btnDeshacer'); if (!b) return;
    var h = HIST[HIST.length - 1];
    b.disabled = !h; b.textContent = h ? 'Deshacer (' + h.nombre + ')' : 'Deshacer';
    actualizarBarraContextual();
  }
  async function deshacer() {
    var h = HIST[HIST.length - 1]; if (!h) return;
    HIST.pop(); pintarUndo();
    var j = await api('/accion?' + qq({ accion: 'pares', pares: JSON.stringify(h.pares) }));
    if (j && j.error) { toast('Error: ' + j.error, 'error'); HIST.push(h); pintarUndo(); return; }
    toast('Deshecho (' + h.nombre + ')');
    cargar();
  }
  async function mutar(nombre, params, undoMapa) {
    var lista = ids(); if (!lista.length) { toast('Nada seleccionado', 'error'); return; }
    registrarUndo(nombre, lista, undoMapa || {});
    var o = Object.assign({ accion: nombre, ids: lista.join(',') }, params || {});
    var j = await api('/accion?' + qq(o));
    if (j && j.error) { toast('Error: ' + j.error, 'error'); HIST.pop(); pintarUndo(); return; }
    SEL.clear(); TODO_FILTRO = false; cargar();
    toast((ACCION_TXT[nombre] || nombre) + ' (' + lista.length + ')');
  }
  async function selTodosFiltro() {
    var f = filtros(); f.accion = 'ids';
    var j = await api('/accion?' + qq(f));
    if (!j || j.error) { toast('Error: ' + ((j && j.error) || 'red'), 'error'); return; }
    SEL = new Set((j.ids || []).map(String)); TODO_FILTRO = true; pintarTabla();
    var s = $('#sel'); if (s) s.textContent = SEL.size + ' seleccionadas (todo el filtro)';
  }
  async function exportar() {
    var f = filtros(); f.accion = 'export';
    var j = await api('/accion?' + qq(f));
    if (!j || j.error) { toast('Error: ' + ((j && j.error) || 'red'), 'error'); return; }
    var blob = new Blob(['\uFEFF' + j.csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = j.nombre || 'stock.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    toast('CSV exportado');
  }
  async function precioPorBin() {
    if (!window.Swal) { toast('Falta SweetAlert2', 'error'); return; }
    var r = await Swal.fire({
      title: 'Preciar por BIN',
      html: '<label for="sw_bin">BIN (6 dígitos)</label><input id="sw_bin" class="swal2-input" inputmode="numeric" maxlength="6" placeholder="516585">'
        + '<label for="sw_p1">Precio 1 pago</label><input id="sw_p1" class="swal2-input" inputmode="numeric" placeholder="vacío = quitar">'
        + '<label for="sw_p2">Precio en cuotas</label><input id="sw_p2" class="swal2-input" inputmode="numeric" placeholder="vacío = quitar">',
      showCancelButton: true, confirmButtonText: 'Guardar', cancelButtonText: 'Cancelar',
      confirmButtonColor: '#2563eb', focusConfirm: false,
      preConfirm: function () {
        var b = String(($('#sw_bin') || {}).value || '').replace(/\D/g, '');
        if (!/^\d{6}$/.test(b)) { Swal.showValidationMessage('El BIN debe tener 6 dígitos'); return false; }
        return {
          bin: b,
          p1: String(($('#sw_p1') || {}).value || '').trim(),
          p2: String(($('#sw_p2') || {}).value || '').trim(),
        };
      },
    });
    if (!r.isConfirmed) return;
    await api('/accion?' + qq({ accion: 'precioBin', bin: r.value.bin, valor: r.value.p1 }));
    if (r.value.p2 !== '') await api('/accion?' + qq({ accion: 'precioCuotasBin', bin: r.value.bin, valor: r.value.p2 }));
    toast('Precio por BIN actualizado (' + r.value.bin + ')');
    cargar();
  }

  /* ---------- banners ---------- */
  function actualizarChipSinPrecio() {
    var chip = $('#chipSinPrecio'); if (!chip) return;
    var n = (DATOS && DATOS.kpis && DATOS.kpis.sinPrecio) || 0;
    chip.hidden = !(n > 0 || SIN_PRECIO);
    chip.classList.toggle('activo', !!SIN_PRECIO);
    chip.title = SIN_PRECIO ? 'Quitar el filtro de sin precio' : 'Ver publicadas sin precio';
    var numEl = $('#chipSinPrecioN'); if (numEl) numEl.textContent = n;
  }
  function alternarSinPrecio() {
    SIN_PRECIO = !SIN_PRECIO;
    var fp = $('#f_pmax'); if (fp) fp.value = '';
    ESTADO = 'DISPONIBLE'; var fe = $('#f_estado'); if (fe) fe.value = 'DISPONIBLE';
    PAGINA = 1; cargar();
  }
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
      b.innerHTML = '<b>' + n + '</b> publicada(s) SIN PRECIO: no salen en Market ni en el bot. <button class="sec" id="spPrecioBin">Preciar por BIN</button> <button class="sec" id="spVer">' + (SIN_PRECIO ? 'Ver todas' : 'Ver sin precio') + '</button>';
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
  var CHART_PROMESA = null, CHARTS = [];
  function cargarChart() {
    if (window.Chart) return Promise.resolve();
    if (CHART_PROMESA) return CHART_PROMESA;
    CHART_PROMESA = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = '/panel/vendor/chart.umd.min.js';
      s.onload = function () { res(); };
      s.onerror = function () { CHART_PROMESA = null; rej(new Error('no se pudo cargar Chart.js')); };
      document.head.appendChild(s);
    });
    return CHART_PROMESA;
  }
  function paresEstado(k) {
    var pe = (k && k.porEstado) || [];
    if (Array.isArray(pe)) return pe.map(function (x) { return [x.estado, x.n]; });
    return Object.keys(pe).map(function (e) { return [e, pe[e]]; });
  }
  function destruirCharts() {
    CHARTS.forEach(function (c) { try { c.destroy(); } catch (_) {} });
    CHARTS = [];
  }
  function dibujarDashboard(k) {
    if (!window.Chart) return;
    var pares = paresEstado(k);
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.borderColor = 'rgba(148,163,184,.15)';

    var elEstado = document.getElementById('chEstado');
    if (elEstado) {
      CHARTS.push(new Chart(elEstado, {
        type: 'doughnut',
        data: {
          labels: pares.map(function (p) { return p[0]; }),
          datasets: [{ data: pares.map(function (p) { return p[1]; }), backgroundColor: ['#2563eb', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#64748b', '#eab308'], borderWidth: 0 }],
        },
        options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } } },
      }));
    }

    var bins = ((DATOS && DATOS.facetas && DATOS.facetas.bins) || []).slice(0, 10);
    var elBins = document.getElementById('chBins');
    if (elBins) {
      CHARTS.push(new Chart(elBins, {
        type: 'bar',
        data: {
          labels: bins.map(function (b) { return b.v; }),
          datasets: [{ label: 'CC', data: bins.map(function (b) { return b.n; }), backgroundColor: '#2563eb', borderRadius: 4 }],
        },
        options: {
          maintainAspectRatio: false, indexAxis: 'y',
          plugins: { legend: { display: false } },
          scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false } } },
        },
      }));
    }

    api('/movs?n=500').then(function (j) {
      var porDia = {};
      ((j && j.movs) || []).forEach(function (m) {
        if (m.accion !== 'VENTA') return;
        var dia = String(m.fecha || '').slice(0, 10);
        if (dia) porDia[dia] = (porDia[dia] || 0) + 1;
      });
      var dias = Object.keys(porDia).sort().slice(-14);
      var elVentas = document.getElementById('chVentas');
      if (!elVentas) return;
      CHARTS.push(new Chart(elVentas, {
        type: 'line',
        data: {
          labels: dias,
          datasets: [{ label: 'Ventas', data: dias.map(function (d) { return porDia[d]; }), borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,.18)', fill: true, tension: .3, pointRadius: 3 }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false } } },
        },
      }));
    }).catch(function () {});
  }
  function dashboard() {
    var main = document.querySelector('main'); if (!main) return;
    var box = $('#dashBox');
    if (!box) { box = document.createElement('div'); box.id = 'dashBox'; main.appendChild(box); }
    box.style.display = 'block';
    var k = (DATOS && DATOS.kpis) || {};
    var pares = paresEstado(k);
    var estados = pares.map(function (p) { return '<div class="card">' + esc(p[0]) + '<b>' + esc(p[1]) + '</b></div>'; }).join('');
    var bins = ((DATOS && DATOS.facetas && DATOS.facetas.bins) || []).slice(0, 12).map(function (b) {
      return '<tr><td class="mono">' + esc(b.v) + '</td><td>' + esc(b.banco || '-') + '</td><td>' + esc(b.n) + '</td></tr>';
    }).join('');
    destruirCharts();
    box.innerHTML = '<div class="grid">'
      + '<div class="card">Disponibles<b>' + esc(k.disponible || 0) + '</b></div>'
      + '<div class="card">Vendidas<b>' + esc(k.vendidas || 0) + '</b></div>'
      + '<div class="card">Saldo total<b>' + esc(num(k.saldoTotal)) + '</b></div>'
      + '<div class="card">Ventas<b>' + esc(k.ventas || 0) + '</b></div>'
      + '<div class="card">Sin precio<b>' + esc(k.sinPrecio || 0) + '</b></div>'
      + '<div class="card">Alertas<b>' + esc((k.alertas || []).length) + '</b></div>'
      + estados + '</div>'
      + '<div class="charts">'
      + '<div class="chartbox"><h4>Stock por estado</h4><canvas id="chEstado" height="200"></canvas></div>'
      + '<div class="chartbox"><h4>Ventas por día (últimas 14)</h4><canvas id="chVentas" height="200"></canvas></div>'
      + '<div class="chartbox"><h4>Top BIN</h4><canvas id="chBins" height="200"></canvas></div>'
      + '</div>'
      + (bins ? '<h3 style="margin:16px 0 6px">Top BIN</h3><table><thead><tr><th>BIN</th><th>Banco</th><th>CC</th></tr></thead><tbody>' + bins + '</tbody></table>' : '');
    cargarChart().then(function () { dibujarDashboard(k); }).catch(function (e) {
      var c = $('#dashBox .charts');
      if (c) c.innerHTML = '<div class="vacio">No se pudo cargar Chart.js: ' + esc(e.message) + '</div>';
    });
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
    if (!j || j.error) { toast('Error: ' + ((j && j.error) || 'sin stock'), 'error'); return; }
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
    var ctx = document.getElementById('barraContextual') || barra;
    ctx.insertBefore(b, ctx.querySelector('#btnComprar') || null);
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
    if (t.closest('#btnPedirSel')) { var l = ids(); if (!l.length) { toast('Nada seleccionado', 'error'); return; } pedir(l); return; }
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
      if (ESTADO === 'REVISION') { if (!SEL.size) { toast('Nada seleccionado', 'error'); return; } mutar('publicar', {}, { estado: function () { return 'REVISION'; } }); return; }
      comprar(); return;
    }
    if (t.closest('#revPubAll')) { selTodosFiltro().then(function () { setTimeout(function () { mutar('publicar', {}, { estado: function () { return 'REVISION'; } }); }, 80); }); return; }
    if (t.closest('#revPriceBin') || t.closest('#spPrecioBin')) { precioPorBin(); return; }
    if (t.closest('#spVer')) { alternarSinPrecio(); return; }
    if (t.closest('#chipSinPrecio')) { alternarSinPrecio(); return; }
    if (t.closest('#m_cancelar')) { cerrar(); return; }
    if (t.closest('#m_ok')) { if (ACC) ACC(); return; }

    if (t.id === 'btnReservar') { mutar('reservar', {}, { estado: function () { return 'DISPONIBLE'; }, reserva_vence: function () { return null; }, reservado_por: function () { return null; } }); return; }
    if (t.id === 'btnPublicar') { mutar('publicar', {}, { estado: function () { return 'REVISION'; } }); return; }
    if (t.id === 'btnDevolver') {
      confirmar('Devolver a disponible', 'Devolver ' + ids().length + ' tarjeta(s) a disponible?', 'Devolver')
        .then(function (ok) { if (ok) mutar('devolver', {}, { estado: function () { return 'VENDIDA'; } }); });
      return;
    }
    if (t.id === 'btnBaja') {
      confirmar('Dar de baja', 'Dar de baja ' + ids().length + ' tarjeta(s)?', 'Dar de baja')
        .then(function (ok) { if (ok) mutar('baja', {}, { estado: function () { return ESTADO; } }); });
      return;
    }
    if (t.id === 'btnPrecio') {
      pedirTexto('Precio 1 pago', 'vacío = sin precio').then(function (v) {
        if (v !== null) mutar('precioCC', { valor: v }, { precio_num: function (f) { return f ? f.precio_num : null; } });
      });
      return;
    }
    if (t.id === 'btnPrecioCuotas') {
      pedirTexto('Precio en cuotas', 'vacío = sin cuotas').then(function (v) {
        if (v !== null) mutar('precioCuotas', { valor: v }, { precio_cuotas: function (f) { return f ? f.precio_cuotas : null; } });
      });
      return;
    }
    if (t.id === 'btnPrecioCuotasBin') { precioPorBin(); return; }
    if (t.id === 'btnEtiqueta') {
      pedirTexto('Etiqueta / base', 'vacío = sin etiqueta').then(function (v) {
        if (v !== null) mutar('etiqueta', { valor: v }, { etiqueta: function (f) { return f ? f.etiqueta : null; } });
      });
      return;
    }
    if (t.id === 'btnSaldo') {
      if (!window.Swal) { toast('Falta SweetAlert2', 'error'); return; }
      Swal.fire({
        title: 'Saldo de la tarjeta',
        html: '<label for="sw_saldo_disp">Saldo disponible</label><input id="sw_saldo_disp" class="swal2-input" inputmode="numeric" placeholder="0">'
          + '<label for="sw_saldo_ref">Saldo referencia (vacío = igual)</label><input id="sw_saldo_ref" class="swal2-input" inputmode="numeric" placeholder="opcional">',
        showCancelButton: true, confirmButtonText: 'Guardar', cancelButtonText: 'Cancelar',
        confirmButtonColor: '#2563eb', focusConfirm: false,
        preConfirm: function () {
          return {
            disp: String(($('#sw_saldo_disp') || {}).value || '').trim(),
            total: String(($('#sw_saldo_ref') || {}).value || '').trim(),
          };
        },
      }).then(function (r) {
        if (!r.isConfirmed) return;
        mutar('saldo', { disp: r.value.disp, total: r.value.total }, { saldo: function (f) { return f ? f.saldo_num : null; }, saldo_ref: function (f) { return f ? f.saldo_ref_num : null; }, saldo_disp_num: function (f) { return f ? f.saldo_num : null; }, saldo_total_num: function (f) { return f ? f.saldo_ref_num : null; } });
      });
      return;
    }
    if (t.id === 'btnEstado') {
      if (!window.Swal) { toast('Falta SweetAlert2', 'error'); return; }
      Swal.fire({
        title: 'Cambiar estado',
        html: '<select id="sw_estado" class="swal2-select">'
          + ['DISPONIBLE', 'RESERVADA', 'PAGADA', 'VENDIDA', 'BAJA', 'RECLAMADA', 'ANULADA', 'REVISION'].map(function (e) {
            return '<option value="' + e + '"' + (e === ESTADO ? ' selected' : '') + '>' + e + '</option>';
          }).join('')
          + '</select>',
        showCancelButton: true, confirmButtonText: 'Cambiar', cancelButtonText: 'Cancelar',
        confirmButtonColor: '#2563eb', focusConfirm: false,
        preConfirm: function () { return String(($('#sw_estado') || {}).value || ''); },
      }).then(function (r) {
        if (!r.isConfirmed || !r.value) return;
        mutar('estado', { valor: r.value }, { estado: function () { return ESTADO; } });
      });
      return;
    }
    if (t.id === 'btnBorrar') {
      var n = ids().length; if (!n) { toast('Nada seleccionado', 'error'); return; }
      if (ESTADO === 'PAPELERA') {
        confirmar('Borrado definitivo', 'Borrar DEFINITIVAMENTE ' + n + ' tarjeta(s)? No se puede deshacer.', 'Borrar')
          .then(function (ok) { if (ok) mutar('borrarDef', {}, {}); });
        return;
      }
      confirmar('A la papelera', 'Mover ' + n + ' tarjeta(s) a la papelera?', 'A la papelera')
        .then(function (ok) { if (ok) mutar('borrar', {}, { eliminado: function () { return 0; } }); });
      return;
    }
    if (t.id === 'btnRestaurar') {
      var m2 = ids().length; if (!m2) { toast('Nada seleccionado', 'error'); return; }
      confirmar('Restaurar', 'Restaurar ' + m2 + ' tarjeta(s)?', 'Restaurar')
        .then(function (ok) { if (ok) mutar('restaurar', {}, { eliminado: function () { return 1; } }); });
      return;
    }
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

  /* ---------- teclado (hotkeys-js) ---------- */
  function limpiarSeleccion() {
    SEL.clear(); TODO_FILTRO = false; pintarTabla();
  }
  if (window.hotkeys) {
    hotkeys.filter = function (ev) {
      var el = ev.target || {};
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA' || tag === 'SELECT') return false;
      if (tag === 'INPUT') {
        var tipo = String(el.type || 'text').toLowerCase();
        return tipo === 'checkbox' || tipo === 'radio' || tipo === 'button' || tipo === 'submit' || tipo === 'range';
      }
      return true;
    };
    hotkeys('/', function (e) {
      e.preventDefault();
      var fq = $('#f_q'); if (fq) fq.focus();
    });
    hotkeys('a', function (e) {
      e.preventDefault();
      (DATOS && DATOS.filas || []).forEach(function (f) { SEL.add(String(f.id)); });
      TODO_FILTRO = false; pintarTabla();
    });
    hotkeys('shift+a', function (e) { e.preventDefault(); selTodosFiltro(); });
    hotkeys('d', function (e) { e.preventDefault(); deshacer(); });
    hotkeys('e', function (e) { e.preventDefault(); exportar(); });
    hotkeys('n', function (e) { e.preventDefault(); PAGINA = PAGINA + 1; cargar(); });
    hotkeys('p', function (e) { e.preventDefault(); PAGINA = Math.max(1, PAGINA - 1); cargar(); });
    hotkeys('esc', function (e) {
      e.preventDefault();
      if ($('#modal').classList.contains('abierto')) cerrar(); else limpiarSeleccion();
    });
  }
  /* Enter sigue buscando desde los campos de texto. */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target && (e.target.id === 'f_q' || e.target.id === 'f_bins')) { PAGINA = 1; cargar(); }
  });

  /* ---------- toggle de fila clickeable ---------- */
  document.addEventListener('click', function (ev) {
    if (ev.target.closest('button') || ev.target.closest('input') || ev.target.closest('a') || ev.target.closest('summary') || ev.target.closest('.acciones')) return;
    var tr = ev.target.closest('tr');
    if (!tr || !tr.parentNode || tr.parentNode.tagName !== 'TBODY') return;
    var cb = tr.querySelector('input[type=checkbox]');
    if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); }
  });

  /* ---------- movimientos ---------- */
  function montarMovs() {
    var nav = document.querySelector('.sidebar-nav');
    if (nav && !$('#btnMovs')) {
      var bt = document.createElement('button');
      bt.className = 'tab nav-link'; bt.id = 'btnMovs';
      bt.innerHTML = '<svg class="icon"><use href="/panel/vendor/iconos.svg#tabler-activity"></use></svg> Movimientos';
      nav.appendChild(bt);
    }
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
      + '<div><label>O subir .txt / .csv</label><input type="file" id="cc_file" accept=".txt,.csv,text/plain" aria-label="Archivo de tarjetas"></div>'
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

  /* ---------- filtros: Tom Select + colapsable ---------- */
  function initTomSelect() {
    if (!window.TomSelect) return;
    ['f_paises', 'f_bancos', 'f_redes', 'f_tipos', 'f_etiquetas', 'f_estado'].forEach(function (id) {
      var el = $('#' + id);
      if (!el || el.tomselect) return;
      var lab = document.querySelector('label[for="' + id + '"]');
      var nombre = lab ? lab.textContent.trim() : id;
      try {
        var ts = new TomSelect(el, {
          allowEmptyOption: true, create: false, maxItems: 1, plugins: [],
          onChange: function (v) {
            el.value = v == null ? '' : v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          },
        });
        el.setAttribute('aria-label', nombre);
        if (ts.control_input) {
          ts.control_input.setAttribute('aria-label', nombre);
          ts.control_input.setAttribute('id', id + '-ts-input');
        }
      } catch (_) {}
    });
  }
  function initFiltros() {
    var box = $('#filtrosBox'); if (!box) return;
    var ids = ['f_bins', 'f_bin_desde', 'f_bin_hasta', 'f_saldmin', 'f_saldmax', 'f_pmin', 'f_pmax', 'f_q', 'f_nombre'];
    function activos() {
      var n = ids.filter(function (id) { return txt(id); }).length;
      if (txt('f_estado') && txt('f_estado') !== 'DISPONIBLE') n += 1;
      if ($('#f_saldeadas') && $('#f_saldeadas').checked) n += 1;
      return n;
    }
    function resumen() {
      var n = activos();
      var el = $('#filtrosActivos');
      if (el) el.textContent = n ? n + ' activo' + (n === 1 ? '' : 's') : '';
    }
    if (window.innerWidth < 900 && activos() === 0) box.open = false;
    resumen();
    document.addEventListener('change', resumen);
    document.addEventListener('click', resumen);
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
  initTomSelect();
  initFiltros();
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
