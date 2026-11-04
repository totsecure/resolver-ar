/* Extraído de registro.html (CSP script-src 'self'). */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let CSRF = '';
$('#codigo').value = new URLSearchParams(location.search).get('codigo') || '';
if (!$('#codigo').value) $('#sinCodigo').style.display = 'block';

async function preparar() {
  const r = await fetch('/api/auth/csrf');
  const j = await r.json();
  CSRF = j.csrf;
}
function decir(t, ok) { $('#msg').textContent = t; $('#msg').classList.toggle('ok', Boolean(ok)); }

async function crear() {
  const cuerpo = {
    codigo: $('#codigo').value.trim(), usuario: $('#usuario').value.trim(),
    clave: $('#clave').value, nombre: $('#nombre').value.trim(),
    dni: $('#dni').value.trim(), telefono: $('#telefono').value.trim(),
    alias_cbu: $('#alias').value.trim(),
  };
  if (!cuerpo.codigo || !cuerpo.usuario || !cuerpo.clave || !cuerpo.nombre || !cuerpo.dni || !cuerpo.telefono || !cuerpo.alias_cbu) {
    return decir('Completá todos los campos.');
  }
  if (cuerpo.clave.length < 8) return decir('La contraseña debe tener al menos 8 caracteres.');
  $('#btn').disabled = true;
  try {
    if (!CSRF) await preparar();
    const r = await fetch('/api/registro', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
      body: JSON.stringify(cuerpo),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      decir(j.error === 'csrf' ? 'Recargá la página.' : (j.error === 'invitacion invalida o vencida' ? 'La invitación no sirve o ya fue usada.' : (j.error || 'No pudimos crear la cuenta.')));
      $('#btn').disabled = false;
      return;
    }
    $('#formBox').classList.add('oculto');
    $('#okBox').classList.remove('oculto');
    $('#okTexto').textContent = j.mensaje || 'Cuenta creada. Falta la aprobación del administrador.';
  } catch (e) { decir('Error de red.'); $('#btn').disabled = false; }
}

$('#btn').addEventListener('click', crear);
$('#btnIr').addEventListener('click', () => { location.href = '/login'; });
preparar().catch(() => {});
