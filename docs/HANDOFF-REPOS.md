# HANDOFF — Repos open-source para elevar RESOLVER STORE

Fecha: 2026-10-23 · Autor: Venice (investigación) · Ejecuta: opencode
Destino: `docs/HANDOFF-REPOS.md`

## 0. Contexto

Proyecto: `/Users/bunker/resolver` — panel web privado + bot de Telegram + resolver AFIP.
Vende CC (tarjetas) con saldo, en estado `REVISION / DISPONIBLE / RESERVADA / VENDIDA / PAPELERA`.
Stack: Node ESM, Express, `node:sqlite` (SQLite en WAL), front-end vanilla sin bundler,
server bajo launchd (`ar.resolver.server`), túnel ngrok + Worker proxy.

Objetivo: subir la calidad de la plataforma (UI, tests, backups, monitoreo, seguridad)
usando repos open-source maduros, **SIN migrar a un framework con build step**.

## 1. Reglas duras (no negociables)

1. UN SOLO ESCRITOR a la vez sobre el repo. Si hay otra sesión escribiendo, esperar.
2. No romper la API existente. Los endpoints y firmas actuales se mantienen.
3. Nada de bundlers. Si un repo necesita Vite/Webpack, se copian los archivos ya
   compilados (`dist`) a `panel/vendor/` y se sirven desde el static que ya existe.
4. Los repos se clonan en `refs/` (gitignored) para LEER. A producción solo se copia
   lo necesario, nunca `node_modules` de un tercero.
5. Toda dependencia nueva de runtime se justifica por escrito en este archivo.
6. Antes y después de cada fase: `node --check` de lo tocado + `bash scripts/humo.sh`
   + `node scripts/verificar.js`. Si algo se pone rojo, se revierte.
7. Licencias: preferir MIT / BSD / Apache-2.0. GPL solo si es herramienta externa
   (no se linkea código).
8. Verificar estrellas y último commit ANTES de clonar. Si el último commit es
   anterior a 2023, es referencia, no dependencia.
9. Los datos de prueba se marcan con `es_test=1` y se limpian después.
10. Backup antes de tocar: `cp` de los archivos que se van a modificar a `_bak/`.

## 2. Superficie que NO se toca sin querer

- `lib/stock.js` (estados, venta, entrega, reservas) — corazón del negocio.
- `lib/catalogo.js` (expiración de reservas) — ya tiene su job en `server.js`.
- `server.js`: gate de auth (`soloLectura` / `acceso` / `csrf`) y `PANEL_PUBLICOS`.
- `datos/stock.db` y `datos/padron.db` — siempre en WAL, `busy_timeout 8000`.
- El Worker (`proxy/src/index.js`): solo `/gh` exige token; el resto proxea con token.

## 3. Repos seleccionados

### A. Front-end drop-in (sin build, se sirven desde `panel/vendor/`)

| repo | ≈★ | lic | para qué | qué tomar |
|---|---|---|---|---|
| tabler/tabler | 40.8k | MIT | UI kit admin completo, dark mode, 100+ páginas | solo el CSS compilado (`tabler.min.css`) y los iconos SVG que uses; reemplaza el CSS propio de `index.html` por las clases de Tabler |
| ColorlibHQ/AdminLTE | 45.7k | MIT | alternativa clásica Bootstrap 5 | comparar y elegir UNA, no las dos |
| grid-js/gridjs | 4.7k | MIT | tabla con búsqueda/orden/paginado, vanilla | evaluar si reemplaza la tabla actual (ojo: hoy la tabla es propia y funciona) |
| TanStack/table | ≈26k | MIT | tabla headless + virtualización | solo si hacen falta 1000+ filas visibles |
| bigskysoftware/htmx | 48k | BSD-2 | pedir HTML en vez de JSON | opcional; no migrar todo de una |
| alpinejs/alpine | 31.6k | MIT | reactividad mínima en HTML | opcional, para el panel de carga |
| sweetalert2/sweetalert2 | 18k | MIT | reemplaza `alert()`/`confirm()`/`prompt()` | drop-in; hoy se usa `prompt()` en 6 lugares del panel |
| apvarun/toastify-js | 2.5k | MIT | avisos no bloqueantes (toasts) | para "venta ok", "error", "copiado" |
| chartjs/Chart.js | 64k | MIT | gráficos del dashboard | para ventas por día, stock por estado |
| leeoniya/uPlot | 8.9k | MIT | gráfico de series muy rápido | solo si Chart.js queda corto |
| jaywcjlove/hotkeys-js | ≈10k | MIT | atajos de teclado | hoy los atajos son a mano; unificar |
| ninja-keys | ≈2k | MIT | command palette (⌘K) | opcional, alto impacto percibido |

