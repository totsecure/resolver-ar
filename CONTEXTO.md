# CONTEXTO — resolver-ar

Dado un DNI, devolver un informe con datos **REALES** del padrón de ARCA/AFIP y,
si hay cache, domicilio electoral del CNE. Faker **solo** para mail y teléfono.
Reglas duras en `AGENTS.md`.

## ESTADO (2026-10-21, verificado)

- `node scripts/verificar.js` → **18 OK / 0 FAIL**, exit 0 (100 % offline).
- `node cli.js probar 3348` → exit 0.
- `node scripts/cne.js estado` → exit 0, sin red.
- `node scripts/cne.js config` → HTTP 200. `status.mode = "end"`,
  `online_since = 13/11/2025 07:00` (local), `votacion.fecha = 26-10-2025`,
  `instancia = "-1"`. Cache en `datos/cne-config.json`.
- `node scripts/ficha.js 23854064 --red` → exit 0 con RENAPER `AUSENTE`
  (el simulador solo tiene 30123456 y 33456789).
- `node scripts/ficha.js 30123456 --red` / `33456789 --red` → datos del
  simulador (`facuPonceGit/RenaperService`), **no reales**.
- DB: `datos/padron.db`, 5.664.575 personas físicas reales de 6.199.556 líneas.
- Invariantes: `COUNT(*) = 5.664.575` · CUIT duplicados = 0 · DNIs con más de un
  CUIT = 1.735 · inválidas = 0 · largos != 51 = 0.
- Cobertura: 5,66 M sobre ~35 M electores = **16,18 %**.
  **"No encontrado" es el caso NORMAL, no un error del resolver.**
- Tablas nuevas en la DB: `cne`, `cne_intentos`, `renaper` y `renaper_intentos`
  (creadas por `lib/cne.js` y `lib/renaper.js`). El padrón no se modifica.

## CÓMO CORRER

```
node scripts/verificar.js                  18 tests offline
node cli.js probar <dni>                   informe + BCRA
node cli.js probar <dni> --offline         sin red
node cli.js stats                          invariantes
node cli.js buscar <texto>                 por apellido/nombre
node server.js                             http://localhost:3001/texto/<dni>
node importar.js ~/afip/utlfile/padr/*.tmp reimport idempotente
node scripts/cne.js estado                 cache + intentos (sin red)
node scripts/cne.js captcha                pide captcha (hoy 503)
node scripts/cne.js cache <dni>            fila cruda de cache
node scripts/cne.js consultar <dni> <m|f|x> <distritoId> <codigo> <token>
node scripts/cne.js probe                  config + captcha reales
node scripts/ficha.js <dni> [genero] [--red] [--fuentes]
                                            ficha de 10 lineas + fuentes
PORT=3001 RESOLVER_TOKEN=secreto node server.js
                                            API con auth (token vacio = dev)
```

## MÓDULOS

| archivo | rol |
|---|---|
| `lib/faker-ar.js` | mail/teléfono SINTÉTICO determinista (FNV-1a + mulberry32) |
| `lib/cne.js` | contrato real del CNE, cache, intentos, `interpretar()` pura |
| `lib/renaper.js` | cliente de RenaperService (simulador): fechaNac, dirección, género |
| `lib/ficha.js` | ficha de 10 líneas con precedencia de fuentes |
| `lib/cobertura.js` | cobertura del padrón + ambiguos, cache 7 días |
| `lib/enriquecer.js` | agrega SINTÉTICO y lee CNE de cache; no pisa reales |
| `lib/resolver.js` | resuelve DNI contra el padrón (+ wrapper de enriquecimiento) |
| `lib/informe.js` | render de texto (+ wrapper de cobertura) |
| `lib/fuentes.js` | BCRA y CNE best-effort, no bloqueantes |
| `scripts/verificar.js` | los 18 tests |
| `scripts/cne.js` | CLI del CNE |
| `scripts/ficha.js` | CLI de la ficha (`--red`, `--fuentes`) |

## FUENTES POR CAMPO

`REAL_AFIP | REAL_CNE | REAL_RENAPER | DERIVADO | SINTETICO | AUSENTE`

- **REAL_AFIP**: apellido, nombre, DNI, CUIT, CUIL, sexo (prefijo → DERIVADO),
  sucesión, ganancias, IVA, monotributo, integrante sociedad, empleador, actividad.
- **REAL_CNE**: domicilio, localidad, fechaEjemplar, circuito, sección,
  establecimiento, dirección de voto, mesa, orden, lat/lng, codRef.
- **REAL_RENAPER**: fechaNac, dirección, ciudad, provincia, cpostal y género
  (contrato del simulador; `nroTramite`/`cuil` no vienen y quedan `AUSENTE`).
