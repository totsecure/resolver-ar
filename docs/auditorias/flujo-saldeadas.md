# Auditoría del flujo saldeadas → /pedir N → /revisar N (resolver)

Fecha: 2026-10-23. Entorno: instancia de test :3011 con base descartable `.e2e/a2.db`
(seed `scripts/e2e-seed.mjs` + fixture extra), producción :3001 intacta.
Commit auditado: `eb4a631` (worktree) / `80c91a7` (producción :3001).

## CRÍTICO

### C1 — `/stock/pedir` y `/stock/revisar` ignoran el JSON body: el bot NUNCA funciona
Síntoma: el bot manda `POST /stock/pedir` con body `{n,usuario,chat_id,comprador}`
(`bot/stock.js:141`) y siempre recibe `{"error":"no_encontrada","n":0}`. El usuario ve
"No existe la #N. Mirá /saldeadas" para cualquier N. Idem `/revisar` (`bot/stock.js:155`).
Ninguna tarjeta sale de la lista ni pasa a REVISION desde el bot.

Causa: el server lee todo con `qs()` que sólo mira `req.query`, nunca `req.body`.
El bot (y cualquier cliente razonable) manda POST con body.
- `server.js:1278` `const n = num(qs(req, 'n'), 0);` (pedir)
- `server.js:1281` `usuario: qs(req,'usuario'), chat_id: qs(req,'chat_id'), comprador: qs(req,'comprador')`
- `server.js:1289-1291` (revisar) `qs(req,'n')`, `qs(req,'ref')`, `qs(req,'chat_id')`
- `server.js:589` `const qs = (req,k,d) => (typeof req.query[k] === 'string' ? req.query[k] : d);`
- `bot/stock.js:17-27` `pedir()` arma POST con `body:JSON.stringify(cuerpo)`.

Evidencia:
```
$ curl -s -X POST "http://127.0.0.1:3011/stock/pedir?token=$T" -H 'content-type: application/json' -d '{"n":"1","usuario":"bot","chat_id":"1"}'
{"error":"no_encontrada","n":0}
$ curl -s -X POST "http://127.0.0.1:3011/stock/pedir?token=$T&n=1"
{"ok":true,"n":1,"codigo":"V-20261024-00X","bloque":"..."}
```
Los specs existentes (`zz-flujo-saldeadas.spec.js`) pasan porque usan `?n=` en el query,
nunca el body. Specs de auditoría que fallan: `tests/e2e/_audit-pedido-body.spec.js`
```
2 failed  (AUDIT pedir por BODY / AUDIT revisar por BODY → {"error":"no_encontrada"})
4 passed  (los 4 de zz-flujo-saldeadas, que usan query)
```

Fix: leer body con fallback a query, ej.
`const p = (req,k) => (req.body?.[k] ?? req.query[k]);` y usar `p(req,'n')`, `p(req,'chat_id')`, etc.
en `/stock/pedir` y `/stock/revisar` (y `quien()` en server.js:1257 ya queda sirviendo a ambos).

### C2 — `/revisar N` sin N (última venta) tampoco puede funcionar (misma causa)
`server.js:1295` `else if (chat) { const u = sUltimaVenta(chat); ... }` lee `chat` con `qs`,
y `sUltimaVenta` depende de `movs.chat_id` guardado por el `/pedir` previo, que también
lee `chat_id` con `qs`. Como el bot manda todo por body, ni el `chat_id` se guarda ni se lee.
Evidencia: `POST /stock/revisar` con body `{"usuario,x,chat_id:"1"}` → `{"error":"no_encontrada"}`.
(Con query `?chat_id=1` tampoco, porque la venta anterior se registró con `chat_id=null`.)

## MEDIO

