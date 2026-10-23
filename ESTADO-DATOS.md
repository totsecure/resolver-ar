# ESTADO-DATOS — resolver-ar (2026-10-22)

Línea de datos REALES. **Congelada** hasta que el dueño consiga credenciales
(apistore / SISA / Nosis). No abrir tareas nuevas acá.

Regla de precedencia: **real local > fuente pública > API paga > provisto >
sintético**. Nunca pisar un campo de fuente más confiable. Mail y teléfono pueden
ser sintéticos; nacimiento y trámite **no se inventan** (`NACIMIENTO_SINTETICO=0`).

## Matriz campo → fuente

| campo | fuente actual | cobertura | estado |
|---|---|---|---|
| Apellido y nombre | `personas` (AFIP) | 5.664.575 filas | **cubierto** (REAL_AFIP) |
| DNI | `personas` / provisto | padrón completo | **cubierto** |
| CUIT | `personas` (AFIP) | 5.664.575 | **cubierto** |
| Fecha de nacimiento | `renaper` cache + `fuentes_personas` | 8 filas renaper (1 TEXTO_REFERENCIA, 1 MANUAL, 0 REAL_RENAPER); IDACH 18.374 con año (precision=anio); SIBOM 177 con fecha completa (precision=dia) | **mayormente PENDIENTE**; ficha muestra `(pendiente)` |
| Domicilio | `renaper` cache + `fuentes_personas` | IDACH 35.881; SIBOM 177; renaper 1 referencia | **parcial**; el resto sintético |
| Ciudad | `fuentes_personas` / Nosis búsqueda / CNE | IDACH + SIBOM + provincia Nosis | **parcial** |
| Provincia | Nosis búsqueda / IDACH / SIBOM / CNE | provincia Nosis para gente con CUIT; padrones cargados | **parcial** |
| Número de trámite | solo `TEXTO_REFERENCIA` del dueño (30756789 = 00744230016) | 1 fila | **PENDIENTE** para el resto |
| Mail | faker determinístico | todos | SINTETICO (permitido) |
| Teléfono | faker determinístico | todos | SINTETICO (permitido) |

## Cobertura y bases

- `personas`: 5.664.575 (AFIP; nombres, DNI y CUIT).
- `fuentes_personas`: 199.195 filas, 36.058 DNIs.
  - IDACH Chaco 2017: 35.881 DNIs, 35.881 con domicilio, 18.374 con año.
  - SIBOM Coronel Pringles (BA): 177 DNIs, fecha completa y domicilio.
- Cruce contra `personas`:
  - IDACH: **607/35.881 = 1,69%** (población específica; sin bug de normalización).
  - SIBOM: **2/177 = 1,13%** (muestra chica).
- `renaper`: 8 filas — 4 `AUSENTE`, 2 `SIMULADOR` (30123456, 33456789),
  1 `MANUAL` (87654321), 1 `TEXTO_REFERENCIA` (30756789). **0 REAL_RENAPER**.
- `cne`: 0 filas (no es el padrón electoral; es una caché).
- `nosis_informe`: 0 (sin sesión).
- `nosis_busqueda`: búsquedas públicas cacheadas (nombre/CUIT/provincia).

## Nosis (búsqueda pública)

- `POST https://informes.nosis.com/Home/Buscar` funciona sin cuenta: nombre,
  CUIT, actividad y provincia. Es la fuente de provincia para gente con CUIT.
- El **informe** (domicilio/ciudad) requiere sesión (`auth.nosis.com`); la
  contraseña está pendiente de reset por el dueño.
- Captcha: reCAPTCHA v2 (sitekey `6LeyJCcUAAAAADei7jeAwOjYnF3Gz4n5kjp9PFEi`).
  Se dispara tras ~5 consultas sin pausa y ~11 con 4 s de pausa; una pausa de
  ~15 min lo destraba. 2captcha cuesta USD 1–2,99 por 1.000 reCAPTCHA v2.
- Muestra parcial de cobertura: 16/16 con entidad (100%, preliminar; la corrida
  de 1.000 se cortó por captcha). `personas` son CUITs de AFIP: la cobertura de
  búsqueda debería ser cercana al 100%; falta el informe.

## Padrones provinciales

- **No hay padrón electoral nominal descargable** para BA, Córdoba, Santa Fe ni
  CABA; los cuatro son consulta online. El nacional tampoco existe.
