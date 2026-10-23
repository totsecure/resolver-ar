#!/usr/bin/env node
/* test-h1-h2.mjs — /chk sobre el hook, proveedor de prueba y contrato documentado. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-h12-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.PUBLICAR_DIRECTO = '1';

const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const catalogo = await import('../lib/catalogo.js');
const checker = await import('../lib/checker.js');
const vinculacion = await import('../lib/vinculacion.js');
const vb = await import('../lib/vendedor-bot.js');
const stock = await import('../lib/stock.js');
const { base } = stock;

let OK = 0, FAIL = 0;
const ok = (n, d) => { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); };
const fail = (n, d) => { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); };
const check = (n, c, d) => c ? ok(n, d) : fail(n, d || 'sin detalle');

function sembrar(bin) {
  const d = base(); let n;
  do { n = stock.demoNumero(bin, 16); } while (d.prepare('SELECT 1 FROM cc WHERE numero=?').get(n));
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  return Number(d.prepare('INSERT INTO cc(numero,mes,anio,cvv,bin,marca,estado,precio_num,creado,ref,titular,dni,verif_estado,lote) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(n, '12', '2028', '321', bin, 'Visa', 'DISPONIBLE', 100, new Date().toISOString(), ref, 'Titular Test', '30111222', 'sin_verificar', 'TEST').lastInsertRowid);
}
function alta(usuario, dni) {
  const inv = vendedores.crearInvitacion({ creadoPor: 1 });
  vendedores.registrar({ codigo: inv.codigo, usuario, clave: 'clave' + usuario + '1', nombre: usuario, dni, telefono: '11555', alias_cbu: usuario + '.alias' });
  const v = vendedores.listar({ estado: 'pendiente' }).find((x) => x.usuario === usuario);
  vendedores.revisarAlta(v.usuario_id, 1, true);
  return v.usuario_id;
}

console.log('TEST H — ' + new Date().toISOString());
auth.migrar(); wallet.migrar(); vendedores.migrar(); catalogo.migrar(); checker.migrar();
try {
  auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdminH1' });
  const uid = alta('test_hvend', '40111222');
  wallet.acreditar(uid, 1000, 'carga');
  const cc = sembrar('411111');
  const r = catalogo.reservar(uid, { refs: [cc] });
  check('H1 reserva para chk', r.ok === true);
  check('H2 proveedores manual/prueba', checker.proveedoresDisponibles().includes('manual') && checker.proveedoresDisponibles().includes('prueba'), checker.proveedoresDisponibles().join(','));

  const resPrueba = await checker.verificar(cc, { proveedor: 'prueba' });
  check('H1 hook con proveedor de prueba', ['ok', 'falla'].includes(resPrueba.estado) && resPrueba.proveedor === 'prueba', JSON.stringify(resPrueba));
  check('H1 resultado persistido', base().prepare('SELECT COUNT(*) n FROM checker_resultados WHERE cc_id=?').get(cc).n >= 1);

  const chat = 99002;
  vb.vincular(chat, vinculacion.generar(uid).codigo);
  const out = await vb.chk(chat, r.grupo);
  check('H1 /chk devuelve resultado', out.ok && /CHECKER/.test(out.texto) && /manual|prueba|pendiente|ok|falla/.test(out.texto), out.texto.split('\n')[0]);
  check('H2 contrato documentado', fs.existsSync(path.join(import.meta.dirname, '..', 'docs', 'CHECKER.md')));
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