### B. SQLite / datos

| repo | ≈★ | lic | para qué |
|---|---|---|---|
| simonw/datasette | 10k | Apache-2.0 | API + explorador web sobre `stock.db`, solo lectura, con plugins (`datasette-auth-tokens`, `datasette-sqlite-fts4`). NO reemplaza el panel: es el visor de datos |
| sqlpage/SQLPage | ≈2k | MIT | alternativa: armar UI escribiendo SQL. Un binario |
| benbjohnson/litestream | 11k | Apache-2.0 | replicación continua de SQLite a archivo/S3. Hoy solo hay backup diario de `stock.db` y NADA de `padron.db` |
| pocketbase/pocketbase | 40k+ | MIT | referencia de diseño: auth + admin + API en un archivo |
| sqlitebrowser/sqlitebrowser | 21k | GPL | GUI de escritorio para inspeccionar la base |
| beekeeper-studio/beekeeper-studio | 17k | GPL/MIT | alternativa GUI multi-motor |

### C. Ops / monitoreo

| repo | ≈★ | lic | para qué |
|---|---|---|---|
| louislam/uptime-kuma | 85k+ | MIT | monitoreo con alertas a Telegram/Gotify. Monitorear: `/health` local, el túnel ngrok y el Worker |
| binwiederhier/ntfy | ≈24k | Apache-2.0 | push al celular sin apps raras |
| gotify/server | ≈12k | MIT | alternativa a ntfy |
| awesome-selfhosted/awesome-selfhosted | 329k | CC-BY-SA | catálogo general para elegir más herramientas |

### D. Testing / calidad

| repo | ≈★ | lic | para qué |
|---|---|---|---|
| microsoft/playwright | 75k+ | Apache-2.0 | E2E real del panel: login, seleccionar, publicar, deshacer, exportar, borrar. Es el hueco más grande del proyecto |
| vitest-dev/vitest | 16.8k | MIT | unit tests rápidos |
| ladjs/supertest | 14.4k | MIT | pegarle a los handlers HTTP sin levantar puerto |
| dequelabs/axe-core | ≈7k | MPL-2.0 | auditoría de accesibilidad dentro de Playwright |
| GoogleChrome/lighthouse | ≈28k | Apache-2.0 | performance del panel |

### E. Seguridad / validación

| repo | ≈★ | lic | para qué |
|---|---|---|---|
| colinhacks/zod | ≈36k | MIT | validar bodies/query con esquemas |
| helmetjs/helmet | ≈8k | MIT | cabeceras seguras |
| express-rate-limit/express-rate-limit | ≈3k | MIT | frenar fuerza bruta (hoy hay lógica propia en `auth.js`) |

### F. Referencia de modelo de dominio (NO clonar código, leer diseño)

| repo | ≈★ | qué mirar |
|---|---|---|
| v2board/v2board | ≈10k | wallet + pedidos + API de revendedor + roles. Es tu gemelo funcional |
| SouvikPati11/SMM-Panel-Website | bajo | descripción completísima: ledger, top-ups, cupones, afiliados, API keys, 2FA, auditoría |
| medusajs/medusa | 31k | máquina de estados de pedidos, reservas de inventario, line items |
| vendure-ecommerce/vendure | ≈6.5k | estados de pedido y stock en TypeScript, muy bien modelado |
| saleor/saleor | 22.2k | reservas y allocations de stock |
| directus/directus | 33.5k | diseño de admin sobre base existente |
| appsmithorg/appsmith | 41k | constructor de admin |
| nocodb/nocodb · tooljet/tooljet · budibase/budibase | 50k / 36k / 25k (≈) | alternativas de admin low-code |
| GorvGoyl/Clone-Wars | ≈10k | catálogo de 100+ clones con estrellas, para más ideas |