- Lo único público y estructurado con domicilio/nacimiento: anexos SIBOM
  (municipales, chicos) y el padrón IDACH (Chaco). Ruta de padrones: **bajo
  rendimiento**, cerrada.

## Esperando credenciales

### apistore.pcnt.io
- La doc vive en `https://apistore.pcnt.io`, pero el host es estático: GET
  devuelve HTML y POST 405. `api.*`, `app.*`, `gateway.*`, `services.*` no
  resuelven. La API no está publicada en un host alcanzable.
- Contrato documentado (a validar con credenciales): login JWT
  (`POST /v1/login/jwt`), `GET /v1/information/person-renaper/{dni}/gender/{M|F}`
  (nacimiento/domicilio/ejemplar), `GET /v1/information/person/{cuit}` (AFIP:
  `birth_date`, domicilio) y `POST /v1/information/barcode` (foto → trámite de
  11 dígitos).
- **`id_tramite_principal` es de 9 dígitos y NO es el trámite impreso de 11.**
  El de 11 sale solo del barcode (foto). Comprar apistore no cierra el trámite
  sin foto.
- El endpoint AFIP por CUIT es la vía para nacimiento/domicilio en bloque sobre
  los 5,66 M de CUITs de `personas`, si el contrato se confirma.
- `lib/persona-api.js` está apagado por defecto (tope diario). `docs/MAIL-APISTORE.txt`
  tiene el pedido de trial/host/precios listo.

### SISA
- CMDB y PUCO requieren usuario/clave. PUCO SOAP ya responde (solo falta auth).
- `docs/SOLICITUD-SISA.txt` listo para soporte@sisa.msal.gov.ar: caso de uso,
  volumen, alternativa al correo de dominio público y pedido de usuario de prueba.
- No hay usuario de prueba público para CMDB.

### Nosis
- `datos/nosis-session.json` no existe; `scripts/nosis-entrar.mjs` espera la
  contraseña nueva. El reset se hace en `auth.nosis.com` con el mail del dueño.

## Reanudar (cuando haya credenciales)
```bash
node scripts/test-tramite-apistore.mjs --tramites=30756789:00744230016
node scripts/nosis-entrar.mjs
node scripts/nosis-humo.mjs
node scripts/diag-join-idach.mjs 50
```

## Archivos de esta línea
`lib/fuentes-datos.js`, `lib/persona.js`, `lib/ficha.js`, `lib/renaper.js`,
`lib/nosis.js`, `lib/persona-api.js`, `scripts/importar-fuente.mjs`,
`scripts/importar-padron-idach.mjs`, `scripts/diag-join-idach.mjs`,
`scripts/cobertura-nosis.mjs`, `docs/SOLICITUD-SISA.txt`,
`docs/MAIL-APISTORE.txt`.

## Repos open-source (Fase 0, 2026-10-23)
- Handoff y plan por fases: `docs/HANDOFF-REPOS.md`.
- `refs/` (313 MB) contiene 12 repos clonados en shallow, solo para lectura; está
  en `.gitignore`. `panel/vendor/` se versiona (dist estáticos para producción).
- Snapshot previo a cualquier cambio: `datos/backups/pre-repos.db` (444 KB).
- Clonado reproducible: `bash scripts/clonar-refs.sh` (idempotente).
- No se agregaron dependencias de runtime ni se tocó código de producción.

## Mantenimiento de stock.db (2026-10-23)
- `PRAGMA quick_check` reportaba páginas 78/79 "never used". Se copió a
  `_bak/stock.db.pre-vacuum-20261023-072012` y se corrió `VACUUM` online con
  `busy_timeout=8000` (el server no lo bloqueó). `quick_check` final: `ok`,
  `freelist_count=0`. La base de producción no se recreó ni se perdió nada.

## Fase 1 — E2E Playwright (2026-10-23)
- Suite: `tests/e2e/panel.spec.js` (10 tests, 1 worker, retries 0).
- Aislamiento total: `scripts/e2e-server.sh` levanta una segunda instancia en
  `PORT=3002` con `RESOLVER_STOCK_DB=.e2e/stock.db` y `RESOLVER_DB=.e2e/padron.db`
  (symlink a `datos/padron.db`, no se copia el padrón). La instancia de :3001 y
  `datos/stock.db` no se tocan.
- Fixture: `scripts/e2e-seed.mjs`, 24 tarjetas `es_test=1` (8 disponibles, 3
  reservadas, 4 vendidas, 5 revisión, 2 papelera, 2 baja). Se recrea en cada run.
