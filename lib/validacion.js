/* validacion.js — esquemas zod tolerantes para POST sensibles.
 *
 * Objetivo: rechazar solo cuando el tipo está claramente mal (objeto/array
 * donde se espera un escalar, número no numérico, etc.). Coerciona strings
 * numéricos y booleanos, y conserva campos desconocidos (.passthrough()) para
 * no romper contratos existentes.
 */
import { z } from 'zod';

const escalarTexto = (max, min = 0) => z.preprocess(
  (v) => (v === undefined || v === null ? '' : (typeof v === 'object' ? v : String(v))),
  z.string().min(min).max(max)
);
const textoOpc = (max) => z.preprocess(
  (v) => (v === undefined || v === null ? undefined : (typeof v === 'object' ? v : String(v))),
  z.string().max(max).optional()
);
const numeroOpc = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
  z.number().finite().optional()
);
const enteroOpc = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
  z.number().int().optional()
);
const enteroReq = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? v : Number(v)),
  z.number().int()
);
const boolOpc = z.preprocess(
  (v) => (v === true || v === 'true' || v === 1 || v === '1'),
  z.boolean().optional()
);
const listaRefs = z.union([
  escalarTexto(8000),
  z.array(z.union([z.string().max(64), z.number()])).max(500),
]).optional();

export const login = z.object({
  usuario: escalarTexto(100, 1),
  clave: escalarTexto(300, 1),
  _csrf: textoOpc(300),
}).passthrough();

export const segundoFactor = z.object({
  codigo: escalarTexto(20, 1),
  _csrf: textoOpc(300),
}).passthrough();

export const registro = z.object({
  codigo: escalarTexto(100, 1),
  usuario: escalarTexto(100, 1),
  clave: escalarTexto(300, 1),
  nombre: textoOpc(200),
  dni: textoOpc(20),
  telefono: textoOpc(40),
  alias_cbu: textoOpc(120),
  _csrf: textoOpc(300),
}).passthrough();

export const ccAnalizar = z.object({
  texto: escalarTexto(4_000_000),
  nombre: textoOpc(200),
  archivo: textoOpc(300),
  reactivar: boolOpc,
}).passthrough();

export const ccConfirmar = z.object({
  texto: escalarTexto(4_000_000),
  nombre: textoOpc(200),
  archivo: textoOpc(300),
  etiqueta: textoOpc(100),
  maxBins: enteroOpc,
  reactivar: boolOpc,
}).passthrough();

export const panelComprar = z.object({
  ids: listaRefs,
  refs: listaRefs,
  cantidad: enteroOpc,
  bin: textoOpc(8),
  comprador: textoOpc(200),
  formato: textoOpc(50),
  chat_id: textoOpc(100),
}).passthrough();

export const catalogoReservar = z.object({
  refs: listaRefs,
  bin: textoOpc(8),
  cantidad: enteroOpc,
}).passthrough();

export const catalogoPagar = z.object({
  id: enteroOpc,
  grupo: textoOpc(100),
}).passthrough();

export const catalogoChk = z.object({
  reserva_id: enteroReq,
}).passthrough();

export const catalogoCancelar = z.object({
  id: enteroReq,
}).passthrough();

export const admin = z.object({
  monto: enteroOpc,
  usuario_id: enteroOpc,
  nota: textoOpc(500),
  aprobar: boolOpc,
  dias: enteroOpc,
  limite_reservas_dia: enteroOpc,
  limite_simultaneas: enteroOpc,
  comision: numeroOpc,
  bin: textoOpc(8),
  desde: enteroOpc,
  hasta: enteroOpc,
  precio: enteroOpc,
  moneda: textoOpc(10),
  accion: textoOpc(100),
  estado: textoOpc(40),
  motivo: textoOpc(500),
  rol: textoOpc(20),
  nueva: textoOpc(300),
  lote_id: enteroOpc,
  n: enteroOpc,
}).passthrough();

export function validar(esquema) {
  return (req, res, next) => {
    const r = esquema.safeParse(req.body ?? {});
    if (r.success) { req.body = r.data; return next(); }
    return res.status(400).json({
      ok: false,
      error: 'datos_invalidos',
      detalle: r.error.issues.slice(0, 5).map((i) => ({ campo: i.path.join('.'), mensaje: i.message })),
    });
  };
}
