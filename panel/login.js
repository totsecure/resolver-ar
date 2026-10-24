/* login.js — lógica del login del panel (extraída de login.html).
 *
 * El HTML no lleva <script> inline porque el CSP del server usa
 * script-src 'self' (sin unsafe-inline). Si se toca este archivo,
 * login.html sólo lo referencia con <script src="/panel/login.js" defer>.
 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const Q = new URLSearchParams(location.search);
  const NEXT = Q.get('next') || '';
  let CSRF = sessionStorage.getItem('csrf') || '';
  let DEBE_SETUP = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function ver(id) {
    ['vistaLogin', 'vista2fa', 'vistaSetup', 'vistaRespaldo'].forEach((v) => {
      document.getElementById(v).classList.toggle('oculto', v !== id);
    });
  }
  function decir(sel, texto, ok) {
    const e = $(sel);
    if (!e) return;
    e.textContent = texto || '';
    e.classList.toggle('ok', Boolean(ok));
  }
  function destino(rol) {
    if (NEXT && NEXT.startsWith('/')) return NEXT;
    return (rol === 'admin' || rol === 'operador') ? '/panel/' : '/mi';
  }
  async function api(ruta, cuerpo) {
    const r = await fetch(ruta, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
      body: JSON.stringify(cuerpo || {}),
    });
    let j = null;
    try { j = await r.json(); } catch (_) {}
    return { status: r.status, j: j || {} };
  }
  async function prepararCsrf() {
    if (CSRF) return;
    const r = await fetch('/api/auth/csrf');
    const j = await r.json();
    CSRF = j.csrf || '';
    sessionStorage.setItem('csrf', CSRF);
  }

  async function entrar() {
    const usuario = $('#usuario').value.trim();
    const clave = $('#clave').value;
    if (!usuario || !clave) return decir('#msg', 'Completá usuario y contraseña.');
    $('#btnEntrar').disabled = true;
    decir('#msg', '');
    try {
      await prepararCsrf();
      const { status, j } = await api('/api/auth/login', { usuario, clave });
      if (!j.ok) {
        decir('#msg', j.detalle || j.error || 'No pudimos entrar.');
        $('#btnEntrar').disabled = false;
        return;
      }
      CSRF = j.csrf || CSRF;
      sessionStorage.setItem('csrf', CSRF);
      if (j.necesita2fa) {
        $('#clave').value = '';
        ver('vista2fa');
        $('#codigo2fa').focus();
        return;
      }
      DEBE_SETUP = Boolean(j.debeConfigurar2fa);
      if (DEBE_SETUP) return iniciarSetup();
      location.href = destino(j.usuario.rol);
    } catch (e) {
      decir('#msg', 'Error de red.');
      $('#btnEntrar').disabled = false;
    }
  }

  async function verificar2fa() {
    const codigo = $('#codigo2fa').value.trim();
    if (!codigo) return decir('#msg2', 'Ingresá el código.');
    $('#btn2fa').disabled = true;
    const { j } = await api('/api/auth/2fa', { codigo });
    if (!j.ok) {
      decir('#msg2', 'Código incorrecto o vencido.');
      $('#btn2fa').disabled = false;
      return;
    }
    const yo = await fetch('/api/auth/yo').then((r) => r.json()).catch(() => null);
    DEBE_SETUP = Boolean(yo && yo.debeConfigurar2fa);
    if (DEBE_SETUP) return iniciarSetup();
    location.href = destino(yo && yo.usuario ? yo.usuario.rol : 'vendedor');
  }

  async function iniciarSetup() {
    ver('vistaSetup');
    $('#setupPista').textContent = 'El rol que tenés exige segundo factor. Agregá este secreto a Google Authenticator, Authy o 1Password y confirmá el código.';
    const { j } = await api('/api/auth/2fa/iniciar', {});
    if (!j.ok) {
      decir('#msg3', j.error === 'ya_activo' ? 'El 2FA ya está activo. Volvé a entrar.' : 'No pudimos iniciar el 2FA.');
      return;
    }
    $('#secreto').textContent = j.manual || j.secreto;
    $('#otpauth').href = j.otpauth;
    $('#codigoSetup').focus();
  }

  async function activar2fa() {
    const codigo = $('#codigoSetup').value.trim();
    if (!codigo) return decir('#msg3', 'Ingresá el código de 6 dígitos.');
    $('#btnActivar').disabled = true;
    const { j } = await api('/api/auth/2fa/activar', { codigo });
    if (!j.ok) {
      decir('#msg3', j.error === 'sin_setup' ? 'La sesión de setup venció: recargá.' : 'Código incorrecto. Probá de nuevo.');
      $('#btnActivar').disabled = false;
      return;
    }
    $('#respaldos').innerHTML = (j.respaldo || []).map((c) => '<span>' + esc(c) + '</span>').join('');
    ver('vistaRespaldo');
  }

  async function arrancar() {
    $('#pie').textContent = 'resolver-ar · ' + new Date().getFullYear();
    try {
      const r = await fetch('/api/auth/yo');
      if (r.ok) {
        const yo = await r.json();
        if (yo.paso2fa) { ver('vista2fa'); return; }
        if (yo.debeConfigurar2fa) return iniciarSetup();
        location.href = destino(yo.usuario.rol);
        return;
      }
    } catch (_) {}
    ver('vistaLogin');
  }

  $('#btnEntrar').addEventListener('click', entrar);
  $('#clave').addEventListener('keydown', (e) => { if (e.key === 'Enter') entrar(); });
  $('#btn2fa').addEventListener('click', verificar2fa);
  $('#codigo2fa').addEventListener('keydown', (e) => { if (e.key === 'Enter') verificar2fa(); });
  $('#btnActivar').addEventListener('click', activar2fa);
  $('#codigoSetup').addEventListener('keydown', (e) => { if (e.key === 'Enter') activar2fa(); });
  $('#btnVolver').addEventListener('click', async () => {
    try { await api('/api/auth/logout', {}); } catch (_) {}
    sessionStorage.removeItem('csrf');
    location.href = '/login';
  });
  $('#btnSeguir').addEventListener('click', () => { location.href = destino('admin'); });
  arrancar();
})();
