#!/usr/bin/env node
/* test-d1-d4.mjs — pedidos como entidad, links de un solo uso, historial y comprobante. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-d14-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.VENTANA_MIN = '15';
process.env.PUBLICAR_DIRECTO = '1';

const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const catalogo = await import('../lib/catalogo.js');
const pedidos = await import('../lib/pedidos.js');
const stock = await import('../lib/stock.js');
const { base } = stock;

let OK = 0, FAIL = 0;
const ok = (n, d) => { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); };
const fail = (n, d) => { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); };
const check = (n, c, d) => c ? ok(n, d) : fail(n, d || 'sin detalle');

function sembrar(bin) {
  const d = base();
  let n;
  do { n = stock.demoNumero(bin, 16); } while (d.prepare('SELECT 1 FROM cc WHERE numero=?').get(n));
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  return Number(d.prepare(
    'INSERT INTO cc(numero,mes,anio,cvv,bin,marca,estado,precio_num,creado,ref,titular,dni,banco,verif_estado) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(n, '12', '2028', '321', bin, 'Visa', 'DISPONIBLE', 100, new Date().toISOString(), ref, 'Titular Test', '30123456', 'Banco Test', 'sin_verificar').lastInsertRowid);
}
function alta(usuario, dni) {
  const inv = vendedores.crearInvitacion({ creadoPor: 1 });
  vendedores.registrar({ codigo: inv.codigo, usuario, clave: 'clave' + usuario + '1', nombre: usuario, dni, telefono: '11555', alias_cbu: usuario + '.alias' });
  const v = vendedores.listar({ estado: 'pendiente' }).find((x) => x.usuario === usuario);
  vendedores.revisarAlta(v.usuario_id, 1, true);
  return v.usuario_id;
}

console.log('TEST D — ' + new Date().toISOString());
auth.migrar(); wallet.migrar(); vendedores.migrar(); catalogo.migrar(); pedidos.migrar();
try {
  auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });
  const uid = alta('dventa', '40111222');
  wallet.acreditar(uid, 10000, 'carga');
  const c1 = sembrar('411111');
  const c2 = sembrar('411111');

  const r = catalogo.reservar(uid, { refs: [c1, c2] });
  check('D1 reserva crea pedido', r.ok && r.pedido && r.pedido.codigo && r.pedido.cantidad === 2, JSON.stringify(r.pedido || {}));
  const p = pedidos.obtener(r.pedido.codigo, { usuarioId: uid });
  check('D1 pedido con items y estado', p && p.estado === 'reservado' && p.items.length === 2 && p.total === 200, p && p.estado);
  check('D1 pedido auditado', base().prepare('SELECT COUNT(*) n FROM pedido_eventos WHERE pedido_id=?').get(p.id).n >= 1);

  const linkP = pedidos.consumirPedido(r.pedido.codigo);
  check('D2 link pedido primer uso', linkP.ok && linkP.pedido && linkP.pedido.codigo === r.pedido.codigo);
  const linkP2 = pedidos.consumirPedido(r.pedido.codigo);
  check('D2 link pedido un solo uso', linkP2.ok === false && linkP2.error === 'link_usado');

  const tok = p.items[0].token;
  const linkC = pedidos.consumirTarjeta(tok);
  check('D2 link tarjeta primer uso', linkC.ok && linkC.tarjeta && linkC.tarjeta.numero);
  check('D2 link tarjeta un solo uso', pedidos.consumirTarjeta(tok).error === 'link_usado');

  const hist = pedidos.listar({ usuarioId: uid, estado: 'reservado' });
  check('D3 historial filtrado', hist.length === 1 && hist[0].codigo === r.pedido.codigo);
  check('D3 historial por fecha', pedidos.listar({ usuarioId: uid, desde: '2000-01-01' }).length === 1 && pedidos.listar({ usuarioId: uid, hasta: '2000-01-01' }).length === 0);

  const pag = catalogo.pagar(uid, { grupo: r.grupo });
  const p2 = pedidos.obtener(r.pedido.codigo, { usuarioId: uid });
  check('D1 pago actualiza pedido', pag.ok && p2.estado === 'pagado' && p2.pagado_en);
  const html = pedidos.comprobanteHtml(r.pedido.codigo, { usuarioId: uid });
  check('D4 comprobante HTML', /<!doctype html>/i.test(html) && html.includes(r.pedido.codigo) && /Titular Test|Titular/.test(html));
  check('D4 comprobante ajeno bloqueado', pedidos.comprobanteHtml(r.pedido.codigo, { usuarioId: 999999 }) === null);
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