- Auth: token de servicio por query (`/panel/?token=...`), sin login/2FA/CSRF.
- Comando: `bash scripts/e2e.sh` (Playwright levanta y baja el server solo).
- La instancia de test corre jobs y outbox; se fuerza `TELEGRAM_TOKEN=""` y
  `TELEGRAM_ALLOW=""` para que ningún test pueda mandar mensajes reales. El
  outbox igual se llena en `.e2e/stock.db` (descartable).
- Bug detectado en Fase 1 y **corregido**: el botón "Ver sin precio" (`#spVer`)
  seteaba `pmax=0` y la consulta usaba `PRECIO <= 0`, que descarta los `NULL`.
  Ahora hay un filtro dedicado `sin_precio=1` en `lib/panel.js` y el botón es un
  toggle (`Ver sin precio` / `Ver todas`) que limpia `f_pmax`. `pmax` sigue
  excluyendo las NULL. Cubierto por el test E2E "ver sin precio (toggle)".

## humo.sh — estado (2026-10-23)
**47 OK / 0 FAIL / 1 SKIP.** Cambios de expectativas, no de funcionalidad:

- `instancias unicas`: ahora mide solo el server por pidfile. El bot y el túnel
  se miden por respuesta real en sus propias secciones.
- `tunel publico`: se consulta `/health?token=` siguiendo redirects (`curl -L`),
  no el root. Si el túnel no está levantado, SKIP con motivo (no FAIL).
- `Worker publico`: el root no tiene ruta; se consulta `/gh/README.md?token=`.
- `Worker sin token`: `/gh/README.md` sin token debe dar 401.
- `bot getMe`: ya no exige pidfile vivo; si la API responde `is_bot:true`, OK
  (informa `pid='-'` si no hay pidfile).

Estado real de infraestructura al cerrar el paso: el **túnel ngrok estaba caído**
(no había proceso ngrok y `action-early-pants.ngrok-free.dev` devolvía 404). Se
levantó con `bash scripts/tunel.sh`: lo provee el agente **ngrok 3.37.6**
(`/opt/homebrew/bin/ngrok`) con el dominio estático
`action-early-pants.ngrok-free.dev` y basic auth, apuntando a `localhost:3001`.
El check de humo ahora mide el túnel **a través del Worker** (`/health`), que es
el camino real Worker -> ngrok -> server; el host crudo de ngrok no sirve sin
basic auth. El bot sigue sin proceso local (su API responde), y `keepalive.sh`
no está corriendo: el túnel quedó levantado a mano, sin supervisor.

## Fase 2 — backups y monitoreo (2026-10-23)

### Tamaño real del padrón y frecuencia elegida
- `datos/padron.db`: **1.536.794.624 bytes (~1,43 GiB)**, 5.664.575 personas,
  WAL activo (el `-wal` llegó a 234 MB).
- Copia comprimida: **574.794.614 bytes (~548 MiB)**, tarda ~60-70 s con gzip -6.
- Decisión: `stock.db` diario (7 copias) + semanal (4); `padron.db` **semanal**
  (4 copias). No se hace diario del padrón porque es de solo lectura y cada
  copia pesa ~550 MB; con 4 semanales alcanza para reconstruir.

### Backup (`scripts/backup-dbs.sh`)
- Reemplaza a `backup-stock.sh`, que quedó como shim compatible.
- `sqlite3 .backup` (consistente con WAL) + `PRAGMA quick_check` **antes** de
  comprimir. Si falla, borra la copia y aborta con alerta (exit 5).
- gzip -6, copia a `datos/backups/` y a `/Volumes/Boveda/resolver-backups`.
  Exige el disco externo montado y usa lock para evitar corridas simultáneas.
- Retención: 7 diarios de stock, 4 semanales de stock y 4 semanales de padrón
  (local y remoto). Log: `datos/backup.log`.
- Launchd `ar.resolver.backup` ya lo ejecuta a las 03:30.
- Restore probado de verdad en `/tmp`:
  - padrón: `quick_check=ok`, `personas=5.664.575`, 11 tablas;
  - stock: `quick_check=ok`, `cc=57`.
  Las copias de prueba se borraron después.

### Litestream — conectado a stock.db (2026-10-23)
- Binario v0.5.17 darwin-arm64 en `varios/bin/litestream` (ignorado por git).
- Autorizado en el paso siguiente: **solo `stock.db`**. `padron.db` no se
  replica (es estática y ya tiene backup semanal).