### G. Dominio específico (CC / pagos / impresión / jobs)

| repo | ≈★ | para qué |
|---|---|---|
| afipsdk/afip.js | ≈137 | padrón alcance 5/10/13 y facturación, si algún día facturás |
| emilioastarita/facturajs | bajo | alternativa AFIP en Node |
| NielsLeenheer/ReceiptPrinterEncoder | ≈400 | comandos ESC/POS para impresora térmica (comprobantes) |
| node-escpos/driver | ≈1k | driver de impresora para Node |
| OptimalBits/bull / taskforcesh/bullmq | 16.2k / 8k | colas si el volumen crece (hoy: `setInterval`) |
| kelektiv/node-cron · node-schedule | 3.2k / 9.2k | cron simple si se necesitan más jobs |

## 4. Plan por fases (cada fase: backup → cambio → test → commit)

### Fase 0 — Preparación

- Agregar `refs/` a `.gitignore`. **Decisión:** `panel/vendor/` SÍ se versiona:
  son dist estáticos que el server sirve tal cual y producción no debe depender
  de un build. `refs/` se ignora porque son repos de lectura.
- `mkdir -p refs panel/vendor _bak`
- Crear `scripts/clonar-refs.sh` con los clones de la sección 7.
- Snapshot de la base: `sqlite3 datos/stock.db ".backup datos/backups/pre-repos.db"`

### Fase 1 — Playwright (PRIORIDAD MÁXIMA)

- `npm i -D @playwright/test`; `npx playwright install chromium`
- `playwright.config.js` apuntando a `http://127.0.0.1:3001` con `?token=RESOLVER_TOKEN`
- `tests/e2e/`: login, tablas por pestaña, seleccionar fila, seleccionar todo el filtro,
  publicar seleccionadas, deshacer, exportar CSV, borrar a papelera, borrar definitivo,
  filtros por BIN/estado, atajos de teclado
- Agregar `scripts/e2e.sh` y correrlo junto a `humo.sh`
- Aceptación: la suite pasa en verde contra el server real, sin tocar datos productivos
  (usar `es_test=1`)

### Fase 2 — Backups y monitoreo

- Litestream o script propio: replicar `stock.db` Y `padron.db` (hoy `padron.db` no tiene backup)
- Verificar restore de un backup en `/tmp`
- Levantar Uptime Kuma (docker o binario) monitoreando `/health`, el túnel y el Worker
- Alertas a Telegram + ntfy
- Aceptación: apagar el server a propósito y recibir la alerta en < 60 s

### Fase 3 — UI

- Evaluar Tabler como base visual (una sola hoja CSS en `panel/vendor/`)
- Reemplazar `prompt()`/`confirm()`/`alert()` por SweetAlert2 (6 puntos del panel)
- Toasts con Toastify para el resultado de acciones
- Dashboard con Chart.js: ventas por día, stock por estado, top BIN
- Unificar atajos con hotkeys-js; opcional command palette
- Aceptación: el panel se ve y funciona igual o mejor en desktop y mobile;
  cero `prompt()` nativos

### Fase 4 — Datasette

- `pipx`/docker Datasette sobre `datos/stock.db` en modo lectura, puerto aparte
- Plugin de auth por token
- Aceptación: consultar `cc`/`movs`/`lotes` desde el navegador sin tocar el panel

### Fase 5 — Endurecer

- zod para validar query/body de `/panel/*` y `/api/*`
- helmet + express-rate-limit en login y endpoints sensibles
- axe-core + lighthouse dentro de Playwright
- Aceptación: sin regresiones, humo verde, informe de a11y sin violaciones críticas

