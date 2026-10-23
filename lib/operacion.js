/* operacion.js — reporte diario, exportaciones y estado operativo. */
import { base } from './stock.js';
import * as metricas from './metricas.js';
import * as notificaciones from './notificaciones.js';

const ahora = () => new Date().toISOString();
let listo = false;

export function migrar() {
  if (listo) return base();
  base().exec('CREATE TABLE IF NOT EXISTS reportes_diarios(fecha TEXT PRIMARY KEY, creado TEXT NOT NULL)');
  listo = true;
  return base();
}

function fechaHoy() { return new Date().toISOString().slice(0, 10); }

export function reporteDiario() {
  migrar();
  const d = base();
  const hoy = fechaHoy();
  const m = metricas.resumen({ umbral: Number(process.env.STOCK_UMBRAL || 2) || 2, dias: 1 });
  const k = m.kpis;
  const reclamos = d.prepare("SELECT COUNT(*) n FROM reclamos WHERE estado='pendiente'").get().n;
  const recargas = d.prepare("SELECT COUNT(*) n, COALESCE(SUM(monto),0) total FROM recargas WHERE estado='pendiente'").get();
  const stock = d.prepare("SELECT COUNT(*) n, COALESCE(SUM(COALESCE(saldo_total_num, saldo_ref, 0)),0) saldo FROM cc WHERE estado='DISPONIBLE' AND COALESCE(eliminado,0)=0").get();
  const lineas = [
    '📊 REPORTE DIARIO ' + hoy,
    'Ventas: ' + k.ventas_hoy + ' · Ingresos: $' + k.ingresos_hoy,
    'Stock disponible: ' + stock.n + ' CC · saldo ref: $' + stock.saldo,
    'Saldo vendedores: $' + k.saldo_vendedores,
    'Reservas activas: ' + k.reservas_activas,
    'Reclamos pendientes: ' + reclamos,
    'Recargas pendientes: ' + recargas.n + ' · $' + recargas.total,
  ];
  return { fecha: hoy, texto: lineas.join('\n'), kpis: k, stock };
}

/** Encola el reporte una sola vez por día a partir de REPORTE_HORA (default 8). */
export function enviarReporteSiToca(hora = Number(process.env.REPORTE_HORA || 8)) {
  migrar();
  const hoy = fechaHoy();
  const h = new Date().getHours();
  if (h < Math.max(0, Number(hora) || 0)) return { enviado: false, motivo: 'antes_de_hora' };
  const ya = base().prepare('SELECT 1 FROM reportes_diarios WHERE fecha=?').get(hoy);
  if (ya) return { enviado: false, motivo: 'ya_enviado' };
  const r = reporteDiario();
  base().prepare('INSERT INTO reportes_diarios(fecha, creado) VALUES(?,?)').run(hoy, ahora());
  notificaciones.auditar(r.texto);
  return { enviado: true, fecha: hoy, texto: r.texto };
}

function celda(v) {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function csvStock() {
  const filas = base().prepare(
    'SELECT id,ref,numero,bin,marca,mes,anio,estado,titular,dni,banco,precio,precio_num,saldo,saldo_ref,etiqueta,lote,creado,eliminado FROM cc ORDER BY id'
  ).all();
  const cab = 'id,ref,numero,bin,marca,mes,anio,estado,titular,dni,banco,precio,precio_num,saldo,saldo_ref,etiqueta,lote,creado,eliminado';
  return [cab, ...filas.map((f) => Object.values(f).map(celda).join(','))].join('\n');
}

export function csvPedidos() {
  migrar();
  const filas = base().prepare(
    'SELECT p.id,p.codigo,p.grupo,p.usuario_id,u.usuario,p.estado,p.cantidad,p.total,p.creado,p.vence,p.pagado_en,p.entregado_en,p.verificado_en ' +
    'FROM pedidos p LEFT JOIN usuarios u ON u.id=p.usuario_id ORDER BY p.id'
  ).all();
  const cab = 'id,codigo,grupo,usuario_id,usuario,estado,cantidad,total,creado,vence,pagado_en,entregado_en,verificado_en';
  return [cab, ...filas.map((f) => Object.values(f).map(celda).join(','))].join('\n');
}

export function csvMovimientos() {
  const filas = base().prepare('SELECT id,cc_id,accion,usuario,chat_id,fecha,detalle FROM movs ORDER BY id').all();
  const cab = 'id,cc_id,accion,usuario,chat_id,fecha,detalle';
  return [cab, ...filas.map((f) => Object.values(f).map(celda).join(','))].join('\n');
}