### M1 — `/pedir <bin> <n>` (reserva de vendedor) ya no reserva: sólo lista
`bot/vendedor.js:77` trata cualquier `arg0` de 5-8 dígitos como BIN y retorna el listado
(`pedidoTexto`), sin llegar nunca a `vb.pedir` (reserva) en `bot/vendedor.js:107`.
`esBin = /^\d{5,8}$/` incluye los 6 dígitos de un BIN, y el `if` corta antes.
El comentario (`bot/vendedor.js:62-70`) y la ayuda (`lib/vendedor-bot.js:45`
"/pedir <bin> <n> - reserva n tarjetas") dicen que reserva: ya no.
Evidencia (ruteo): `pedir "516585" "3"` → `listado -> pedidoTexto` (no reserva).
Fix: resolver reserva antes del listado cuando hay 2º arg numérico
(`if (esBin && /^\d+$/.test(arg1)) { ... vb.pedir ... }`).

### M2 — `saldo` "humano" (`1m/`, `abc`) se muestra como `- 0` en la lista
`lib/pedido.js:15-18` `saldoDe` hace `Number(s)` sobre el string; `Number('1m/')`=NaN,
`Number('abc')`=NaN → luego `precioCorto(NaN)` devuelve `'0'`.
Evidencia (reproducción directa de `lineaDe`):
```
"abc"  -> "1> x - 0"
"1m/"  -> "1> x - 0"
"0"    -> "1> x - 0"
null   -> "1> x"
50000  -> "1> x - 50000/80000"
```
(En el fixture se vio `10> ... - 0` para saldo '1m/' y '0'.) La carga por bloque guarda
`saldo_disp='1m'` como texto y `saldo_num` numérico; cuando la fila sólo tiene el texto
(ej. cargas viejas / otras vías) la lista miente con 0.
Fix: en `saldoDe` usar `precioCorto`-safe (o `Number` sólo si es numérico puro;
si no, mostrar el token crudo).

### M3 — Carga por bloque pierde titular/contacto (aunque el parser los lee)
`lib/stock.js:529` `const vTitular = nuevoFormato ? null : (l.titular || null);`
y `nuevoFormato` incluye `'bloque'`. El parser `parsearBloquesLote` (`lib/stock.js:213-242`)
extrae TITULAR/DNI/SALDO, y el preview lo muestra, pero el INSERT guarda `titular=null`
(y mail/tel/dirección/ciudad/provincia tampoco se persisten). El bloque de venta
depende de datos del padrón por DNI.
Evidencia:
```
cargar bloque con "TITULAR LOPEZ MARIA / DNI 30111222 / ... / SALDO 50000/80000"
→ fila DB: { titular: null, dni: '30111222', saldo: 50000, saldo_ref: 80000 }
```
Es consistente con el diseño "pipe", pero contradice la idea de "bloque completo con titular".

### M4 — `revisar`/`pedir` por `ref` operan sobre TODAS las coincidencias (ref es por-BIN)
`ref` no es único global (es por BIN). `POST /stock/revisar?ref=3` revisó 3-4 tarjetas
(todas las de `ref=3` en cada BIN). `sBuscar(ref)` (server.js:1293) devuelve array.
Evidencia:
```
$ curl -s -X POST ".../stock/revisar?token=$T&ref=3"
{"ok":true,"n":3}
ref=3 rows: 411111/3, 516585/3, 545652/3, 450799/3 → todas REVISION
```
Fix: documentar, o `revisar` por ref tomar `[0]` si se espera una sola, o aceptar `numero` exacto.

### M5 — `pedir` puede robar una reserva viva (reservado_hasta vs reserva_vence)
`lib/stock.js:843` `reservar()` escribe `reserva_vence` y deja `reservado_hasta=NULL`;
`lib/stock.js:729` la protección de venta (`VENDEDOR_GANA_CARRERA`) chequea
`estado='RESERVADA' AND reservado_hasta IS NULL` → **siempre true** → vende reservas ajenas.
`pedir` usa `sVender`, así que cualquiera con el token puede pisar una reserva.
Evidencia:
```
reservar ref=105 (vend1) → {estado:RESERVADA, reservado_por:vend1, reservado_hasta:null, reserva_vence:...}
vender  ref=105          → VENDIDA (codigo V-...), reservado_por/reserva_vence quedan sucios
```
Fix: unificar el campo (usar `reserva_vence` en la condición) o setear `reservado_hasta` en `reservar`.