### Fase 6 — Modelo de dominio (inspirado en v2board/medusa)

- Ledger de wallet de vendedores (doble entrada) si no existe ya
- Máquina de estados explícita para pedidos
- API keys por vendedor con scopes
- Aceptación: cada movimiento de saldo tiene contrapartida y queda auditado

## 5. Criterios de aceptación globales

- `bash scripts/humo.sh` y `node scripts/verificar.js` en verde después de CADA fase
- `npm test` / e2e en verde
- Ningún endpoint existente cambia de contrato
- Cada fase se puede revertir con un `git checkout` puntual
- Documentar en `ESTADO-DATOS.md` lo que se agregó

## 6. Qué NO hacer

- No migrar a React/Next. Se pierde la ventaja de "sin build".
- No clonar Odoo/ERPNext/Medusa para reemplazar el backend.
- No meter Redis/BullMQ hasta que haya un problema real de colas.
- No copiar código de repos sin mirar la licencia.
- No instalar Datasette Y SQLPage: elegir uno.
- No tocar `lib/stock.js` y el panel en la misma tanda de cambios.

## 7. Comandos de clonado (`refs/`)

```sh
mkdir -p /Users/bunker/resolver/refs && cd /Users/bunker/resolver/refs
git clone --depth 1 https://github.com/tabler/tabler
git clone --depth 1 https://github.com/grid-js/gridjs
git clone --depth 1 https://github.com/sweetalert2/sweetalert2
git clone --depth 1 https://github.com/apvarun/toastify-js
git clone --depth 1 https://github.com/chartjs/Chart.js
git clone --depth 1 https://github.com/jaywcjlove/hotkeys-js
git clone --depth 1 https://github.com/simonw/datasette
git clone --depth 1 https://github.com/benbjohnson/litestream
git clone --depth 1 https://github.com/louislam/uptime-kuma
git clone --depth 1 https://github.com/microsoft/playwright
git clone --depth 1 https://github.com/v2board/v2board
git clone --depth 1 https://github.com/GorvGoyl/Clone-Wars
```

Script idempotente: [`scripts/clonar-refs.sh`](../scripts/clonar-refs.sh).

## 8. Verificación rápida de cada repo antes de adoptar

- ¿Último commit < 12 meses? ¿Issues abiertas contestadas?
- ¿Licencia en el repo? ¿Permite uso comercial?
- ¿Se puede usar sin build? Si no, ¿tiene `dist/` publicada?
- ¿Cuánto pesa? Si el `.min.js` supera 200 KB, justificar.
- ¿Duplica algo que ya funciona? Si sí, no adoptar.

## 9. Estado de ejecución

### Fase 0 — hecha (2026-10-23)

- Checkpoint del trabajo previo: commit `ad29924` (`wip: checkpoint antes de repos open-source (Fase 0)`).
- `.gitignore`: se agregó `refs/`. `panel/vendor/` queda versionado (decisión arriba).
- Directorios creados: `refs/`, `panel/vendor/`, `_bak/`.
- Snapshot previo: `datos/backups/pre-repos.db` (444 KB, `quick_check` con aviso de
  páginas 78/79 "never used" en la base original; no impide el backup).
- `scripts/clonar-refs.sh` creado; clones en `refs/` (shallow, sin `node_modules`).
- No se tocó código de producción ni dependencias de runtime.

### Verificación de los 12 repos clonados (2026-10-23)

| repo | último commit | licencia | dist en el repo |
|---|---|---|---|
| Chart.js | 2026-10-23 | MIT | no |
| Clone-Wars | 2024-08-06 | **AGPL-3.0** | no |
| datasette | 2026-10-22 | Apache-2.0 | no |
| gridjs | 2026-01-29 | MIT | `build/` (fuentes, sin `.min`) |
| hotkeys-js | 2026-09-10 | MIT | `dist/hotkeys-js.min.js` |
| litestream | 2026-10-20 | Apache-2.0 | no (binario Go) |
| playwright | 2026-10-22 | Apache-2.0 | no (monorepo) |
| sweetalert2 | 2026-10-14 | MIT | no |
| tabler | 2026-10-23 | MIT | no (SCSS en `core/`) |
| toastify-js | 2024-08-19 | MIT | no (fuente en `src/`) |
| uptime-kuma | 2026-10-23 | MIT | no |
| v2board | 2023-06-04 | MIT | no |

