/* metricas.js — numeros del panel de administracion. Solo lectura. */
import { base } from './stock.js';

const VENTA = "('pagada','ok','falla')";

export function resumen({ umbral = 2, dias = 30 } = {}) {
  const d = base();
  const hoy = new Date().toISOString().slice(0, 10);
  const desde = new Date(Date.now() - Math.max(1, Number(dias) || 30) * 86400000).toISOString().slice(0, 10);

  const kpis = {
    disponibles: d.prepare("SELECT COUNT(*) n FROM cc WHERE estado='DISPONIBLE' AND COALESCE(eliminado,0)=0").get().n,
    pagadas: d.prepare("SELECT COUNT(*) n FROM reservas WHERE estado='pagada'").get().n,
    vendidas: d.prepare("SELECT COUNT(*) n FROM reservas WHERE estado='ok'").get().n,
    ventas_hoy: d.prepare("SELECT COUNT(*) n FROM reservas WHERE estado IN " + VENTA + " AND substr(COALESCE(pagado_en, creado),1,10)=?").get(hoy).n,
    ingresos_hoy: d.prepare("SELECT COALESCE(SUM(precio),0) s FROM reservas WHERE estado IN " + VENTA + " AND substr(COALESCE(pagado_en, creado),1,10)=?").get(hoy).s,
    ingresos_total: d.prepare("SELECT COALESCE(SUM(precio),0) s FROM reservas WHERE estado IN " + VENTA).get().s,
    saldo_vendedores: d.prepare('SELECT COALESCE(SUM(saldo),0) s FROM saldos').get().s,
    reclamos_pendientes: d.prepare("SELECT COUNT(*) n FROM reclamos WHERE estado='pendiente'").get().n,
    recargas_pendientes: d.prepare("SELECT COUNT(*) n FROM recargas WHERE estado='pendiente'").get().n,
    altas_pendientes: d.prepare("SELECT COUNT(*) n FROM vendedores WHERE estado='pendiente'").get().n,
    reservas_activas: d.prepare("SELECT COUNT(*) n FROM reservas WHERE estado='activa'").get().n,
  };

  const ventasPorDia = d.prepare(
    'SELECT substr(COALESCE(pagado_en, creado),1,10) dia, COUNT(*) n, COALESCE(SUM(precio),0) total ' +
    'FROM reservas WHERE estado IN ' + VENTA + ' AND substr(COALESCE(pagado_en, creado),1,10) >= ? ' +
    'GROUP BY 1 ORDER BY 1 DESC'
  ).all(desde);

  const ingresosPorVendedor = d.prepare(
    'SELECT r.usuario_id, u.usuario, u.nombre, COUNT(*) n, COALESCE(SUM(r.precio),0) total, ' +
    "SUM(CASE WHEN r.estado='falla' THEN 1 ELSE 0 END) fallas " +
    'FROM reservas r JOIN usuarios u ON u.id=r.usuario_id WHERE r.estado IN ' + VENTA + ' ' +
    'GROUP BY r.usuario_id ORDER BY total DESC'
  ).all();

  const fallaPorBin = d.prepare(
    'SELECT bin, COUNT(*) total, ' +
    "SUM(CASE WHEN verif_estado='falla' THEN 1 ELSE 0 END) fallas, " +
    "SUM(CASE WHEN verif_estado='ok' THEN 1 ELSE 0 END) ok, " +
    "SUM(CASE WHEN verif_estado='sin_verificar' THEN 1 ELSE 0 END) sin_verificar " +
    "FROM cc WHERE estado IN ('VENDIDA','RECLAMADA','ANULADA') GROUP BY bin ORDER BY total DESC LIMIT 100"
  ).all().map((f) => ({
    ...f,
    tasa: f.total ? Math.round(((f.fallas + f.ok) ? f.fallas / (f.fallas + f.ok) : 0) * 1000) / 10 : 0,
  }));

  const stockBajo = d.prepare(
    "SELECT bin, SUM(CASE WHEN estado='DISPONIBLE' THEN 1 ELSE 0 END) n, COUNT(*) total " +
    "FROM cc WHERE COALESCE(eliminado,0)=0 GROUP BY bin HAVING n <= ? ORDER BY n, bin LIMIT 100"
  ).all(Number(umbral) || 0);

  const margenPorLote = d.prepare(
    'SELECT COALESCE(c.lote, c.lote_id, \'(sin lote)\') lote, COUNT(r.id) n, ' +
    'COALESCE(SUM(r.precio),0) ingresos, ' +
    'COALESCE(SUM(COALESCE(c.precio_sugerido, c.precio_num, 0)),0) costo ' +
    'FROM reservas r JOIN cc c ON c.id=r.cc_id WHERE r.estado IN ' + VENTA + ' ' +
    'GROUP BY 1 ORDER BY ingresos DESC LIMIT 100'
  ).all().map((f) => ({ ...f, margen: Number(f.ingresos) - Number(f.costo) }));

  const cierreCaja = d.prepare(
    "SELECT substr(COALESCE(pagado_en, creado),1,10) dia, COUNT(*) ventas, COALESCE(SUM(precio),0) ingresos " +
    "FROM reservas WHERE estado IN " + VENTA + " GROUP BY 1 ORDER BY 1 DESC LIMIT 30"
  ).all();

  const ranking = ingresosPorVendedor.map((f, i) => ({ ...f, puesto: i + 1 }));

  return { kpis, ventasPorDia, ingresosPorVendedor, ranking, margenPorLote, cierreCaja, fallaPorBin, stockBajo };
}


/** Alertas operativas: stock, fallas por BIN, saldo negativo y reclamos. */
export function alertas({ umbral = 2, fallaMin = 3, reclamosMin = 3 } = {}) {
  const r = resumen({ umbral, dias: 30 });
  const d = base();
  const fallaAlta = r.fallaPorBin.filter((f) => Number(f.total) >= 2 && Number(f.fallas) >= fallaMin);
  const saldoNegativo = d.prepare(
    'SELECT u.id, u.usuario, u.nombre, s.saldo FROM saldos s JOIN usuarios u ON u.id=s.usuario_id ' +
    'WHERE s.saldo < 0 ORDER BY s.saldo'
  ).all();
  const reclamosVendedor = d.prepare(
    'SELECT r.usuario_id, u.usuario, COUNT(*) n, ' +
    "SUM(CASE WHEN r.estado='pendiente' THEN 1 ELSE 0 END) pendientes " +
    'FROM reclamos r JOIN usuarios u ON u.id=r.usuario_id GROUP BY r.usuario_id ' +
    'HAVING COUNT(*) >= ? ORDER BY n DESC LIMIT 100'
  ).all(Math.max(1, Number(reclamosMin) || 3));
  return { stockBajo: r.stockBajo, fallaAlta, saldoNegativo, reclamosVendedor };
}
