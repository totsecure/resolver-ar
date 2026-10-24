/* Extraído de mi.html (CSP script-src 'self'). */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let CSRF = '';
let YO = null;

async function api(ruta, cuerpo, metodo) {
  const r = await fetch(ruta, {
    method: metodo || 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, j: j || {} };
}
function decir(sel, texto, ok) {
  const e = $(sel);
  if (!e) return;
  e.textContent = texto || '';
  e.classList.toggle('ok', Boolean(ok));
}
function fmt(f) { return f ? String(f).slice(0, 16).replace('T', ' ') : '—'; }

function pintar() {
  const u = YO.usuario;
  $('#nombre').textContent = u.nombre || u.usuario;
  $('#usuario').textContent = '@' + u.usuario + ' · desde ' + fmt(u.creado);
  $('#rol').textContent = u.rol;
  $('#estado2fa').innerHTML = YO.dosfa.activo
    ? '<span class="badge ok">activo</span>'
    : '<span class="badge warn">sin activar</span>';
  $('#respaldos').textContent = YO.dosfa.activo ? YO.dosfa.respaldos + ' sin usar' : '—';
  $('#btn2fa').classList.toggle('oculto', YO.dosfa.activo);
  $('#tarjetaVendedor').classList.toggle('oculto', u.rol !== 'vendedor');
  if (u.rol === 'admin' || u.rol === 'operador') {
    $('#accionesAdmin').innerHTML = '<a href="/panel/"><button>Ir al panel</button></a>';
  }
  $('#forzado').classList.toggle('oculto', !YO.debeConfigurar2fa);
  if (YO.debeConfigurar2fa) iniciarSetupForzado();
}

async function cargar() {
  const r = await fetch('/api/auth/yo');
  if (!r.ok) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
  YO = await r.json();
  CSRF = YO.csrf;
  pintar();
  cargarSesiones();
  cargarTokens();
  cargarVendedor();
  cargarTelegram();
}

async function cargarTelegram() {
  const { j } = await api('/api/telegram/estado', null, 'GET');
  if (!j || !j.ok) return;
  $('#tgEstado').innerHTML = j.vinculado
    ? '<span class="badge ok">vinculado</span>'
    : '<span class="badge warn">sin vincular</span>';
  $('#btnTg').textContent = j.vinculado ? 'Generar otro código' : 'Generar código';
}

async function generarTg() {
  const { j } = await api('/api/telegram/vincular', {});
  if (!j || !j.ok) return decir('#msgTg', 'No pudimos generar el código.');
  $('#tgCodigo').classList.remove('oculto');
  $('#tgCodigo').innerHTML = '<b style="font-size:19px">' + esc(j.codigo) + '</b><br><span class="sub">Mandá al bot: /vincular ' + esc(j.codigo) + ' · vence ' + esc(String(j.expira).slice(11, 16)) + ' UTC</span>';
  decir('#msgTg', 'Código generado. Se usa una sola vez.', true);
}

async function desvincularTg() {
  const { j } = await api('/api/telegram/desvincular', {});
  if (!j || !j.ok) return decir('#msgTg', 'No se pudo desvincular.');
  $('#tgCodigo').classList.add('oculto');
  decir('#msgTg', 'Chat desvinculado.', true);
  cargarTelegram();
}

async function cargarVendedor() {
  if (!YO || YO.usuario.rol !== 'vendedor') return;
  const { j } = await api('/api/vendedor/perfil', null, 'GET');
  if (!j || !j.ok || !j.perfil) return;
  const p = j.perfil;
  $('#saldoVend').textContent = '$ ' + Number(j.saldo || 0).toLocaleString('es-AR');
  $('#limiteDia').textContent = p.limite_reservas_dia + ' por día';
  $('#limiteSim').textContent = p.limite_simultaneas + ' a la vez';
}

async function cargarTokens() {
  const { j } = await api('/api/tokens', null, 'GET');
  if (!j || !j.ok) return;
  $('#listaTokens').innerHTML = (j.tokens || []).map((t) =>
    '<div class="fila"><span class="k">' + esc(t.nombre || 'sin nombre') + ' · ' + esc(t.prefijo || '') + ' · ' + esc(fmt(t.creado)) + (t.revocado ? ' · revocado' : '') + '</span>'
    + (t.revocado ? '' : '<button class="sec" data-token-revocar="' + t.id + '">Revocar</button>') + '</div>').join('')
    || '<p class="sub">Sin tokens.</p>';
}

async function crearToken() {
  const nombre = ($('#token_nombre')?.value || '').trim();
  const { j } = await api('/api/tokens', { nombre });
  if (!j || !j.ok) return decir('#msgToken', j.error || 'No se pudo crear.', false);
  $('#tokenNuevo').classList.remove('oculto');
  $('#tokenNuevo').innerHTML = '<b style="user-select:all;word-break:break-all">' + esc(j.token) + '</b><p class="sub">Copialo ahora; no se vuelve a mostrar.</p>';
  $('#token_nombre').value = '';
  decir('#msgToken', 'Token creado.', true);
  cargarTokens();
}

async function cargarSesiones() {
  const { j } = await api('/api/auth/sesiones', null, 'GET');
  const filas = j.sesiones || [];
  $('#sesiones').innerHTML = filas.map((s) =>
    '<tr><td>' + esc(fmt(s.creado)) + '</td><td>' + esc(s.ip || '—') + '</td><td>' + esc(fmt(s.expira)) +
    '</td><td><button class="sec" data-revocar="' + esc(s.id) + '">Cerrar</button></td></tr>').join('')
    || '<tr><td colspan="4" class="sub">Sin sesiones.</td></tr>';
}

async function iniciarSetupForzado() {
  if ($('#secretoForzado').textContent) return;
  const { j } = await api('/api/auth/2fa/iniciar', {});
  if (!j.ok) { decir('#msgForzado', 'No pudimos iniciar el 2FA. Recargá la página.'); return; }
  $('#secretoForzado').textContent = j.manual || j.secreto;
  $('#otpauthForzado').href = j.otpauth;
}

async function iniciarSetup() {
  if ($('#secreto').textContent) { $('#caja2fa').classList.remove('oculto'); return; }
  const { j } = await api('/api/auth/2fa/iniciar', {});
  if (!j.ok) return decir('#msg2fa', j.error === 'ya_activo' ? 'El 2FA ya está activo.' : 'No pudimos iniciar.');
  $('#secreto').textContent = j.manual || j.secreto;
  $('#otpauth').href = j.otpauth;
  $('#caja2fa').classList.remove('oculto');
  $('#codigo').focus();
}

async function activar() {
  const codigo = $('#codigo').value.trim();
  const { j } = await api('/api/auth/2fa/activar', { codigo });
  if (!j.ok) return decir('#msg2fa', 'Código incorrecto.');
  $('#cajaRespaldos').classList.remove('oculto');
  $('#cajaRespaldos').innerHTML = (j.respaldo || []).map((c) => '<span>' + esc(c) + '</span>').join('');
  decir('#msg2fa', '2FA activado. Guardá los códigos de respaldo.', true);
  setTimeout(cargar, 1200);
}

async function activarForzado() {
  const codigo = $('#codigoForzado').value.trim();
  const { j } = await api('/api/auth/2fa/activar', { codigo });
  if (!j.ok) return decir('#msgForzado', 'Código incorrecto.');
  location.reload();
}

async function regenerarRespaldos() {
  const clave = prompt('Contraseña actual:');
  if (clave === null) return;
  const codigo = prompt('Código TOTP actual o un código de respaldo:');
  if (codigo === null) return;
  const { j } = await api('/api/auth/2fa/respaldos', { clave, codigo });
  if (!j || !j.ok) {
    const m = { clave: 'Contraseña incorrecta.', codigo: 'Código incorrecto.', '2fa_inactivo': 'El 2FA no está activo.' };
    return decir('#msgResp', m[j && j.error] || 'No se pudieron regenerar.');
  }
  $('#cajaRespaldos2').classList.remove('oculto');
  $('#cajaRespaldos2').innerHTML = (j.respaldo || []).map((c) => '<span>' + esc(c) + '</span>').join('');
  decir('#msgResp', 'Códigos nuevos. Los anteriores ya no sirven: guardalos.', true);
  cargar();
}

async function guardarClave() {
  const actual = $('#actual').value;
  const nueva = $('#nueva').value;
  if (nueva.length < 8) return decir('#msgClave', 'La nueva debe tener al menos 8 caracteres.');
  const { j } = await api('/api/auth/clave', { actual, nueva });
  if (!j.ok) return decir('#msgClave', j.error === 'clave_actual' ? 'La contraseña actual no coincide.' : (j.error || 'Error.'));
  decir('#msgClave', 'Listo. Volvé a entrar con la nueva contraseña.', true);
  setTimeout(() => { location.href = '/login'; }, 1200);
}

async function salir() {
  await api('/api/auth/logout', {});
  location.href = '/login';
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#salir')) return salir();
  if (e.target.closest('#btn2fa')) return iniciarSetup();
  if (e.target.closest('#btnRespaldos')) return regenerarRespaldos();
  if (e.target.closest('#btnActivar')) return activar();
  if (e.target.closest('#btnForzado')) return activarForzado();
  if (e.target.closest('#btnClave')) { $('#cajaClave').classList.toggle('oculto'); return; }
  if (e.target.closest('#btnGuardarClave')) return guardarClave();
  if (e.target.closest('#btnToken')) return crearToken();
  const tr = e.target.closest('[data-token-revocar]');
  if (tr) { await api('/api/tokens/' + tr.dataset.tokenRevocar + '/revocar', {}); cargarTokens(); return; }
  if (e.target.closest('#btnTg')) return generarTg();
  if (e.target.closest('#btnTgOff')) return desvincularTg();
  const rev = e.target.closest('[data-revocar]');
  if (rev) {
    await api('/api/auth/sesiones/revocar', { id: Number(rev.dataset.revocar) });
    cargarSesiones();
  }
});

cargar();
