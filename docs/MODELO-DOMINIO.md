# MODELO DE DOMINIO — RESOLVER STORE

Estado: **propuesta para revisión**. No hay código de Fase 6 todavía.
Fecha: 2026-10-23 · Base: esquema real de `datos/stock.db`.

## 0. Lo que ya existe (punto de partida)

| pieza | estado actual |
|---|---|
| Saldos | `saldos(usuario_id, saldo, actualizado)` materializa el saldo |
| Movimientos | `mov_saldo(id, usuario_id, tipo, monto, saldo_post, ref, nota, creado)` |
| Escritura | `wallet.aplicarTx()` actualiza `mov_saldo` + `saldos` en una transacción |
| Tipos usados | `recarga`, `reserva`, `reserva_cuenta`, `reserva_vencida`, `reserva_cancelada`, `doble_venta`, `ajuste`, `ajuste_admin` |
| Pedidos | `pedidos` (estado), `pedido_tarjetas`, `pedido_eventos` |
| Estados de pedido | `reservado, pagado, entregado, verificado, vencido, cancelado, reclamo` |
| Estados de tarjeta | `DISPONIBLE, RESERVADA, PAGADA, VENDIDA, BAJA, RECLAMADA, ANULADA, REVISION` + `eliminado` (papelera) |
| API keys | `api_tokens(usuario_id, nombre, token_hash, prefijo, creado, ultimo_uso, revocado)` |
| Auditoría | `auditoria(usuario_id, accion, entidad, entidad_id, detalle, ip, creado)` |

Brechas:

1. `mov_saldo` es de **una sola entrada**: guarda `saldo_post`, pero no hay
   contrapartida. No se puede probar de dónde salió cada peso.
2. No hay comisiones implementadas: `vendedores.comision` existe pero ningún
   flujo la usa.
3. Los estados de pedido no tienen una máquina de transiciones: `pedidos.estado`
   se escribe desde varios lugares.
4. Las API keys no tienen scopes ni rate limit propio.
5. No hay verificación automática de invariantes.

---

## 1. Ledger de wallet de doble entrada

### 1.1 Tablas

```sql
-- Plan de cuentas. El saldo de una cuenta = SUM(lineas.monto).
CREATE TABLE ledger_cuentas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo     TEXT NOT NULL UNIQUE,   -- wallet:12, ingresos:ventas, ...
  tipo       TEXT NOT NULL,          -- activo|pasivo|ingreso|gasto|patrimonio|puente
  usuario_id INTEGER,                -- solo para wallet:<usuario_id>
  nombre     TEXT,
  creado     TEXT NOT NULL
);

-- Un asiento = un hecho económico. Inmutable.
CREATE TABLE ledger_asientos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha       TEXT NOT NULL,
  tipo        TEXT NOT NULL,         -- apertura|recarga|reserva|venta|comision|ajuste|reverso
  ref_tipo    TEXT,                  -- recarga|pedido|cc|venta|manual
  ref_id      TEXT,                  -- id o código de la entidad
  descripcion TEXT,
  creado_por  INTEGER,               -- usuario admin, null si sistema
  idem_key    TEXT UNIQUE,           -- evita asientos duplicados por reintento
  creado      TEXT NOT NULL
);

-- Líneas del asiento. monto firmado, entero, sin centavos.
CREATE TABLE ledger_lineas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  asiento_id INTEGER NOT NULL REFERENCES ledger_asientos(id),
  cuenta_id  INTEGER NOT NULL REFERENCES ledger_cuentas(id),
  monto      INTEGER NOT NULL,
  moneda     TEXT NOT NULL DEFAULT 'ARS'
);

CREATE INDEX idx_ledger_lineas_asiento ON ledger_lineas(asiento_id);
CREATE INDEX idx_ledger_lineas_cuenta  ON ledger_lineas(cuenta_id);
-- compatibilidad: cada movimiento viejo apunta a su asiento
ALTER TABLE mov_saldo ADD COLUMN asiento_id INTEGER;
CREATE UNIQUE INDEX idx_mov_saldo_asiento ON mov_saldo(asiento_id) WHERE asiento_id IS NOT NULL;
```

### 1.2 Convención de signos

`monto` es firmado y **la suma de cada asiento debe ser exactamente 0**.
El saldo de una cuenta es `SUM(monto)` de sus líneas. Las cuentas de wallet
(pasivo de la empresa con el vendedor) usan signo positivo para el saldo a favor
del vendedor.

Ejemplos (todos suman 0):

| hecho | línea 1 | línea 2 |
|---|---|---|
| recarga aprobada 100 | `wallet:12 +100` | `recargas:banco -100` |
| reserva 30 | `wallet:12 -30` | `reservas:pendientes +30` |
| venta confirmada 30 | `reservas:pendientes -30` | `ingresos:ventas +30` |
| reserva vencida/cancelada 30 | `reservas:pendientes -30` | `wallet:12 +30` |
| comisión 5 | `wallet:12 +5` | `comisiones:plataforma -5` |
| ajuste admin +10 | `wallet:12 +10` | `ajustes:admin -10` |
| apertura saldo 80 | `wallet:12 +80` | `patrimonio:apertura -80` |