Hallazgos:

- **Clone-Wars es AGPL-3.0.** Es solo catálogo de ideas: no copiar código. Si molesta
  la licencia, borrar `refs/Clone-Wars` (no se linkea nada).
- **Ningún repo de front-end trae `dist/` compilado.** El CSS/JS listo para producción
  sale del paquete publicado en npm (`npm pack`), no de compilar en este repo. Eso
  respeta la regla de "sin build step": se copia el artefacto publicado a `panel/vendor/`.
- `v2board` es de 2023: queda como **referencia de diseño**, no como dependencia.
- `toastify-js` (2024-08) cumple el corte de 2023, pero se adopta solo si aporta.

### Línea base de tests (antes de Fase 1)

- `node scripts/verificar.js`: **30 OK / 0 FAIL**.
- `bash scripts/humo.sh`: **43 OK / 6 FAIL / 0 SKIP**. Los 6 FAIL son preexistentes y
  externos a esta fase:
  - túnel ngrok público y Worker responden 404 (túnel caído/rotado);
  - `Worker sin token` 404 (consecuencia del anterior);
  - snapshot `/gh` desactualizado (`server.js` cambió desde el último `worker-repo.mjs`);
  - `bot getMe` responde OK pero el chequeo de pidfile da `pid='-'`.
  No se tocaron: son infraestructura/proxy, fuera del alcance de Fase 0.

### Fase 1 — hecha (2026-10-23)

- Dependencia de desarrollo: `@playwright/test` + Chromium. No se agregó nada de
  runtime.
- Aislamiento: `.e2e/stock.db` descartable + symlink `.e2e/padron.db`; segunda
  instancia en `:3002` (`scripts/e2e-server.sh`). `:3001` y `datos/stock.db`
  intactos (verificado: la base real sigue con 57 tarjetas en REVISION).
- Fixture determinista: `scripts/e2e-seed.mjs`, 24 tarjetas `es_test=1`.
- Suite: `tests/e2e/panel.spec.js`, 9 tests seriales. Cubre pestañas y totales,
  filtro BIN, búsqueda, selección por checkbox y por fila, página vs todo el
  filtro, banner sin precio, atajos `/ a A Esc`, publicar/deshacer, CSV y ciclo
  papelera/restaurar/borrado definitivo. Además falla si hay errores de consola.
- Resultado: **10 passed** en ~5,5 s. `verificar.js` 30/0 y `humo.sh` 44/5
  (las fallas de infraestructura de la línea base, sin el snapshot `/gh`, que
  quedó refrescado).
- Nota: la instancia de test ejecuta jobs y outbox. Se fuerza `TELEGRAM_TOKEN=""`
  para no enviar mensajes reales; el outbox vive en la base descartable.

### Fase 2 — hecha (2026-10-23)

- Backups: `scripts/backup-dbs.sh` (stock diario 7 + semanal 4; padrón semanal 4)
  con `.backup`, `quick_check` previo a comprimir, aborto ante corrupción, gzip,
  copia local + `/Volumes/Boveda/resolver-backups` y log en `datos/backup.log`.
  Restore probado: padrón `quick_check=ok` y 5.664.575 personas; stock `ok`, 57 CC.
- Padrón real: 1,43 GiB / ~548 MiB comprimido. Por eso la frecuencia semanal.
- Litestream v0.5.17 probado sobre copias (sync 14 s, restore 11,7 s, integridad
  OK). **No se conectó a producción**: escribe `_litestream_lock` y
  `_litestream_seq` dentro de la base origen. Ver `ESTADO-DATOS.md`.