- **SINTETICO**: mail y teléfono. Deterministas: mismo DNI ⇒ mismo valor.
  Mail sin nombre ni apellido: `u<dni sin ceros>` (ej. `u23854064@gmail.com`);
  con uno solo de los dos, solo ese dato. Nunca `personatitular`.
- **AUSENTE**: sin dato. Nunca se completa con inventos.

`CUIL = CUIT real del padrón, sin recalcular`. Solo si el DNI no figura se
ofrecen candidatos `DERIVADO` (prefijo 20/27 y DV recalculado).

## CONTRATO REAL DEL CNE

Base `https://www.padron.gob.ar` (mismo server que `www.padron.gov.ar`,
IP 170.246.76.10). Módulo: `lib/cne.js`. Constantes exportadas:
`BASE`, `TTL_DIAS`, `DISTRITOS`, `asegurar`, `leer`, `guardar`, `interpretar`,
`pedirCaptcha`, `consultarRemoto`, `obtener`, `obtenerSync`, `stats`.

```
GET  {BASE}/padron-api/config/web.json
POST {BASE}/padron-api/captcha.jpg   -> "token|segundos|base64(jpeg)"
POST {BASE}/padron-api/consulta      -> form-urlencoded
     c=<captcha>  e=""  m=<DNI>  d=<idDistrito>  s=<m|f|x>
```

- El token del captcha va como cookie `token=<token>` en `/consulta`.
- El jpeg se guarda en `/tmp/cne-captcha.jpg`.
- Respuesta (claves de una letra): `e` domicilio · `t` localidad ·
  `j` **fecha de ejemplar** · `f` circuito · `g` sección · `h` establecimiento ·
  `i` dirección de voto · `n` mesa · `o` orden · `p`/`q` lat/lng · `l` codRef ·
  `s` estado.
- **NO devuelve fecha de nacimiento.** `j` es fecha de EJEMPLAR; no se deriva
  `anioNac` de ahí.
- Errores: `400` validación · `401` captcha · `403` sesión · `404` no encontrado ·
  `406` versión · `409` distrito · `503` servicio no habilitado.

### IDs de distrito

`1` CABA · `2` Buenos Aires · `3` Catamarca · `4` Córdoba · `5` Corrientes ·
`21` Santa Fe · `24` Tierra del Fuego · `25` Extranjeros-BA.

### Estado del endpoint (hoy)

- `config/web.json`: **HTTP 200**. Banner "Elecciones Nacionales y Provinciales",
  `votacion.fecha = 26-10-2025`, `votacion.instancia = "-1"`,
  `status.mode = "end"`, `status.online_since = 1763089200000` =
  **13/11/2025 07:00 local** (ya pasó), 27 distritos con `estado:-1`.
  `nacional.enabled` y `provincial.enabled`: **AUSENTE** (el config no trae esas
  claves; no se inventan).
- `captcha.jpg`: **HTTP 503** en ~0,3 s. Reintentado 3 veces con 20 s de espera:
  los 3 dieron 503 (HAProxy sin backends). No insistir con la red.
- `consulta`: inutilizable sin captcha.
- Por eso **todo funciona sin red**: `fuente:'AUSENTE'` + `motivo`, sin lanzar.
  Los tests no tocan la red.
- `node scripts/cne.js config` trae el config, lo cachea en
  `datos/cne-config.json` e imprime status, votación, distritos y estado.
- Variantes probadas: `config/web.json?ts=1` y `?v=2` → **HTTP 200**, mismo
  payload de 1.657 bytes (`mode=end`). No hay otro config vigente.
- Dictamen que imprime `config`: `SERVICIO CERRADO (mode=end, distritos
  deshabilitados)` cuando `mode != "on"`. `DISTRITOS` tiene los 27 nombres
  (ids 1..25, 28 y 31).

### Cache CNE

`cne(dni PK, domicilio, localidad, fechaEjemplar, circuito, seccion,
establecimiento, direccionVoto, mesa, orden, lat, lng, codRef, distrito, fuente,
capturado, ttl_dias, crudo)` · TTL 180 días.
`cne_intentos(id, dni, ts, http, motivo)` · log en `datos/cne.log`.
`interpretar()` es pura. `obtenerSync()` lee solo cache salvo `opts.red === true`.

## CONTRATO RENAPER (RenaperService, SIMULADO)

Base `https://renaperservice.onrender.com`. **No es RENAPER real:** es el
simulador `facuPonceGit/RenaperService` (UTN-FRT), con solo dos DNIs
hardcodeados: `30123456` (GOMEZ, MARIA, F) y `33456789` (PEREZ, JUAN, M).
El RENAPER real sigue pendiente hasta que reabra el CNE.

```
GET {BASE}/api/personas/{dni}?genero={M|F|X}
Header: X-API-Key: <RENAPER_API_KEY>
```

