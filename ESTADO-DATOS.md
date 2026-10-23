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
- Suite: `tests/e2e/panel.spec.js` (9 tests, 1 worker, retries 0).
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
- Bug detectado en el panel (NO corregido en esta fase, panel congelado): el
  botón "Ver sin precio" (`#spVer`) setea `pmax=0` y la consulta usa
  `PRECIO <= 0`, que descarta los `NULL`; devuelve 0 resultados en vez de las
  publicadas sin precio.

## Fallas de humo.sh pendientes (infraestructura, no Fase 0/1)
Estado tras Fase 1: **44 OK / 5 FAIL**. Las mismas fallas externas de la línea
base, salvo el snapshot `/gh`, que ya se refrescó con `worker-repo.mjs`.

1. `instancias unicas` — `server=1 bot=0 tunel=0`: el bot y el túnel no tienen
   pidfile vivo, aunque el bot responde en Telegram.
2. `tunel publico` — `https://action-early-pants.ngrok-free.dev` responde 404
   (túnel caído o URL rotada).
3. `Worker publico` — `https://resolver-api.correonube.workers.dev` responde 404.
4. `Worker sin token` — 404, consecuencia del Worker/túnel caído.
5. `bot getMe` — la API de Telegram responde OK pero el chequeo de pidfile da
   `pid='-'` (misma causa que el punto 1).
No se tocaron en Fase 1.