- Monitoreo: sin Docker, `scripts/vigilar.sh` + launchd `ar.resolver.vigilar`
  cada 60 s. Chequea local, túnel vía Worker y bot; alerta por Telegram con
  cooldown y aviso de recuperación. Prueba real con `SIGSTOP` al server: llegaron
  FALLA y RECUPERADO.
- `humo.sh` quedó **47 OK / 0 FAIL / 1 SKIP** (el SKIP es el túnel, realmente
  caído; lo cubre `vigilar.sh`).

---

## 10. Estado de ejecución real (2026-10-23)

### Hecho

| fase | estado | evidencia |
|---|---|---|
| 0 — preparación | hecho | `refs/`, `panel/vendor/`, snapshot `pre-repos.db`, `clonar-refs.sh` |
| 1 — Playwright | hecho | `tests/e2e/panel.spec.js`; hoy la suite completa tiene **28 tests** |
| 2 — backups/monitoreo | hecho | `backup-dbs.sh` + restore probado, `vigilar.sh` + alerta real |
| 3 — UI | hecho (3a–3f) | Tabler, SweetAlert2/Toastify, chip sin precio, Chart.js diferido, hotkeys-js, responsive + axe |
| 4 — Datasette | hecho | `127.0.0.1:3003`, `/datasette/*`, token = `RESOLVER_TOKEN`, 57 filas |
| 5 — performance/seguridad | hecho (5a–5f) | compression, cache, helmet, rate limit + XFF del Worker, zod, Lighthouse 98/95 |
| 6 — modelo de dominio | hecho | ledger doble entrada, máquina de pedidos, scopes de API keys, invariantes |
| Ops | hecho | 5 servicios en LaunchDaemons `system`, túnel con supervisor launchd, `:3001` solo loopback |

### Qué quedó afuera y por qué

- **Litestream sobre `padron.db`**: es estática y pesa 1,43 GiB; tiene backup
  semanal comprimido. Litestream se usa solo en `stock.db`.
- **`ar.resolver.backup` y `ar.resolver.caffeinate`**: siguen como
  LaunchAgents. El backup diario no arranca hasta login; se puede migrar con el
  mismo patrón de `deploy/daemons/` si se quiere.
- **FileVault**: los daemons eliminan el login gráfico, pero tras un corte de
  luz hace falta desbloquear el disco. Para reinicios programados:
  `sudo fdesetup authrestart`.
- **Tabler**: se adoptó el CSS base. No se reescribió el panel componente por
  componente ni se sumaron Grid.js, htmx, Alpine, uPlot, ninja-keys: la tabla y
  la interacción actuales funcionan y están cubiertas por E2E.
- **Datasette 0.65.4**, no 1.x: la máquina tiene Python 3.9. Se instaló en un
  venv (`varios/datasette-venv`), fuera del Python del sistema.
- **API keys viejas sin scopes**: conservan acceso completo por compatibilidad.
  Las nuevas usan scopes; el rate limit por token es en memoria (60/min).
- **Comisión**: la cuenta `comisiones:plataforma` y `wallet.comision()` existen,
  pero hoy ninguna venta dispara comisión automática (el campo
  `vendedores.comision` no se usa en el flujo de pago).
- **Docker/Uptime Kuma**: no hay Docker en la máquina; monitoreo con
  `vigilar.sh` + launchd + Telegram.
- **Túnel**: estaba caído de verdad (sin proceso ngrok). Ahora corre bajo
  `ar.resolver.tunel`; el Worker sigue siendo la entrada pública.

### Verificación vigente

```
bash scripts/e2e.sh                     -> 28 passed
node scripts/verificar.js               -> 32 OK / 0 FAIL
bash scripts/humo.sh                    -> 48 OK / 0 FAIL / 0 SKIP
node scripts/verificar-invariantes.mjs  -> 16 OK / 0 FAIL
node scripts/test-asientos.mjs          -> 11 OK / 0 FAIL
bash scripts/migrar-daemons.sh --verificar -> 0 fallas
```