- `RENAPER_BASE` default `https://renaperservice.onrender.com`.
- `RENAPER_API_KEY` default la key pública del README del servicio.
- `RENAPER_PATH` default `/api/personas/{dni}?genero={genero}`.
- `interpretar()` pura mapea los campos EXACTOS del JSON:
  `fechaNacimiento` (YYYY-MM-DD) → `fechaNac` (dd/mm/aaaa);
  `domicilio.calle + domicilio.numero` → `direccion`;
  `domicilio.localidad` → `ciudad`;
  `domicilio.provincia` → `provincia`;
  `domicilio.codigoPostal` → `cpostal`;
  `nombre` → `nombres`; `apellido` → `apellido`; `sexo` → `sexo`.
  `nroTramite` y `cuil` NO vienen en el JSON → `AUSENTE` (null).
- Género: se deriva del prefijo del CUIT del padrón (20/23/24 → M, 27 → F).
  Si el DNI no está en el padrón o la consulta da 404, se prueba M, F, X.
  El género que funcionó se guarda en `renaper.genero`.
- TTL **365 días**. `renaper` + columna `genero` (agregada sin perder datos);
  `renaper_intentos` y `datos/renaper.log` como antes.
- Por defecto **solo cache**; red solo con `opts.red === true` (`--red` /
  `FICHA_RED=1`).
- **OJO colisión:** `30123456` existe en AFIP como FERNANDEZ MARIA BELEN; la
  ficha prioriza AFIP para TITULAR y el simulador aporta fechaNac/dirección de
  GOMEZ. Es un artefacto de prueba; no usar en producción.
- Historial: `apirnpr.onrender.com` (roto), `apirenaper.idear.gov.ar` (403),
  etc. Se descartaron. No se buscan más mirrors.

Exports de `lib/renaper.js`: `BASE`, `TTL_DIAS`, `asegurar`, `leer`, `guardar`,
`interpretar`, `consultarRemoto`, `obtener`, `obtenerSync`, `stats`.

## FICHA (lib/ficha.js + scripts/ficha.js)

`ficha(dni, opts)` devuelve exactamente 10 líneas:

```
TITULAR <APELLIDO> <Nombres>
DNI <8 dígitos>
NRO TRAMITE <11 dígitos>
FECHA NAC <dd/mm/aaaa>
MAIL <mail>
TELEFONO <solo dígitos, sin 0 ni 15>
DIRECCION <CALLE NUMERO en mayúsculas; sin número => 0>
CIUDAD <localidad>
PROVINCIA <provincia>
PAIS Argentina
```

Precedencia (la primera fuente con dato):

| campo | orden |
|---|---|
| TITULAR, DNI | REAL_AFIP → REAL_RENAPER → AUSENTE |
| NRO TRAMITE, FECHA NAC | REAL_RENAPER → AUSENTE |
| DIRECCION, CIUDAD, PROVINCIA | REAL_RENAPER → REAL_CNE (cache) → AUSENTE |
| MAIL, TELEFONO | SINTETICO |
| PAIS | DERIVADO (`Argentina`) |

- AUSENTE ⇒ `-`. El DNI siempre con 8 dígitos.
- `FECHA NAC` nunca sale de `fechaEjemplar` del CNE.
- DNI fuera de AFIP: la ficha se arma con RENAPER y `TITULAR` declara
  `REAL_RENAPER`.
- `telefonoDigitos()`: CABA/GBA `11` + 8 dígitos; interior área + 7.

## PADRÓN AFIP (fuente verificada)

URL: `https://www.afip.gob.ar/genericos/cInscripcion/archivos/apellidoNombreDenominacion.zip`
— HTTP 200, 82 MB zip → 322.376.912 bytes, 6.199.556 registros, latin-1.

Registro de 51 chars + `\n` (stride 52), índices 0-based:
`0-10 CUIT | 11-40 denominación | 41-42 Ganancias | 43-44 IVA | 45-46 Monotributo
| 47 Integrante Soc | 48 Empleador | 49-50 Actividad`.
Atención: la doc de ARCA lista Actividad en 51/52 — es off-by-one; el layout
49-50 es el correcto (confirmado con pyafipws).

- Ordenado por CUIT, 0 CUIT duplicados.
- Prefijos físicas: 20: 2.745.637 · 27: 2.381.556 · 23: 507.521 · 24: 29.861.
- Jurídicas (30/33/34) filtradas por `importar.js`.
- DNI = `cuit[2:10]`, siempre padded a 8 (`normalizarDni`).
- 1.735 DNIs con dos CUIT (dos personas). `ORDER BY` determinista + bloque
  "DNI AMBIGUO". Caso real: `00421954` → MENDONCA (20) y BARONI (27).
- La denominación viene truncada a 30 chars en el origen.