## MENOR

### m1 — Alias de comando no funcionan para vendedores
`bot/vendedor.js:16` `CMD` no incluye alias (`q,pd,rv,dead,queja`), pero `bot/stock.js:311-318`
sí los define. Un vendedor que manda `/q 5` recibe "Comando no disponible para vendedores"
(por `bot/vendedor.js:95-99`) en vez de resolver a `pedir`. Sólo `/pedir`/`/revisar` literales funcionan.

### m2 — `GET` no existe para pedir/revisar
Sólo `POST /stock/pedir`, `POST /stock/revisar`. `GET /stock/pedir?n=1` → 404 HTML.
Menor: un cliente GET-based no puede; el bot usa POST.

### m3 — `revisar` no limpia `reserva_vence`/`asignada_en`
`lib/stock.js:764-765` limpia `codigo_venta, reservado_por, reservado_hasta`, pero no
`reserva_vence` ni `asignada_en`. Quedan campos sucios tras pasar a REVISION.

### m4 — `revisar` puede revivir una BAJA
`revisar` acepta cualquier estado ≠ REVISION. Una `BAJA` por ref pasa a REVISION.
El commit menciona sólo VENDIDA/PAGADA/RESERVADA/RECLAMADA.
Evidencia: `revisar ref=<num BAJA>` → `{ok:true,n:1}` y la fila queda `REVISION`.

### m5 — N acepta coerciones raras
`server.js:590` `num()` acepta `+2`, `' 2'`, `0x2`, `1.0` (todos resuelven), pero `1e1`/`1.5`/full-width fallan con 404. No es peligroso; conviene normalizar a entero >0.

### m6 — `/pedir` ignora `ref`
`POST /stock/pedir?ref=5` → `no_encontrada` (sólo usa `n`). Útil para pedir por referencia.

## Lo que SÍ está bien
- Numeración: `/saldeadas`, `/stock/saldeada/:n`, `/stock/pedir` y `/stock/revisar`
  comparten `saldeadasLista()`/`saldeadaPorNumero()` → la N coincide entre llamadas al mismo instante.
- `/pedir N` (por query) saca la tarjeta de la lista y la deja VENDIDA con `codigo_venta`;
  el bloque incluye titular/dni/fecha/mail/tel/dirección/CC/venc/código/saldo (saldo sólo si existe).
- Prefijo `/stock/cargar` con bloques `TARJETA #…/DATOS TARJETA/SALDO disp/ref` guarda saldo
  (`50000/80000` → saldo=50000, saldo_ref=80000; `1m/` → 1000000; `0` → 0; sin SALDO → null),
  y una tarjeta repetida en el mismo lote se marca duplicada (no revienta).
- Auth: `/stock/saldeadas|saldeada|pedir|revisar` exigen token (401 sin token/ token malo).
- Merge con la lista cambiando: no hay corrupción; pedir dos veces la misma N consume
  tarjetas distintas (renumeración), sin doble cobro.

## Veredicto: NO listo para producción
El flujo que ve el usuario vive en el BOT, y el bot usa el body: `C1` deja `/pedir N` y
`/revisar N` **100% inoperantes en producción** (siempre "No existe la #N"). Los e2e pasan
porque prueban el path del query, no el del bot. Antes de desplegar hay que corregir C1
(y C2, que depende de lo mismo). Recomiendo además M1 (reserva de vendedores) y M2 (saldo 0 falso),
y agregar el spec `_audit-pedido-body.spec.js` a la suite para que el path del bot quede cubierto.
