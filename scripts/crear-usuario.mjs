#!/usr/bin/env node
/* crear-usuario.mjs — alta y mantenimiento de cuentas (CLI, sin deps).
 *
 *   node scripts/crear-usuario.mjs --listar
 *   node scripts/crear-usuario.mjs admin --rol admin --nombre "Dueño"
 *   node scripts/crear-usuario.mjs vendedor1 --rol vendedor --clave "unaClaveLarga"
 *   node scripts/crear-usuario.mjs admin --clave-nueva
 *   node scripts/crear-usuario.mjs admin --reset-2fa
 *   node scripts/crear-usuario.mjs admin --estado suspendido|activo
 *
 * Si no se pasa --clave, genera una aleatoria y la imprime UNA vez.
 */
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opciones = {};
const posicionales = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const clave = a.slice(2);
    const siguiente = args[i + 1];
    if (siguiente && !siguiente.startsWith('--')) { opciones[clave] = siguiente; i++; }
    else opciones[clave] = true;
  } else posicionales.push(a);
}

const auth = await import('../lib/auth.js');
auth.migrar();

function claveAleatoria() {
  return crypto.randomBytes(9).toString('base64url');
}

if (opciones.listar) {
  const lista = auth.listarUsuarios();
  if (!lista.length) console.log('(sin usuarios)');
  for (const u of lista) {
    console.log([u.id, u.usuario, u.rol, u.estado, u.totp_activo ? '2fa' : '-', u.ultimo_login || '-'].join('  '));
  }
  process.exit(0);
}

const usuario = posicionales[0];
if (!usuario) {
  console.error('uso: node scripts/crear-usuario.mjs <usuario> [--rol admin|operador|vendedor|checker] [--clave ...]');
  console.error('     node scripts/crear-usuario.mjs --listar');
  process.exit(1);
}

try {
  const existente = auth.listarUsuarios().find((u) => u.usuario === usuario.toLowerCase());

  if (opciones['reset-2fa']) {
    if (!existente) throw new Error('usuario inexistente');
    const { base } = await import('../lib/stock.js');
    base().prepare('UPDATE usuarios SET totp_secret=NULL, totp_pendiente=NULL, totp_activo=0 WHERE id=?').run(existente.id);
    base().prepare('DELETE FROM totp_respaldo WHERE usuario_id=?').run(existente.id);
    auth.audit(existente.id, '2FA_RESET_CLI', 'usuario', existente.id, null, 'cli');
    console.log('2FA desactivado para ' + existente.usuario + '. Al entrar, admin/operador deberán activarlo de nuevo.');
    process.exit(0);
  }

  if (opciones['clave-nueva']) {
    if (!existente) throw new Error('usuario inexistente');
    const clave = typeof opciones['clave-nueva'] === 'string' ? opciones['clave-nueva'] : (opciones.clave || claveAleatoria());
    auth.actualizarClave(existente.id, clave);
    auth.audit(existente.id, 'CLAVE_RESET_CLI', 'usuario', existente.id, null, 'cli');
    console.log('clave actualizada para ' + existente.usuario);
    console.log('CLAVE: ' + clave);
    process.exit(0);
  }

  if (opciones.estado) {
    if (!existente) throw new Error('usuario inexistente');
    auth.setEstado(existente.id, String(opciones.estado));
    console.log('estado de ' + existente.usuario + ': ' + opciones.estado);
    process.exit(0);
  }

  if (existente) throw new Error('usuario ya existe (usá --clave-nueva)');

  const clave = typeof opciones.clave === 'string' ? opciones.clave : claveAleatoria();
  const u = auth.crearUsuario({
    usuario,
    nombre: typeof opciones.nombre === 'string' ? opciones.nombre : usuario,
    rol: typeof opciones.rol === 'string' ? opciones.rol : 'vendedor',
    clave,
  });
  if (u.rol === 'vendedor') {
    const vend = await import('../lib/vendedores.js');
    const { base } = await import('../lib/stock.js');
    vend.migrar();
    base().prepare(
      'INSERT OR IGNORE INTO vendedores(usuario_id, dni, telefono, alias_cbu, estado, creado) VALUES(?,?,?,?,?,?)'
    ).run(u.id, opciones.dni ? String(opciones.dni) : null, opciones.telefono || null, opciones.alias || null, 'activo', new Date().toISOString());
  }
  console.log('creado id=' + u.id + ' usuario=' + u.usuario + ' rol=' + u.rol);
  console.log('CLAVE: ' + clave);
  if (u.rol === 'admin' || u.rol === 'operador') {
    console.log('2FA obligatorio: se activa en el primer login.');
  }
} catch (e) {
  console.error('ERROR: ' + (e?.message || e));
  process.exit(1);
}