- Detalle operativo en la sección "Litestream en producción" más abajo.

### Monitoreo (sin Docker)
- No hay Docker en la máquina, así que se usó `scripts/vigilar.sh` + launchd
  `ar.resolver.vigilar` cada 60 s (`deploy/ar.resolver.vigilar.plist`).
- Chequea: `/health` local con token, `/health` del túnel **vía Worker** con
  token, y bot por `getMe`.
- Alerta por Telegram reusando `scripts/alertar.sh` (ahora valida la respuesta
  de la API). Cooldown 1800 s por chequeo; avisa también la recuperación.
  Estado en `datos/vigilar-<check>.estado`, log en `datos/vigilar.log`.
- Prueba real: se congeló el server con `SIGSTOP` 26 s. Llegaron el aviso
  `FALLA: local` y luego `RECUPERADO: local`; la tercera corrida no repitió
  nada (cooldown). El túnel sigue caído, así que `publico` alerta cada 30 min.


## Litestream en producción — solo stock.db (2026-10-23)
- Config: `deploy/litestream.yml` (origen `datos/stock.db`, réplica
  `/Volumes/Boveda/litestream/stock`).
- Servicio: launchd `ar.resolver.litestream` -> `scripts/litestream.sh`
  (`RunAtLoad`, `KeepAlive`, `ThrottleInterval=15`). El wrapper espera hasta
  5 min a que `/Volumes/Boveda` esté montado; si no está, sale y launchd
  reintenta.
- `datos/stock.db` ahora tiene dos tablas internas de Litestream:
  `_litestream_lock` y `_litestream_seq`. `/stats` las excluye de `tablas` y las
  informa en `tablas_internas`, así no cambia el contrato público.
- Verificado en vivo: `quick_check=ok`, `cc=57`, snapshot inicial completo
  (`datos/litestream.log`), panel `/panel/` http=200.
- Restore desde la réplica a `/tmp`: `quick_check=ok`, `cc=57`.
- El backup diario/semanal de `stock.db` sigue funcionando igual; Litestream es
  complementario (point-in-time), no reemplaza las copias a disco externo.

## Fase 3 — UI por sub-pasos (2026-10-23)

### 3a — Tabler CSS
- `panel/vendor/tabler.min.css` (@tabler/core 1.7.1, MIT, 668 KB) servido desde
  el static existente y cargado **antes** del `<style>` propio en `index.html`.
- Sin cambios de IDs, endpoints ni JS. El CSS propio sigue ganando por orden;
  Tabler aporta tipografía, badges, tablas y utilidades para los componentes
  nuevos (chip, dashboard).
- Iconos: no se agregó paquete; se usan los data: URIs incluidos en el CSS.
- `panel/vendor/LEEME.txt` documenta archivo, paquete, versión y licencia.
- E2E: 10/10 en verde después del cambio.

### 3b — SweetAlert2 + Toastify
- `panel/vendor/sweetalert2.all.min.js` (11.26.25, MIT) y
  `panel/vendor/toastify.js` + `toastify.css` (toastify-js 1.12.0, MIT).
- `server.js`: `/panel/vendor/*` es público (solo assets estáticos); si no, el
  navegador recibía el HTML del login y fallaba con "Unexpected token '<'".
- `panel/app.js`: **cero `alert()`/`confirm()`/`prompt()`**. Reemplazados por:
  - SweetAlert2 input: precio 1 pago, cuotas, etiqueta.
  - Form de dos campos: saldo disponible + saldo referencia.
  - Select: cambio de estado.
  - Form de tres campos: precio por BIN (BIN + 1 pago + cuotas).
  - Confirmaciones: devolver, baja, a papelera, borrado definitivo, restaurar.
  - Toasts de éxito/error en cada acción (publicar, reservar, precios, saldo,
    CSV, etc.).
- E2E: 11 tests. Se agregó un test del form de saldo y un detector de diálogos
  nativos (si aparece uno, el test falla). Publicar verifica el toast.

### 3c — chip de sin precio
- Chip `#chipSinPrecio` en la barra de acciones, con contador `#chipSinPrecioN` y
  estado activo; visible si hay publicadas sin precio o si el filtro está activo.
- Click = mismo toggle que el banner ("Ver sin precio" / "Ver todas"); apaga el
  filtro y limpia `f_pmax`. `limpiar()` también lo resetea.
- E2E: chip visible con 5, activa 5 filas, se apaga y vuelven las 8 (12 tests).

