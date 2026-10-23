#!/usr/bin/env node
/* test-fase4.mjs — vinculacion web<->bot, comandos de vendedor, avisos y auditoria. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.RECLAMO_AUTO_REEMPLAZO = '0';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-fase4-'));
process.env.RESOLVER_STOCK_DB = path.join(dir, 'stock.db');
process.env.RESOLVER_DB = path.join(dir, 'padron.db');

const auth = await import('../lib/auth.js');
const wallet = await import('../lib/wallet.js');
const vendedores = await import('../lib/vendedores.js');
const catalogo = await import('../lib/catalogo.js');
const vinculacion = await import('../lib/vinculacion.js');
const notificaciones = await import('../lib/notificaciones.js');
const recargas = await import('../lib/recargas.js');
const reclamos = await import('../lib/reclamos.js');
const vb = await import('../lib/vendedor-bot.js');
const stock = await import('../lib/stock.js');
const { base } = stock;

let OK = 0, FAIL = 0;
function ok(n, d) { OK++; console.log('  OK    ' + n + (d ? ' :: ' + d : '')); }
function fail(n, d) { FAIL++; console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, c, d) { c ? ok(n, d) : fail(n, d || 'sin detalle'); }

function sembrar(bin, precio, titular, dni, codigo) {
  const d = base();
  const ref = (d.prepare('SELECT MAX(ref) m FROM cc WHERE bin=?').get(bin).m || 0) + 1;
  const info = d.prepare(
    'INSERT INTO cc(numero, mes, anio, cvv, bin, marca, estado, precio_num, creado, ref, titular, dni, banco, verif_estado, codigo) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(stock.demoNumero(bin, 16), '12', '2028', '321', bin, 'Visa', 'DISPONIBLE', precio, new Date().toISOString(), ref, titular, dni, 'Banco Test', 'sin_verificar', codigo);
  return Number(info.lastInsertRowid);
}
function codigoDeGrupo(grupo) {
  return base().prepare('SELECT c.codigo FROM cc c JOIN reservas r ON r.cc_id=c.id WHERE r.grupo=? ORDER BY r.id LIMIT 1').get(grupo).codigo;
}
function reservaDeCc(ccId) {
  return base().prepare('SELECT * FROM reservas WHERE cc_id=? ORDER BY id DESC LIMIT 1').get(ccId);
}

console.log('TEST fase 4 — ' + new Date().toISOString());
for (const m of [auth, wallet, vendedores, catalogo, vinculacion, notificaciones, recargas, reclamos]) m.migrar();

try {
  auth.crearUsuario({ usuario: 'admin', nombre: 'Admin', rol: 'admin', clave: 'claveAdmin123' });
  const inv = vendedores.crearInvitacion({ creadoPor: 1 });
  vendedores.registrar({ codigo: inv.codigo, usuario: 'vend1', clave: 'clavevend11', nombre: 'Vendedor Uno', dni: '41111222', telefono: '11555', alias_cbu: 'vend1.alias' });
  const v = vendedores.listar({ estado: 'pendiente' })[0];
  vendedores.revisarAlta(v.usuario_id, 1, true);
  const uid = v.usuario_id;
  wallet.acreditar(uid, 1000, 'carga');

  const cc1 = sembrar('411111', 100, 'Titular Uno', '30111222', 'AAA1111');
  const cc2 = sembrar('411111', 100, 'Titular Dos', '30222333', 'AAA2222');
  const cc3 = sembrar('411111', 150, 'Titular Tres', '30333444', 'AAA3333');
  const cc4 = sembrar('516585', 200, 'Titular Cuatro', '30444555', 'BBB4444');

  /* 1. vinculacion */
  const gen = vinculacion.generar(uid);
  check('codigo de vinculacion', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(gen.codigo), gen.codigo);
  const link = vb.vincular(777, gen.codigo);
  check('vincular chat', link.ok === true);
  check('chat vinculado a la cuenta', auth.usuarioPorId(uid).telegram_id === '777');
  check('codigo de un solo uso', vb.vincular(778, gen.codigo).ok === false);
  const gen2 = vinculacion.generar(uid);
  base().prepare('UPDATE vinculaciones SET expira=? WHERE usuario_id=? AND usado IS NULL').run(new Date(Date.now() - 1000).toISOString(), uid);
  check('codigo vencido rechazado', vb.vincular(778, gen2.codigo).ok === false);
  check('esVendedor', vb.esVendedor(777) === true && vb.esVendedor(999) === false);

  /* 2. comandos */
  const st = vb.stock(777);
  check('/stock con BINs', st.ok && /411111/.test(st.texto) && /516585/.test(st.texto));

  const ped = vb.pedir(777, '411111', 2);
  check('/pedir reserva 2', ped.ok && Boolean(ped.grupo), 'grupo=' + ped.grupo);
  check('/pedir revela numero', /\|\d{2}\|\d{4}\|\d{3}/.test(ped.texto));
  check('/pedir muestra countdown', /Vence en \d{2}:\d{2}/.test(ped.texto));
  check('saldo debitado', wallet.saldoDe(uid) === 800);
  const grupo1 = ped.grupo;
  const res1 = base().prepare('SELECT * FROM reservas WHERE grupo=? ORDER BY id LIMIT 1').get(grupo1);

  const notifAsignada = base().prepare("SELECT * FROM notificaciones WHERE usuario_id=? AND tipo='reserva_asignada' ORDER BY id DESC").get(uid);
  check('aviso de reserva asignada encolado', Boolean(notifAsignada));
  check('aviso incluye grupo', notifAsignada && notifAsignada.payload.includes(grupo1));

  const mis = vb.mis(777);
  check('/mis muestra activa y reloj', mis.ok && mis.texto.includes('activa') && /\d{2}:\d{2}/.test(mis.texto));
  check('/saldo', vb.saldo(777).texto.includes('SALDO: $800'));
  check('/datos <codigo>', vb.datos(777, codigoDeGrupo(grupo1)).texto.includes('Titular'));
  check('chat ajeno no ve datos', vb.datos(888, codigoDeGrupo(grupo1)).ok === false);

  const pag = vb.pagar(777, grupo1);
  check('/pagar grupo', pag.ok === true && /PAGO CONFIRMADO/.test(pag.texto));
  check('reservas pagadas', base().prepare("SELECT COUNT(*) n FROM reservas WHERE grupo=? AND estado='pagada'").get(grupo1).n === 2);
  check('aviso de pago', base().prepare("SELECT COUNT(*) n FROM notificaciones WHERE usuario_id=? AND tipo='pago_confirmado'").get(uid).n >= 1);
  check('canal de auditoria venta', base().prepare("SELECT COUNT(*) n FROM notificaciones WHERE canal='audit' AND payload LIKE '%VENTA%'").get().n >= 1);

  /* 3. /ok del bot se refleja en la web */
  const codigo1 = codigoDeGrupo(grupo1);
  const okBot = vb.marcarOk(777, codigo1);
  check('/ok del bot', okBot.ok === true, okBot.texto);
  const resOk = base().prepare('SELECT * FROM reservas WHERE cc_id=?').get(cc1);
  const ccOk = base().prepare('SELECT estado, verif_estado FROM cc WHERE id=?').get(cc1);
  check('/ok deja reserva ok', resOk.estado === 'ok');
  check('/ok deja cc VENDIDA/verif ok', ccOk.estado === 'VENDIDA' && ccOk.verif_estado === 'ok');
  const web = catalogo.misReservas(uid);
  check('la web ve el OK del bot', web.some((r) => r.cc_id === cc1 && r.estado === 'ok'));
  check('auditoria verificacion ok', base().prepare("SELECT COUNT(*) n FROM notificaciones WHERE canal='audit' AND payload LIKE '%VERIFICACION OK%'").get().n >= 1);

  /* 4. /falla: reclamo, estado y reflejo en la web */
  const ped2 = vb.pedir(777, '411111', 1);
  check('segunda reserva', ped2.ok === true);
  vb.pagar(777, ped2.grupo);
  const codigo3 = codigoDeGrupo(ped2.grupo);
  const falla = vb.marcarFalla(777, codigo3, 'sin saldo disponible');
  check('/falla del bot', falla.ok === true, falla.texto);
  const ccFalla = base().prepare('SELECT estado, verif_estado FROM cc WHERE id=?').get(cc3);
  check('/falla deja RECLAMADA/falla', ccFalla.estado === 'RECLAMADA' && ccFalla.verif_estado === 'falla');
  const recl = reclamos.listar({ estado: 'pendiente' });
  check('reclamo registrado', recl.length === 1 && recl[0].motivo === 'sin saldo disponible');
  check('canal de auditoria reclamo', base().prepare("SELECT COUNT(*) n FROM notificaciones WHERE canal='audit' AND payload LIKE '%RECLAMO%'").get().n >= 1);
  check('aviso de reclamo al vendedor', base().prepare("SELECT COUNT(*) n FROM notificaciones WHERE usuario_id=? AND tipo='reclamo_creado'").get(uid).n === 1);
  check('web ve reserva en falla', catalogo.misReservas(uid).some((r) => r.cc_id === cc3 && r.estado === 'falla'));

  /* 5. aviso de vencimiento, una sola vez */
  const ped3 = vb.pedir(777, '516585', 1);
  check('tercera reserva', ped3.ok === true);
  const resV = base().prepare('SELECT * FROM reservas WHERE grupo=?').get(ped3.grupo);
  base().prepare('UPDATE reservas SET expira=? WHERE id=?').run(new Date(Date.now() + 4 * 60000).toISOString(), resV.id);
  const n1 = notificaciones.colaVencimientos(5);
  const n2 = notificaciones.colaVencimientos(5);
  check('aviso por vencer encolado', n1 >= 1, 'n=' + n1);
  check('aviso por vencer no se duplica', n2 === 0);
  const nv = base().prepare("SELECT * FROM notificaciones WHERE tipo='reserva_por_vencer' ORDER BY id DESC").get();
  check('texto de aviso por vencer', /vence en/.test(vb.notifTexto(nv)));

  /* 6. recarga aprobada: aviso + auditoria */
  const rec = recargas.crear(uid, { monto: 300, comprobante: 'transf' });
  recargas.revisar(rec.id, 1, true, 'ok');
  check('aviso recarga aprobada', base().prepare("SELECT COUNT(*) n FROM notificaciones WHERE usuario_id=? AND tipo='recarga_aprobada'").get(uid).n === 1);
  check('canal auditoria recarga', base().prepare("SELECT COUNT(*) n FROM notificaciones WHERE canal='audit' AND payload LIKE '%RECARGA APROBADA%'").get().n >= 1);
  check('saldo actualizado', wallet.saldoDe(uid) === 450 + 300);

  /* 7. cola de notificaciones pendiente y textos */
  const pend = notificaciones.pendientes(50);
  check('cola pendiente unificada', pend.length >= 3);
  check('notifTexto no explota', pend.every((n) => typeof vb.notifTexto(n) === 'string'));
} catch (e) {
  fail('excepción', String(e?.stack || e));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

console.log('');
console.log('RESUMEN: ' + OK + ' OK / ' + FAIL + ' FAIL');
process.exit(FAIL === 0 ? 0 : 1);