Cuentas fijas mínimas: `recargas:banco`, `reservas:pendientes`,
`ingresos:ventas`, `comisiones:plataforma`, `ajustes:admin`,
`patrimonio:apertura`, `historico:sin_clasificar` (solo migración).

### 1.3 Invariantes (deben cumplirse siempre)

1. `SUM(ledger_lineas.monto) = 0` para cada `asiento_id`.
2. `saldos.saldo = SUM(ledger_lineas.monto)` de la cuenta `wallet:<usuario_id>`.
3. Todo `mov_saldo` tiene `asiento_id` no nulo y único.
4. No se puede `UPDATE` ni `DELETE` en `ledger_asientos`/`ledger_lineas`
   (triggers de solo inserción).
5. `idem_key` evita duplicar una recarga/venta reintentada.
6. Un movimiento no puede dejar el wallet negativo salvo `permitirNegativo`
   (misma regla que hoy).
7. `saldos` es solo caché materializada; la fuente de verdad es el ledger.

### 1.4 Escritura

`wallet.aplicarTx()` pasa a:

1. validar monto y saldo;
2. abrir/reusar asiento con `idem_key` (si ya existe, devolver el mismo);
3. insertar 2+ líneas que suman 0;
4. insertar `mov_saldo` con `asiento_id`;
5. actualizar `saldos`;
6. todo en la misma transacción `BEGIN IMMEDIATE`.

Flujos a cubrir: recarga aprobada, reserva, venta, comisión, ajuste admin,
vencimiento, cancelación, doble venta y devolución.

### 1.5 Migración y asiento de apertura

1. Crear cuentas base.
2. Para cada `saldos.saldo != 0`, crear un asiento `apertura`:
   `wallet:<uid> +saldo` / `patrimonio:apertura -saldo`, con
   `idem_key = 'apertura:<uid>'`.
3. Backfill histórico (opcional, recomendado): recorrer `mov_saldo` por id,
   crear un asiento por movimiento según `tipo`, y verificar que
   `saldo_post` coincide con la suma del wallet. Si un tipo no se puede
   clasificar, usar `historico:sin_clasificar` y marcarlo en el informe.
4. Si cualquier `saldo_post` no coincide, **abortar la migración** y no
   publicar el ledger.

### 1.6 Preguntas para cerrar

- ¿La comisión es ingreso de la plataforma (`comisiones:plataforma`) o un bono
  extra al vendedor? Hoy el campo existe pero no se usa.
- ¿La moneda es siempre ARS entera? El código asume enteros.
- ¿Una cancelación después de pagado devuelve automáticamente al wallet?
- ¿Se backfillea todo el histórico o alcanza con apertura + movimientos nuevos?

---

## 2. Máquina de estados de pedidos

### 2.1 Estados y transiciones

| desde | hacia | quién | efectos |
|---|---|---|---|
| `reservado` | `pagado` | vendedor dueño, admin | tarjetas `RESERVADA→PAGADA`; asiento de venta |
| `reservado` | `vencido` | job de expiración | libera tarjetas; revierte reserva |
| `reservado` | `cancelado` | vendedor dueño, admin | libera tarjetas; revierte reserva |
| `pagado` | `entregado` | sistema (generar enlaces), admin | tarjetas `PAGADA→VENDIDA`; enlaces de un uso |
| `pagado` | `reclamo` | vendedor dueño | abre reclamo; no libera tarjetas |
| `pagado` | `cancelado` | **solo admin** | reembolso al wallet; tarjetas `ANULADA` |
| `entregado` | `verificado` | checker/sistema, admin | marca verificación |
| `entregado` | `reclamo` | vendedor dueño (ventana) | abre reclamo |
| `verificado` | `reclamo` | vendedor dueño (ventana) | abre reclamo |
| `verificado` | `cancelado` | **solo admin** | reembolso; tarjetas `ANULADA` |
| `reclamo` | `verificado` | admin | reclamo resuelto a favor |
| `reclamo` | `cancelado` | admin | reembolso; tarjetas `ANULADA` |

Terminales: `vencido`, `cancelado`. No se reabren.

### 2.2 Transiciones inválidas (deben devolver error)

- `reservado → entregado` (saltea el pago).
- `reservado → verificado`.
- `pagado → reservado`.
- `entregado → pagado` / `entregado → reservado`.
- `verificado → pagado` / `verificado → entregado`.
- `vencido → *` y `cancelado → *`.
- Cualquier estado desconocido.
- Vendedor operando un pedido de otro usuario.
- Vendedor cancelando un pedido `pagado`, `entregado` o `verificado`.
- `reclamo → entregado` (solo `verificado` o `cancelado`).
- Transición sin `motivo` cuando es `reclamo` o `cancelado`.