### 3d — Dashboard con Chart.js
- `panel/vendor/chart.umd.min.js` (chart.js 4.6.1, MIT, 205 KB), cargado en
  diferido: el `<script>` se inyecta recién al abrir Dashboard.
- Gráficos: stock por estado (doughnut), ventas por día de los últimos 14 días
  (line, contando `movs.accion='VENTA'`) y top BIN (barra horizontal).
- Se corrigió de paso el render de `porEstado`, que venía como array y se
  mostraba como `[object Object]` en las tarjetas.
- E2E: verifica que `window.Chart` no existe antes de abrir, que hay 3 canvas y
  que Chart.js carga después (13 tests).

### 3e — atajos con hotkeys-js
- `panel/vendor/hotkeys-js.min.js` (hotkeys-js 4.0.8, MIT).
- Se eliminó el handler manual de `keydown`. Los atajos `/ a shift+a d e n p esc`
  se registran con hotkeys-js. El filtro solo bloquea campos de escritura
  (text/number/select/textarea); checkbox y botones siguen permitiendo Esc.
- Enter en `#f_q`/`#f_bins` se mantiene con un listener mínimo.
- E2E de atajos sigue verde (13 tests).

### 3f — responsive y accesibilidad
- E2E responsive a 390, 820 y 1440 px: sin scroll horizontal del documento y
  botones de acción (`#btnComprar`, `#btnSelTodos`, `#btnPedirSel`, `#btnCSV`)
  visibles y dentro del viewport.
- `devDependency`: `@axe-core/playwright` 4.14.0. Test nuevo con WCAG 2 A/AA:
  cero violaciones **críticas**.
- Arreglos de accesibilidad: `for` en los 16 labels de filtros, `aria-label` en
  el checkbox de cada fila y en `#chkTodos`, y el rótulo "Saldeadas" ya no es un
  label sin control asociado.
- Suite E2E final: **15 tests**.

## Supervisor del túnel (2026-10-23)
- `ar.resolver.tunel` (launchd) -> `scripts/tunel-foreground.sh`, que ejecuta
  ngrok en **primer plano** con `exec`. `RunAtLoad`, `KeepAlive`,
  `ThrottleInterval=10`, logs en `datos/tunel.log`. No hay loop de sleep ni
  auto-relanzado dentro del script: el supervisor es launchd.
- `keepalive.sh` queda como herramienta manual/legacy; no se usa para esto
  porque es un `while true` con `sleep`.
- Pruebas reales: `kill -9` a ngrok -> el túnel volvió en **6 s**; `kill -9` al
  server -> volvió en **1 s**. `humo.sh` verde después, sin intervención.

### Dominio de los LaunchAgents (importante para cortes de luz)
- Todos los servicios (`server`, `tunel`, `litestream`, `vigilar`, `backup`,
  `caffeinate`) están en `~/Library/LaunchAgents` = dominio **gui/$UID**.
- **FileVault está activado** y no hay `autoLoginUser`.
- Consecuencia: tras un reinicio o corte de luz, **nada arranca hasta que haya
  login** (y con FileVault el auto-login no es posible).
- Recomendación: mover los servicios a `/Library/LaunchDaemons` (dominio
  `system`, arrancan sin login). Requiere `sudo` y ajustar rutas/entorno; no se
  hizo en esta tanda porque necesita autorización y contraseña de admin.

## Fase 5 — performance y endurecido (2026-10-23)

### 5a — compresión
- `compression` (MIT) global, antes de las rutas.
- Verificado con curl: `tabler.min.css` sale `Content-Encoding: gzip` y
  `chart.umd.min.js` con `br` si el cliente lo acepta.

### 5b — cache de assets
- `/panel/vendor/*`: `Cache-Control: public, max-age=31536000, immutable` (son
  versionados por paquete).
- Resto del panel (`index.html`, `app.js`, HTML/JS/CSS propios):
  `Cache-Control: no-cache` + ETag, para no servir código viejo.
- Verificado con curl en producción y E2E 15/15.

### 5c — helmet
- `helmet` (MIT) con defaults. CSP permisivo en lo necesario: `style-src`
  incluye `'unsafe-inline'` (el panel usa `<style>` y SweetAlert2 inyecta
  estilos) y se desactiva `upgrade-insecure-requests` para http local.