## OTRAS FUENTES

- **BCRA**: `api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/{cuit}`. Flapea.
  404 = SIN_DATOS (no es caída). Timeout 8 s, 2 intentos, tolerante a no-JSON.
  Trae denominación: se cruza contra el padrón y se declara si no coincide.
- **CNE**: ver contrato arriba.
- **RENAPER**: `https://renaperservice.onrender.com/api/personas/{dni}?genero={M|F|X}`
  con `X-API-Key`. Es un **simulador** (solo 30123456 y 33456789), no el
  RENAPER real. Ver contrato arriba.
- `cuitonline.com/search.php?q=<cuit|nombre>` como plan C.
- Descartadas: padrón PASO 2021 (solo totales), padrón 2017 (timeout),
  ARCA REST `sr-padron/v2` (404; requiere certificado).

## API Y DEPLOY

- `server.js` mantiene `/texto/:dni` y `/persona/:dni`. Nuevos, de solo lectura:
  `GET /health` · `GET /ficha/:dni?genero=M` · `GET /stats` · `GET /informe/:dni`.
- Auth: `Authorization: Bearer <RESOLVER_TOKEN>` o `?token=<RESOLVER_TOKEN>`.
  Si `RESOLVER_TOKEN` está vacío, no se exige token (modo dev). Sin token: 401.
- `deploy/Dockerfile`: `node:24-alpine`, `npm ci --omit=dev`, `EXPOSE 3001`,
  `CMD ["node","server.js"]`. La DB va por volumen en `/app/datos`.
- `deploy/Caddyfile`: reverse proxy a `127.0.0.1:3001` con HTTPS automático.
- `deploy/resolver.service`: systemd, `Restart=always`,
  `WorkingDirectory=/opt/resolver`, `EnvironmentFile=/etc/resolver.env`.
- `deploy/deploy.sh`: git pull + `npm ci --omit=dev` + `systemctl restart`
  (idempotente; crea usuario `resolver` y el env file si faltan).
- `deploy/.env.example`: `PORT`, `RESOLVER_TOKEN`, `RESOLVER_DB`, `TZ`.

## Estado de fuentes

| fuente | estado | qué falta | cómo activarla |
|---|---|---|---|
| AFIP / padrón | OK (5.664.575 físicas) | nada | `node importar.js <archivo>` |
| CNE | config 200; captcha 503 | backend del CNE (HAProxy sin backends) | cuando captcha dé 200: `node scripts/cne.js captcha` y `node scripts/cne.js consultar 23854064 M 2 <CODIGO> <TOKEN>` |
| RENAPER | **roto** (`error:true`) | backend del espejo | `RENAPER_BASE` + `RENAPER_USER`/`RENAPER_PASS` apuntando a un provider propio |
| BCRA | intermitente (flapea 520/200) | momento de 200 | `node cli.js probar <dni>` |
| SINTÉTICO (mail/tel) | OK, determinista | nada | `lib/faker-ar.js` |
| Cobertura | OK (cache 7 días) | nada | `lib/cobertura.js` |

## NOTAS DE IMPLEMENTACIÓN

- ESM (`"type": "module"`), Node 24, `node:sqlite`, macOS/zsh.
- `lib/resolver.js` y `lib/informe.js` tienen un wrapper marcado
  `AGENTS.md:` que pasa todo por `lib/enriquecer.js` (promesas y arrays).
  `lib/informe.js` agrega `lineaCobertura()` si falta la cobertura.
- Parches idempotentes: si el marcador `AGENTS.md:` ya está, no se reaplica.
- Backup `.bak` antes de tocar archivos.
- `datos/cobertura.json` se recalcula cada 7 días; el cálculo recorre 5,6 M de
  filas (una sola vez).
- Advertencia `ExperimentalWarning: SQLite` es normal en Node 24.
- `PROCEDENCIA REAL_AFIP` del informe es **por campos** (p. ej. `80% (12/15
  CAMPOS del informe)`), no por población. No confundir con `COBERTURA
  POBLACIONAL` (~16,18 %).
- `cne_intentos` y `renaper_intentos` solo aceptan intentos con DNI real; los
  captchas sueltos van únicamente al `.log` con `dni:null`.
- No tocar `scripts/cne-diag.sh` ni `scripts/padron-alt.sh` (diagnóstico).

## PENDIENTE

1. Cuando el backend del CNE vuelva (captcha 200), usar
   `node scripts/cne.js probe` y luego `captcha` + `consultar` para poblar la
   cache real (domicilio y fecha de ejemplar).
2. Reintentar BCRA en un momento de 200 para validar el camino DISPONIBLE.
3. Probar RENAPER con `node scripts/ficha.js <dni> --red` cuando el free tier
   esté despierto; la cache dura 365 días.
