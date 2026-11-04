/* Extraído de admin.html (CSP script-src 'self'). */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => Number(v || 0).toLocaleString('es-AR');
const fecha = (s) => s ? String(s).slice(0, 16).replace('T', ' ') : '-';
let CSRF = '';
let USUARIOS = [];

async function api(ruta, cuerpo, metodo) {
  const r = await fetch(ruta, {
    method: metodo || (cuerpo ? 'POST' : 'GET'),
    headers: Object.assign({ 'content-type': 'application/json' }, CSRF ? { 'x-csrf-token': CSRF } : {}),
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return null; }
  return j || {};
}
function decir(sel, t, ok) { const e = $(sel); if (!e) return; e.textContent = t || ''; e.classList.toggle('ok', Boolean(ok)); }
function badge(e) {
  const ok = ['activo', 'aprobada', 'ok', 'resuelta'].includes(e);
  const warn = ['pendiente', 'pagada', 'revision'].includes(e);
  return '<span class="badge ' + (ok ? 'ok' : warn ? 'warn' : 'bad') + '">' + esc(e) + '</span>';
}
function tabla(head, filas) {
  return '<table><thead><tr>' + head.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' +
    (filas.length ? filas.join('') : '<tr><td colspan="' + head.length + '" class="sub">Sin datos.</td></tr>') + '</tbody></table>';
}

/* --------------------------------- resumen -------------------------------- */
async function cargarResumen() {
  const j = await api('/api/admin/metricas');
  if (!j || !j.ok) return;
  const k = j.kpis;
  const items = [
    ['Disponibles', k.disponibles], ['Ventas hoy', k.ventas_hoy], ['Ingresos hoy', '$ ' + num(k.ingresos_hoy)],
    ['Reservas activas', k.reservas_activas], ['Reclamos', k.reclamos_pendientes], ['Recargas', k.recargas_pendientes],
    ['Altas', k.altas_pendientes], ['Saldo vendedores', '$ ' + num(k.saldo_vendedores)],
  ];
  $('#kpis').innerHTML = items.map((x) => '<div class="kpi"><b>' + x[1] + '</b><span>' + x[0] + '</span></div>').join('');
  $('#ventasDia').innerHTML = tabla(['Día', 'Ventas', 'Ingresos'], (j.ventasPorDia || []).map((f) =>
    '<tr><td>' + esc(f.dia) + '</td><td>' + f.n + '</td><td>$ ' + num(f.total) + '</td></tr>'));
  $('#ingresosVend').innerHTML = tabla(['Vendedor', 'Ventas', 'Ingresos', 'Fallas'], (j.ingresosPorVendedor || []).map((f) =>
    '<tr><td>' + esc(f.usuario) + '</td><td>' + f.n + '</td><td>$ ' + num(f.total) + '</td><td>' + f.fallas + '</td></tr>'));
  $('#fallaBin').innerHTML = tabla(['BIN', 'Vendidas', 'OK', 'Fallas', 'Tasa'], (j.fallaPorBin || []).map((f) =>
    '<tr><td>' + esc(f.bin) + '</td><td>' + f.total + '</td><td>' + f.ok + '</td><td>' + f.fallas + '</td><td>' + f.tasa + '%</td></tr>'));
  $('#stockBajo').innerHTML = tabla(['BIN', 'Disponibles', 'Total histórico'], (j.stockBajo || []).map((f) =>
    '<tr><td>' + esc(f.bin) + '</td><td><b style="color:' + (f.n ? 'var(--warn)' : 'var(--bad)') + '">' + f.n + '</b></td><td>' + f.total + '</td></tr>'));
  $('#margenLote').innerHTML = tabla(['Lote', 'Vendidas', 'Ingresos', 'Costo', 'Margen'], (j.margenPorLote || []).map((f) =>
    '<tr><td>' + esc(f.lote) + '</td><td>' + f.n + '</td><td>$ ' + num(f.ingresos) + '</td><td>$ ' + num(f.costo) + '</td><td>$ ' + num(f.margen) + '</td></tr>'));
  $('#cierreCaja').innerHTML = tabla(['Día', 'Ventas', 'Ingresos'], (j.cierreCaja || []).map((f) =>
    '<tr><td>' + esc(f.dia) + '</td><td>' + f.ventas + '</td><td>$ ' + num(f.ingresos) + '</td></tr>'));
  const al = await api('/api/admin/alertas');
  if (al && al.ok) {
    const filas = [];
    for (const x of al.stockBajo || []) filas.push('<tr><td>Stock bajo</td><td>' + esc(x.bin) + '</td><td>' + x.n + ' disponibles</td></tr>');
    for (const x of al.fallaAlta || []) filas.push('<tr><td>Falla alta</td><td>' + esc(x.bin) + '</td><td>' + x.tasa + '% (' + x.fallas + '/' + x.total + ')</td></tr>');
    for (const x of al.saldoNegativo || []) filas.push('<tr><td>Saldo negativo</td><td>' + esc(x.usuario) + '</td><td>$ ' + num(x.saldo) + '</td></tr>');
    for (const x of al.reclamosVendedor || []) filas.push('<tr><td>Reclamos</td><td>' + esc(x.usuario) + '</td><td>' + x.n + ' (' + x.pendientes + ' pendientes)</td></tr>');
    $('#alertasOp').innerHTML = tabla(['Tipo', 'Referencia', 'Detalle'], filas);
  }
}

async function cargarAccesos() {
  const j = await api('/api/admin/accesos?n=200');
  if (!j || !j.ok) return;
  $('#accesos').innerHTML = tabla(['#', 'Fecha', 'Usuario', 'IP', 'Resultado'], (j.accesos || []).map((a) =>
    '<tr><td>' + a.id + '</td><td>' + esc(String(a.creado || '').slice(0, 16).replace('T', ' ')) + '</td><td>' + esc(a.usuario || '-') + '</td><td>' + esc(a.ip || '-') + '</td><td>' + (a.ok ? 'OK' : 'FALLA') + '</td></tr>'));
}

/* -------------------------------- reclamos -------------------------------- */
async function cargarPedidos() {
  const q = new URLSearchParams({ n: '200' });
  const est = $('#ped_estado')?.value; const des = $('#ped_desde')?.value; const has = $('#ped_hasta')?.value;
  if (est) q.set('estado', est);
  if (des) q.set('desde', des + 'T00:00:00.000Z');
  if (has) q.set('hasta', has + 'T23:59:59.999Z');
  const j = await api('/api/admin/pedidos?' + q.toString());
  if (!j || !j.ok) return;
  const filas = (j.pedidos || []).map((p) => '<tr><td>' + esc(p.codigo) + '</td><td>' + esc(p.usuario || p.usuario_id) + '</td><td>' + esc(p.estado) + '</td><td>' + p.cantidad + '</td><td>$ ' + num(p.total) + '</td><td>' + esc(String(p.creado || '').slice(0, 16).replace('T', ' ')) + '</td><td><a class="sec mini" href="/api/pedidos/' + p.id + '/comprobante.html">HTML</a></td></tr>');
  $('#pedidosAdmin').innerHTML = tabla(['Pedido', 'Vendedor', 'Estado', 'CC', 'Total', 'Creado', 'Comprobante'], filas);
}

async function cargarReclamos() {
  const j = await api('/api/admin/reclamos?n=200');
  const l = (j && j.reclamos) || [];
  $('#reclamos').innerHTML = tabla(['#', 'Vendedor', 'Tarjeta', 'Motivo', 'Estado', 'Resolución', ''], l.map((r) => {
    const acc = r.estado === 'pendiente'
      ? '<button class="mini" data-rec="' + r.id + '" data-accion="reemplazo">Reemplazar</button> '
        + '<button class="sec mini" data-rec="' + r.id + '" data-accion="devolucion">Devolver saldo</button> '
        + '<button class="peligro mini" data-rec="' + r.id + '" data-accion="rechazar">Rechazar</button>'
      : '';
    return '<tr><td>#' + r.id + '</td><td>' + esc(r.usuario || '#' + r.usuario_id) + '</td>'
      + '<td>' + esc(r.codigo || r.ref || '') + '<div class="sub">' + esc(r.numero_mask || '') + ' · ' + esc(r.bin || '') + '</div></td>'
      + '<td>' + esc(r.motivo) + '</td><td>' + badge(r.estado) + '</td><td class="sub">' + esc(r.resolucion || '-') + '</td>'
      + '<td>' + acc + '</td></tr>';
  }));
}

/* --------------------------------- precios -------------------------------- */
async function cargarPrecios() {
  const base = await api('/api/admin/precios/base');
  if (base && base.ok) {
    $('#listaBase').innerHTML = tabla(['BIN', 'Precio', 'Moneda'], (base.precios || []).map((p) =>
      '<tr><td>' + (p.bin || 'todos') + '</td><td>$ ' + num(p.precio) + '</td><td>' + esc(p.moneda || '') + '</td></tr>'));
  }
  const tr = await api('/api/admin/precios/tramos');
  if (tr && tr.ok) {
    $('#listaTramos').innerHTML = tabla(['BIN', 'Desde', 'Hasta', 'Precio', ''], (tr.tramos || []).map((t) =>
      '<tr><td>' + (t.bin || 'todos') + '</td><td>' + t.desde + '</td><td>' + (t.hasta == null ? '∞' : t.hasta) + '</td><td>$ ' + num(t.precio) + '</td>'
      + '<td><button class="peligro mini" data-borrar-tramo="' + t.id + '">Borrar</button></td></tr>'));
  }
  const pv = await api('/api/admin/precios/vendedor');
  if (pv && pv.ok) {
    $('#listaVend').innerHTML = tabla(['Vendedor', 'BIN', 'Precio', ''], (pv.precios || []).map((p) =>
      '<tr><td>' + esc(p.usuario || '#' + p.usuario_id) + '</td><td>' + (p.bin || 'todos') + '</td><td>$ ' + num(p.precio) + '</td>'
      + '<td><button class="peligro mini" data-borrar-pv="' + p.usuario_id + '" data-pv-bin="' + (p.bin || '') + '">Borrar</button></td></tr>'));
  }
}

/* -------------------------------- usuarios -------------------------------- */
async function cargarUsuarios() {
  const altas = await api('/api/admin/vendedores?estado=pendiente');
  const la = (altas && altas.vendedores) || [];
  $('#altas').innerHTML = tabla(['Usuario', 'Nombre', 'DNI', 'Teléfono', 'Alias/CBU', ''], la.map((v) =>
    '<tr><td><b>' + esc(v.usuario) + '</b></td><td>' + esc(v.nombre) + '</td><td>' + esc(v.dni) + '</td><td>' + esc(v.telefono) + '</td><td>' + esc(v.alias_cbu) + '</td>'
    + '<td><button class="mini" data-alta="' + v.usuario_id + '">Aprobar</button> <button class="peligro mini" data-rechazar="' + v.usuario_id + '">Rechazar</button></td></tr>'));

  const recs = await api('/api/admin/recargas?estado=pendiente');
  const lr = (recs && recs.recargas) || [];
  $('#recargas').innerHTML = tabla(['#', 'Vendedor', 'Monto', 'Comprobante', ''], lr.map((r) =>
    '<tr><td>#' + r.id + '</td><td>' + esc(r.usuario) + '</td><td><b>$ ' + num(r.monto) + '</b></td>'
    + '<td>' + esc(r.comprobante || '-') + (r.archivo ? ' · <a target="_blank" href="/api/recargas/' + r.id + '/comprobante">archivo</a>' : '') + '</td>'
    + '<td><button class="mini" data-recarga="' + r.id + '">Aprobar</button> <button class="peligro mini" data-recrec="' + r.id + '">Rechazar</button></td></tr>'));

  const inv = await api('/api/admin/invitaciones?n=20');
  const li = (inv && inv.invitaciones) || [];
  $('#invLista').innerHTML = tabla(['#', 'Creada', 'Vence', 'Estado', 'Usada por'], li.map((i) =>
    '<tr><td>' + i.id + '</td><td>' + esc(fecha(i.creado)) + '</td><td>' + esc(fecha(i.expira)) + '</td>'
    + '<td>' + (i.usado ? badge('usada') : (String(i.expira) < new Date().toISOString() ? badge('vencida') : badge('pendiente'))) + '</td>'
    + '<td>' + esc(i.usado_por_usuario || '-') + '</td></tr>'));

  const us = await api('/api/admin/usuarios');
  USUARIOS = (us && us.usuarios) || [];
  const opciones = ['<option value="">Elegí un vendedor</option>']
    .concat(USUARIOS.filter((u) => u.rol === 'vendedor').map((u) => '<option value="' + u.id + '">' + esc(u.usuario) + '</option>'));
  $('#pv_user').innerHTML = opciones.join('');
  $('#usuarios').innerHTML = tabla(['Usuario', 'Rol', 'Estado', '2FA', 'Telegram', 'Saldo', ''], USUARIOS.map((u) =>
    '<tr><td><b>' + esc(u.usuario) + '</b><div class="sub">' + esc(u.nombre) + '</div></td><td>' + esc(u.rol) + '</td>'
    + '<td>' + badge(u.estado) + '</td><td>' + (u.totp_activo ? 'sí' : 'no') + '</td><td>' + esc(u.telegram_id || '-') + '</td>'
    + '<td>' + (u.vendedor ? '$ ' + num(u.vendedor.saldo) : '-') + '</td>'
    + '<td><button class="sec mini" data-estado="' + u.id + '" data-valor="' + (u.estado === 'activo' ? 'suspendido' : 'activo') + '">'
    + (u.estado === 'activo' ? 'Suspender' : 'Activar') + '</button> '
    + (u.rol === 'vendedor' ? '<button class="sec mini" data-saldo="' + u.id + '" data-nombre="' + esc(u.usuario) + '">Saldo</button> ' : '')
    + '<button class="sec mini" data-clave="' + u.id + '" data-nombre="' + esc(u.usuario) + '">Reset clave</button></td></tr>'));
}

/* ------------------------------- auditoría -------------------------------- */
async function cargarAuditoria() {
  const j = await api('/api/admin/auditoria?n=200');
  const l = (j && j.auditoria) || [];
  $('#auditoria').innerHTML = tabla(['#', 'Fecha', 'Usuario', 'Acción', 'Entidad', 'Detalle', 'IP'], l.map((a) =>
    '<tr><td>' + a.id + '</td><td>' + esc(fecha(a.creado)) + '</td><td>' + esc(a.usuario || '-') + '</td>'
    + '<td>' + esc(a.accion) + '</td><td>' + esc(a.entidad || '') + ' ' + esc(a.entidad_id || '') + '</td>'
    + '<td class="sub">' + esc(a.detalle || '') + '</td><td>' + esc(a.ip || '') + '</td></tr>'));
}

async function cargarLotes() {
  const j = await api('/api/admin/lotes?n=100');
  const l = (j && j.lotes) || [];
  $('#lotes').innerHTML = tabla(['#', 'Nombre', 'Total', 'OK', 'Dup', 'Inválidas', 'Estado', 'Creado'], l.map((x) =>
    '<tr><td>' + x.id + '</td><td>' + esc(x.nombre || '-') + '</td><td>' + x.total + '</td><td>' + x.ok + '</td>'
    + '<td>' + x.duplicadas + '</td><td>' + x.invalidas + '</td><td>' + badge(x.estado) + '</td><td>' + esc(fecha(x.creado)) + '</td></tr>'));
}

/* --------------------------------- checker -------------------------------- */
async function cargarChecker() {
  const j = await api('/api/admin/checker?n=100');
  if (!j || !j.ok) return;
  $('#ch_prov').textContent = j.proveedor || '—';
  $('#ch_cola').textContent = j.cola_pendiente || 0;
  $('#ch_sin').textContent = j.sin_verificar || 0;
  $('#ch_cola_tabla').innerHTML = tabla(['#', 'CC', 'BIN', 'Lote', 'Intentos', 'Motivo'], (j.cola || []).map((q) =>
    '<tr><td>' + q.id + '</td><td>' + esc(q.codigo || '#' + q.cc_id) + '<div class="sub">' + esc(q.numero_mask) + '</div></td>'
    + '<td>' + esc(q.bin || '') + '</td><td>' + esc(q.lote_id || '-') + '</td><td>' + q.intentos + '</td><td class="sub">' + esc(q.motivo || '') + '</td></tr>'));
  $('#ch_tarjetas').innerHTML = tabla(['CC', 'BIN', 'Estado', 'Intentos', ''], (j.tarjetas || []).map((c) =>
    '<tr><td>' + esc(c.codigo || '#' + c.id) + '<div class="sub">' + esc(c.numero_mask) + '</div></td><td>' + esc(c.bin) + '</td>'
    + '<td>' + esc(c.estado) + '</td><td>' + (c.verif_intentos || 0) + '</td>'
    + '<td><button class="ok mini" data-ch-cc="' + c.id + '" data-ch-estado="ok">OK</button> '
    + '<button class="peligro mini" data-ch-cc="' + c.id + '" data-ch-estado="falla">Falla</button></td></tr>'));
  $('#ch_resultados').innerHTML = tabla(['#', 'Fecha', 'CC', 'Proveedor', 'Estado', 'Motivo'], (j.resultados || []).map((r) =>
    '<tr><td>' + r.id + '</td><td>' + esc(fecha(r.creado)) + '</td><td>' + esc(r.codigo || '#' + r.cc_id) + ' <span class="sub">' + esc(r.numero_mask) + '</span></td>'
    + '<td>' + esc(r.proveedor) + '</td><td>' + badge(r.estado) + '</td><td class="sub">' + esc(r.motivo || '') + '</td></tr>'));
}

/* --------------------------------- eventos -------------------------------- */
navTabs();
function navTabs() {
  document.querySelectorAll('nav.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('nav.tabs button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      document.querySelectorAll('.vista').forEach((v) => v.classList.remove('on'));
      document.getElementById('v-' + b.dataset.v).classList.add('on');
    });
  });
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#btnPedidos')) { cargarPedidos(); return; }
  if (e.target.closest('#btnInv')) {
    const j = await api('/api/admin/invitaciones', { dias: Number($('#inv_dias').value) || 7, nota: $('#inv_nota').value.trim() });
    if (!j || !j.ok) return decir('#msgInv', (j && j.error) || 'Error');
    $('#invHecha').innerHTML = '<p style="margin-top:10px"><span class="codigo">' + esc(j.codigo) + '</span> '
      + '<a href="/registro?codigo=' + encodeURIComponent(j.codigo) + '" target="_blank">link de alta</a></p>';
    decir('#msgInv', 'Invitación creada (se muestra una sola vez).', true);
    cargarUsuarios(); return;
  }
  if (e.target.closest('#btnPb')) {
    const j = await api('/api/admin/precio/base', { bin: $('#pb_bin').value.trim(), precio: Number($('#pb_precio').value) });
    decir('#msgPb', j && j.ok ? 'Precio base guardado.' : ('Error: ' + (j && j.error)), j && j.ok);
    cargarPrecios(); return;
  }
  if (e.target.closest('#btnPt')) {
    const hasta = $('#pt_hasta').value;
    const j = await api('/api/admin/precios/tramos', { bin: $('#pt_bin').value.trim(), desde: Number($('#pt_desde').value), hasta: hasta === '' ? null : Number(hasta), precio: Number($('#pt_precio').value) });
    decir('#msgPt', j && j.ok ? 'Tramo guardado.' : ('Error: ' + (j && j.error)), j && j.ok);
    cargarPrecios(); return;
  }
  if (e.target.closest('#btnPv')) {
    const j = await api('/api/admin/precios/vendedor', { usuario_id: Number($('#pv_user').value), bin: $('#pv_bin').value.trim(), precio: Number($('#pv_precio').value) });
    decir('#msgPv', j && j.ok ? 'Precio del vendedor guardado.' : ('Error: ' + (j && j.error)), j && j.ok);
    cargarPrecios(); return;
  }
  if (e.target.closest('#btnChLote')) {
    const lote = Number($('#ch_lote').value);
    if (!lote) return decir('#msgCh', 'Ingresá el ID del lote.');
    const j = await api('/api/admin/checker/lote', { lote_id: lote });
    decir('#msgCh', j && j.ok ? ('Lote ' + lote + ': ' + j.encoladas + ' encoladas de ' + j.total + '.') : ('Error: ' + (j && j.error)), j && j.ok);
    cargarChecker(); return;
  }
  if (e.target.closest('#btnChProc')) {
    const j = await api('/api/admin/checker/procesar', { n: 20 });
    decir('#msgCh', j && j.ok ? (j.manual ? 'Proveedor manual: marcá las tarjetas abajo.' : ('Procesados: ' + j.procesados + ' · pendientes: ' + j.pendientes)) : ('Error: ' + (j && j.error)), j && j.ok);
    cargarChecker(); return;
  }
  const ch = e.target.closest('[data-ch-cc]');
  if (ch) {
    const motivo = prompt('Motivo de la verificación (' + ch.dataset.chEstado + '):') || '';
    const j = await api('/api/admin/checker/cc/' + ch.dataset.chCc, { estado: ch.dataset.chEstado, motivo });
    decir('#msgCh', j && j.ok ? 'Verificación registrada.' : ('Error: ' + (j && j.error)), j && j.ok);
    cargarChecker(); return;
  }
  const bt = e.target.closest('[data-borrar-tramo]');
  if (bt) { await api('/api/admin/precios/tramos/' + bt.dataset.borrarTramo + '/borrar', {}); cargarPrecios(); return; }
  const bp = e.target.closest('[data-borrar-pv]');
  if (bp) { await api('/api/admin/precios/vendedor', { usuario_id: Number(bp.dataset.borrarPv), bin: bp.dataset.pvBin, precio: 0 }); cargarPrecios(); return; }

  const rec = e.target.closest('[data-rec]');
  if (rec) {
    const accion = rec.dataset.accion;
    const nota = prompt(accion === 'rechazar' ? 'Motivo del rechazo (opcional):' : 'Nota (opcional):') || '';
    const j = await api('/api/admin/reclamos/' + rec.dataset.rec + '/resolver', { accion, nota });
    if (!j || !j.ok) decir('#msgReclamo', j && j.error === 'sin_stock' ? 'No hay stock del mismo BIN. Elegí devolución.' : ('Error: ' + (j && j.error)), false);
    else decir('#msgReclamo', 'Reclamo resuelto: ' + j.resolucion + (j.reemplazo ? ' · código ' + j.reemplazo.codigo : ''), true);
    cargarReclamos(); cargarResumen(); return;
  }
  const a = e.target.closest('[data-alta]');
  if (a) { const j = await api('/api/admin/vendedores/' + a.dataset.alta + '/revisar', { aprobar: true }); decir('#msgAlta', j && j.ok ? 'Aprobado.' : ('Error: ' + (j && j.error)), j && j.ok); cargarUsuarios(); return; }
  const r = e.target.closest('[data-rechazar]');
  if (r) { if (!confirm('¿Rechazar el alta?')) return; const j = await api('/api/admin/vendedores/' + r.dataset.rechazar + '/revisar', { aprobar: false }); decir('#msgAlta', j && j.ok ? 'Rechazado.' : ('Error: ' + (j && j.error)), j && j.ok); cargarUsuarios(); return; }
  const rr = e.target.closest('[data-recarga]');
  if (rr) { const nota = prompt('Nota (opcional):') || ''; const j = await api('/api/admin/recargas/' + rr.dataset.recarga + '/revisar', { aprobar: true, nota }); decir('#msgRec', j && j.ok ? 'Recarga acreditada.' : ('Error: ' + (j && j.error)), j && j.ok); cargarUsuarios(); cargarResumen(); return; }
  const rx = e.target.closest('[data-recrec]');
  if (rx) { const nota = prompt('Motivo:') || ''; const j = await api('/api/admin/recargas/' + rx.dataset.recrec + '/revisar', { aprobar: false, nota }); decir('#msgRec', j && j.ok ? 'Rechazada.' : ('Error: ' + (j && j.error)), j && j.ok); cargarUsuarios(); return; }
  const clv = e.target.closest('[data-clave]');
  if (clv) {
    const nueva = prompt('Nueva clave para ' + clv.dataset.nombre + ' (vacío = generar):');
    if (nueva === null) return;
    const j = await api('/api/admin/usuarios/' + clv.dataset.clave + '/clave', { nueva });
    if (j && j.ok) alert('Clave nueva de ' + j.usuario + ': ' + j.clave + '\nGuardala ahora; no se vuelve a mostrar.');
    else decir('#msgUsr', 'Error: ' + (j && j.error), false);
    return;
  }
  const est = e.target.closest('[data-estado]');
  if (est) { const j = await api('/api/admin/usuarios/' + est.dataset.estado + '/estado', { estado: est.dataset.valor }); decir('#msgUsr', j && j.ok ? 'Estado actualizado.' : ('Error: ' + (j && j.error)), j && j.ok); cargarUsuarios(); return; }
  const sal = e.target.closest('[data-saldo]');
  if (sal) {
    const monto = prompt('Monto a acreditar (negativo para debitar) para ' + sal.dataset.nombre + ':');
    if (monto === null) return;
    const nota = prompt('Nota obligatoria:') || '';
    if (!nota.trim()) return decir('#msgUsr', 'La nota es obligatoria.');
    const j = await api('/api/admin/saldo', { usuario_id: Number(sal.dataset.saldo), monto: Number(monto), nota });
    decir('#msgUsr', j && j.ok ? ('Saldo nuevo: $ ' + num(j.saldo)) : ('Error: ' + (j && j.error)), j && j.ok);
    cargarUsuarios(); cargarResumen(); return;
  }
});

(async function iniciar() {
  const yo = await fetch('/api/auth/yo').then((r) => r.ok ? r.json() : null).catch(() => null);
  if (!yo) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
  CSRF = yo.csrf;
  await Promise.all([cargarResumen(), cargarReclamos(), cargarPedidos(), cargarChecker(), cargarPrecios(), cargarUsuarios(), cargarAuditoria(), cargarAccesos(), cargarLotes()]);
})();