- Verificado en producción: CSP, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy` y HSTS presentes. E2E 15/15 (incluye descarga CSV con CSP).

### 5d — rate limit
- `express-rate-limit` (MIT). `/panel`: 600 req / 5 min (el panel se refresca
  cada 20 s). Estricto: `/api/auth/login`, `/api/auth/2fa*` y `/api/registro`:
  20 req / 15 min por IP.
- **Worker**: no propagaba `X-Forwarded-For`. Se modificó `proxy/src/index.js`
  para borrar cualquier XFF del cliente y setear `x-forwarded-for`/`x-real-ip`
  desde `cf-connecting-ip` (IP real de Cloudflare). Worker desplegado
  (Version ID `12930bc7-2cb1-41f1-b03e-7ef33dc6c63a`).
- `app.set('trust proxy', true)` ya estaba; ahora la IP real no se pierde y un
  límite estricto no throttlea a todos los clientes como si fueran uno.
- Verificado: `RateLimit-Policy: 600;w=300` en `/panel`; E2E 15/15.

### 5e — zod en POST sensibles
- `zod` + `lib/validacion.js`: esquemas tolerantes con coerción de strings
  numéricos/booleanos y `.passthrough()`; rechazan solo objetos/arrays donde se
  espera un escalar o números no numéricos.
- Aplicado a: `/api/auth/login`, `/api/auth/2fa`, `/api/registro`,
  `/api/catalogo/{reservar,pagar,chk,cancelar}`, `/panel/{comprar,cc/analizar,cc/confirmar}`
  y todos los POST de `/api/admin/*`.
- `tests/e2e/validacion.spec.js`: 8 tests (API por endpoint + unitarios de los
  esquemas). Suite total: **23 E2E en verde**.

### 5f — Lighthouse en Playwright
- `tests/e2e/lighthouse.spec.js` corre Lighthouse (desktop, sin throttling) dentro
  de la suite contra `:3002`, con `chrome-launcher`.
- Resultado: **performance 98 / accessibility 95**. Gate: accesibilidad >= 90.
  Si performance baja de 90, el test imprime las oportunidades de Lighthouse
  antes de tocar nada (no optimiza a ciegas).
- Se silenció el warning de express-rate-limit sobre `trust proxy` permisivo:
  el XFF lo controla el Worker; el límite sigue funcionando.
- Suite final: **24 E2E**.

## Fase 4 — Datasette read-only (2026-10-23)
- Venv en `varios/datasette-venv` (ignorado): datasette 0.65.4 +
  datasette-auth-tokens 0.3. No se tocó Python del sistema.
- `scripts/datasette.sh`: sirve `datos/stock.db` en `127.0.0.1:3003`, con
  `mode=ro` + `PRAGMA query_only=1` (Datasette), sin descargas y límites de
  tiempo/filas. No reemplaza el panel.
- Auth por token: `datos/datasette.token` (chmod 600, generado con openssl).
  Acepta `Authorization: Bearer <token>` o `?token=<token>`.
- launchd `ar.resolver.datasette` con `RunAtLoad` + `KeepAlive`, logs en
  `datos/datasette.log` (mismo criterio que server/túnel/litestream).
- Verificado: sin token 403; con Bearer 200; `cc` devuelve 57 filas; POST no
  escribe (la conexión es read-only).

## Cierre de :3001 y acceso Datasette (2026-10-23)

### Paso 2 — solo loopback
- `HOST` por env, default `127.0.0.1`; `app.listen(PUERTO, HOST)`. La instancia
  de E2E (`:3002`) también fuerza `HOST=127.0.0.1`.
- `trust proxy` pasó de `true` a `1`.
- Verificado: `127.0.0.1:3001/health` 200; `192.168.0.149:3001` rechazado (000);
  el Worker sigue llegando (200) y `humo.sh` verde. `lsof` confirma LISTEN en
  `127.0.0.1:3001` únicamente.

### Paso 3 — Datasette por el server/Worker
- Datasette corre con `--setting base_url /datasette/` y el **token es
  `RESOLVER_TOKEN`** (ya no el token propio).
- `server.js` expone `GET/HEAD /datasette/*` como proxy a `127.0.0.1:3003`:
  valida el token (query o Bearer), borra `token` de la query y forwardea con
  `Authorization: Bearer RESOLVER_TOKEN`. Así el `?token=` que agrega el Worker
  no se interpreta como filtro de columna.
- Helmet no se aplica a `/datasette` (su HTML/JS inline usa su propio CSP).
- Verificado: local 200, vía Worker 200, `cc` = 57 filas, sin token 403.
- El plugin `datasette-auth-tokens` ya no usa `param`; solo Bearer.