Implementación: `UPDATE pedidos SET estado=? WHERE id=? AND estado=?` y
`changes=1`; si 0 → `transicion_conflicto`. Toda transición escribe
`pedido_eventos(pedido_id, desde, hacia, actor_id, actor_rol, motivo, ip, creado)`
en la misma transacción.

### 2.3 Invariantes de pedidos

- `pedidos.estado` pertenece al enum.
- El último `pedido_eventos.estado` coincide con `pedidos.estado`.
- Todo pedido tiene al menos una fila en `pedido_tarjetas`.
- Toda `pedido_tarjetas.cc_id` existe en `cc`.
- Coherencia tarjeta/pedido: `pagado → cc PAGADA`, `entregado/verificado →
  cc VENDIDA`, `cancelado/vencido → cc DISPONIBLE o ANULADA` (según si se
  liberó o se anuló).
- No hay pedidos sin eventos.
- `total >= 0` y `cantidad = COUNT(pedido_tarjetas)`.

---

## 3. API keys por vendedor

### 3.1 Esquema propuesto

```sql
ALTER TABLE api_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE api_tokens ADD COLUMN expira TEXT;
ALTER TABLE api_tokens ADD COLUMN rate_limit_min INTEGER NOT NULL DEFAULT 60;
ALTER TABLE api_tokens ADD COLUMN ultimo_ip TEXT;
ALTER TABLE api_tokens ADD COLUMN revocado_en TEXT;
ALTER TABLE api_tokens ADD COLUMN creado_por INTEGER;
```

- Formato del secreto: `rsk_<public_id>_<secret>`; se muestra **una sola vez**.
- Se guarda `sha256(token)`; `prefijo` visible para identificar.
- `scopes` JSON validado contra un catálogo cerrado.

### 3.2 Scopes

| scope | permite |
|---|---|
| `catalogo:read` | listar stock/precios |
| `catalogo:reserve` | reservar |
| `catalogo:pay` | pagar reserva |
| `wallet:read` | saldo y movimientos propios |
| `pedidos:read` | pedidos propios |
| `pedidos:write` | cancelar/reclamar pedidos propios |
| `admin:read` | endpoints admin de lectura (solo rol admin) |
| `admin:write` | endpoints admin de escritura (solo rol admin) |

Reglas: sin scope ⇒ 403 `scope_requerido`; scopes de admin solo para rol admin;
un token no puede tener `admin:*` si el usuario no es admin. Default sugerido
para token nuevo de vendedor: `catalogo:read,wallet:read,pedidos:read`.

### 3.3 Revocación y rate limit

- Revocar = `revocado=1`, `revocado_en=now`; efecto inmediato en el próximo
  request (ya se consulta por request). Auditar `TOKEN_REVOCAR`.
- Rotación: crear token nuevo + revocar viejo; nunca reutilizar secreto.
- Rate limit por token (no por IP): `keyGenerator = sha256(token)`, ventana
  1 min, `rate_limit_min` configurable; lectura 60/min, escritura 20/min.
  Responde 429 con `Retry-After`; el límite por IP sigue existiendo aparte.
- `ultimo_uso` y `ultimo_ip` se actualizan en cada request autenticado.
- Nunca loguear el token completo; solo `prefijo`.

---

## 4. Script de invariantes (`scripts/verificar-invariantes.mjs`)

Read-only (`mode=ro`). Sale 0 solo si todo pasa. Se integra a `verificar.js`
como un test más (spawn del script) y se puede correr solo.

Chequeos:

**Ledger**
- cada asiento suma 0;
- toda línea apunta a una cuenta existente;
- `saldos.saldo == SUM(wallet)` por usuario;
- todo `mov_saldo` tiene asiento;
- `idem_key` sin duplicados;
- wallet negativo solo si hay marca de permitido.

**Pedidos**
- estado dentro del enum;
- último evento == estado actual;
- pedido con ≥1 tarjeta y `cantidad` coincide;
- `cc_id` existe;
- coherencia cc/estado de pedido;
- sin pedidos ni eventos huérfanos.

**Reservas**
- reserva activa con `vence` no nulo;
- reserva vencida no figura activa.

**API keys**
- hash único;
- scopes JSON válidos y dentro del catálogo;
- revocado ⇒ `revocado_en` no nulo;
- tokens admin solo de usuarios admin.

Salida: `OK`/`FAIL` por chequeo, resumen `N OK / M FAIL`, exit 1 si M>0.
Objetivo de tiempo: < 2 s sobre la base actual.

---

## 5. Plan de implementación propuesto (para después de aprobar)

1. Migración de ledger + apertura + backfill verificado; test de invariantes.
2. Cambiar `wallet.aplicarTx` para escribir asiento+líneas; doble escritura
   temporal y comparación de saldos.
3. Máquina de estados de pedidos con tabla de transiciones y eventos con actor;
   tests de transiciones válidas e inválidas.
4. Scopes en `api_tokens`, middleware por ruta, rate limit por token y tests.
5. `verificar-invariantes.mjs` en `verificar.js`; correrlo también en humo.

Cada punto con E2E, humo y verificar en verde y commit propio.
