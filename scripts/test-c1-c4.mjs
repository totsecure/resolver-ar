#!/usr/bin/env node
/* test-c1-c4.mjs — Grupo C: menú, paridad, bloque/conteo y avisos. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-c14-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');
process.env.PUBLICAR_DIRECTO = '1';
process.env.VENTANA_MIN = '15';
process.env.CHECKER_PROVEEDOR = 'manual';

const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const catalogo = await import('../lib/catalogo.js');
const stock = await import('../lib/stock.js');
const vb = await import('../lib/vendedor-bot.js');
const notificaciones = await import('../lib/notificaciones.js');
const recargas = await import('../lib/recargas.js');
const vinculacion = await import('../lib/vinculacion.js');
const { base } = stock;
const { MENU } = await import('../bot/telegram.js');

let OK = 0, FAIL = 0;
const ok = (n, d) => { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); };
const fail = (n, d) => { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); };
const check = (n, c, d) => c ? ok(n, d) : fail(n, d || 'sin detalle');

function sembrar(bin, numero = null) {
  const d = base();
  let n = numero;
  do { n = n || stock.demoNumero(bin, 16); } while (d.prepare('SELECT 1 FROM cc WHERE numero=?').get(n));
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  const id = Number(d.prepare(
    'INSERT INTO cc(numero,mes,anio,cvv,bin,marca,estado,precio_num,creado,ref,titular,dni,banco,verif_estado) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(n, '12', '2028', '321', bin, 'Visa', 'DISPONIBLE', 100, new Date().toISOString(), ref, 'Titular Test', '30123456', 'Banco Test', 'sin_verificar').lastInsertRowid);
  return { id, numero: n };
}
function alta(usuario, dni) {
  const inv = vendedores.crearInvitacion({ creadoPor: 1 });
  vendedores.registrar({ codigo: inv.codigo, usuario, clave: 'clave' + usuario + '1', nombre: usuario, dni, telefono: '11555', alias_cbu: usuario + '.alias' });
  const v = vendedores.listar({ estado: 'pendiente' }).find((x) => x.usuario === usuario);
  vendedores.revisarAlta(v.usuario_id, 1, true);
  return v.usuario_id;
}

console.log('TEST C — ' + new Date().toISOString());
auth.migrar(); wallet.migrar(); vendedores.migrar(); catalogo.migrar(); notificaciones.migrar();
try {
  auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });
  const uid = alta('cventa', '40111222');
  wallet.acreditar(uid, 10000, 'carga');
  const chat = 777;
  vb.vincular(chat, vinculacion.generar(uid).codigo);
  const c = sembrar('411111');
  const v = sembrar('516585');

  /* C1 menú */
  const labels = MENU.inline_keyboard.flat().map((b) => b.text);
  check('C1 menú 5 botones', labels.length === 5 && ['Stock', 'Pedir', 'Mis tarjetas', 'Saldo', 'Ayuda'].every((x) => labels.some((l) => l.includes(x))), labels.join(','));

  /* C2 + C3 comandos y bloque/conteo */
  const st = vb.stock(chat);
  check('C2 /stock', st.ok && /STOCK DISPONIBLE \(\d+ BIN\)/.test(st.texto) && st.texto.includes('411111'), st.texto.split('\n')[0]);
  const bn = vb.bin(chat, '411111');
  check('C2 /bin', bn.ok && /BIN 411111 \(\d+\)/.test(bn.texto) && bn.texto.includes('xxxx'), bn.texto.split('\n')[0]);
  const mis = vb.mis(chat);
  check('C2 /mis', mis.ok && /MIS RESERVAS \(0\)/.test(mis.texto));
  const sal = vb.saldo(chat);
  check('C2 /saldo', sal.ok && sal.texto.includes('SALDO: $10000'));
  const rec = vb.recargar(chat, '1500', 'prueba');
  check('C2 /recargar', rec.ok && rec.texto.includes('Recarga #'));
  const recId = Number(rec.texto.match(/#(\d+)/)[1]);
  const recList = vb.recargar(chat);
  check('C2 /recargar lista', recList.ok && recList.texto.includes('RECARGAS (1)'));

  const r = catalogo.reservar(uid, { refs: [c.id] });
  check('reserva para /chk', r.ok === true);
  const codigo = r.grupo;
  const chk = await vb.chk(chat, codigo);
  check('C2 /chk', chk.ok && /CHECKER/.test(chk.texto) && /manual|pendiente/.test(chk.texto), chk.texto.replace(/\n/g, ' | '));

  /* C4 avisos */
  notificaciones.suscribirStock(uid, '499999');
  const numeroNuevo = stock.demoNumero('499999', 16);
  const car = stock.cargar(numeroNuevo + '|12|28|321', { flexible: true, fase: 'confirmar', usuario: 'test' });
  const avisoStock = base().prepare("SELECT * FROM notificaciones WHERE usuario_id=? AND tipo='stock_bin' ORDER BY id DESC LIMIT 1").get(uid);
  check('C4 aviso stock del BIN', car.nuevas === 1 && avisoStock && /499999/.test(avisoStock.payload), avisoStock && avisoStock.payload);
  const nStock = avisoStock ? vb.notifTexto(avisoStock) : '';
  check('C4 texto stock', /Entró stock del BIN 499999/.test(nStock), nStock);

  base().prepare('UPDATE reservas SET expira=? WHERE cc_id=?').run(new Date(Date.now() + 2 * 60000).toISOString(), c.id);
  const nVence = notificaciones.colaVencimientos(5);
  const porVencer = base().prepare("SELECT * FROM notificaciones WHERE usuario_id=? AND tipo='reserva_por_vencer' ORDER BY id DESC LIMIT 1").get(uid);
  check('C4 reserva por vencer', nVence >= 1 && porVencer && /vence en/.test(vb.notifTexto(porVencer)), String(nVence));

  recargas.revisar(recId, 1, true, 'ok test');
  const recAviso = base().prepare("SELECT * FROM notificaciones WHERE usuario_id=? AND tipo='recarga_aprobada' ORDER BY id DESC LIMIT 1").get(uid);
  check('C4 recarga aprobada', recAviso && /Recarga aprobada/.test(vb.notifTexto(recAviso)), recAviso && recAviso.payload);
  check('C4 reclamo resuelto', /Reclamo/.test(vb.notifTexto({ tipo: 'reclamo_resuelto', payload: { reclamo_id: 7, resolucion: 'reemplazado' } })));
  check('C4 pedido aprobado', /Pedido aprobado/.test(vb.notifTexto({ tipo: 'pedido_aprobado', payload: { grupo: 'R-1', cantidad: 1, total: 100, expira: new Date(Date.now() + 10000).toISOString() } })));
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}
console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
