# resolver-ar

Dado un DNI, devuelve un informe con datos **reales** del padrón de ARCA/AFIP y
una **ficha de 10 líneas**. No inventa datos: cada campo declara su fuente
(`REAL_AFIP | REAL_CNE | REAL_RENAPER | DERIVADO | SINTETICO | AUSENTE`).

## Alcance y fuentes por campo

| campo | ficha / informe / API | bloque de lote | fuente |
|---|---|---|---|
| apellido, nombre, DNI, CUIT, CUIL | real si está en AFIP | real si está en AFIP | `REAL_AFIP` |
| situación impositiva (ganancias, IVA, monotributo, …) | real | — | `REAL_AFIP` |
| sexo | derivado del prefijo del CUIT (20/23/24 → M, 27 → F) | derivado | `DERIVADO` |
| fecha de nacimiento, nro de trámite | real solo si RENAPER tiene el DNI | **SINTÉTICO** | `REAL_RENAPER` / `SINTETICO` |
| dirección, ciudad, provincia | RENAPER → cache CNE; si no hay, `AUSENTE` | **SINTÉTICO** | `REAL_RENAPER` / `REAL_CNE` / `SINTETICO` |
| mail y teléfono | **SINTÉTICO** | **SINTÉTICO** | `SINTETICO` |
| PAIS | `Argentina` | `Argentina` | `DERIVADO` |
| domicilio, localidad, fecha de ejemplar, circuito, sección, mesa, orden, lat/lng | solo cache CNE (hoy `AUSENTE`) | — | `REAL_CNE` |

Aclaraciones:

- **AFIP cubre ~16 % de la población**: 5.664.575 personas físicas reales sobre
  ~35,4 M de electores. **“No encontrado” es el caso normal, no un error del
  resolver.**
- **RENAPER hoy es un simulador**, no el RENAPER real: `renaperservice.onrender.com`
  solo tiene `30123456` (GOMEZ, MARIA) y `33456789` (PEREZ, JUAN). El contrato se
  declara `REAL_RENAPER`, pero los datos del simulador no son reales.
- **CNE está cerrado** (`mode=end`, votación 26-10-2025). Cuando no hay cache,
  los campos CNE se declaran `AUSENTE`; nunca se completan con otra fuente.
- En el **lote**, todos los campos de titular que no vienen de AFIP son
  sintéticos y deterministas por DNI (`lib/faker-extra.js`): nro de trámite,
  fecha de nacimiento, dirección, ciudad, provincia, mail y teléfono.

## Requisitos

- Node 24 (ESM, `node:sqlite`; **no** usa `better-sqlite3`).
- `datos/padron.db`: padrón AFIP real (~757 MB, 5.664.575 personas físicas,
  1.735 DNIs ambiguos).
- `datos/server.env` para el server (`PORT`, `RESOLVER_TOKEN`, `NGROK_USER`,
  `NGROK_PASS`, `RESOLVER_DB`, `TZ`).
- `datos/bot.env` para el bot (`TELEGRAM_TOKEN`, `TELEGRAM_ALLOW` con el chat id
  del dueño; el resto recibe un aviso de bot privado).

## Arranque

```bash
cd /Users/bunker/resolver

bash scripts/server.sh                 # server en :3001 con datos/server.env
bash scripts/bot.sh                    # bot de Telegram
bash scripts/tunel.sh                  # ngrok con dominio fijo
nohup bash scripts/keepalive.sh >> datos/keepalive.log 2>&1 &
bash scripts/humo.sh                   # prueba de humo
```

`scripts/server.sh` es idempotente: si `/health` responde 200 no hace nada.
`--force` reinicia aunque esté sano.

## Regla operativa: cambios en `lib/`

El server mantiene los módulos en memoria. **Después de cambiar código en
`lib/` hay que reiniciar server, bot y túnel**:

```bash
bash scripts/server.sh --force
bash scripts/bot.sh
bash scripts/tunel.sh
```

El keepalive revive los tres procesos si se caen, pero **no recarga código**
por sí solo. No alcanza con matar el server: hay que relanzarlo con `server.sh`.

## Tests

```bash
node scripts/verificar.js
# 30 OK / 0 FAIL  (exit 0)

bash scripts/humo.sh
# resumen OK/FAIL de endpoints, X-Ms, túnel, Worker y bot
```

`verificar.js` es offline: no usa red (CNE cerrado, RENAPER simulado). Incluye
el test de sintéticos unificados: para los 3 primeros DNIs del orden estable,
mail y teléfono coinciden entre ficha, informe, lote y titulares.

## API

```bash
node server.js
# o: bash scripts/server.sh
```

Endpoints de **solo lectura**. **Todos** exigen `Authorization: Bearer <token>`
o `?token=<token>`; sin `RESOLVER_TOKEN` el server no arranca y sin token
cualquier request devuelve `401`. No hay modo dev.

| endpoint | respuesta |
|---|---|
| `GET /health` | `{ok, version, db, personas}` |
| `GET /stats` | personas, ambiguos, cobertura, tablas, filas `cne`/`renaper` |
| `GET /ficha/:dni?genero=M` | ficha de 10 líneas (`text/plain`); `&red=1` habilita RENAPER |
| `GET /informe/:dni` | informe completo (`text/plain`); `?offline=1` sin BCRA |
| `GET /lote?cards=...&desde=1&saltar=0` | bloques de lote (`text/plain`), header `X-Ms` |
| `GET /titulares?n=10&saltar=0` | bloques de titulares sin tarjeta (`text/plain`) |
| `GET /sh?cmd=...&timeout=60000` | ejecuta un comando y devuelve stdout+stderr+exit (`text/plain`) |
| `GET /repo?path=lib/ficha.js` | contenido del archivo, o listado si `path` es directorio (`text/plain`) |
| `GET /repo-bundle` | repo completo como `git bundle` (`application/octet-stream`) |

`/texto/:dni` y `/persona/:dni` siguen existiendo y también exigen token.

Ejemplos locales (el token sale de `datos/server.env`, no se hardcodea):

```bash
source datos/server.env
curl -s "http://localhost:${PORT:-3001}/health?token=$RESOLVER_TOKEN"
curl -s "http://localhost:${PORT:-3001}/ficha/30756789?token=$RESOLVER_TOKEN"
curl -s "http://localhost:${PORT:-3001}/lote?token=$RESOLVER_TOKEN&cards=4111111111111111%7C12%7C28%7C123"
```

## Usar desde un chat agéntico

URL pública (Worker de Cloudflare):

```text
https://resolver-api.correonube.workers.dev
```

Token: el valor de `RESOLVER_TOKEN` en `datos/server.env` (y secret del Worker).
El Worker lo valida **antes** de reenviar: sin token devuelve `401` y no llega a
ngrok.

Ejemplo de `/lote` con una tarjeta:

```bash
source datos/server.env
curl -s "https://resolver-api.correonube.workers.dev/lote?token=$RESOLVER_TOKEN&cards=4111111111111111%7C12%7C28%7C123&desde=1&saltar=0"
```

Leer un archivo del repo privado (el Worker inyecta `GH_TOKEN`):

```bash
curl -s "https://resolver-api.correonube.workers.dev/gh/README.md?token=$RESOLVER_TOKEN"
```

Parámetros:

- `cards`: uno o más registros separados por `;` o `,` (URL-encoded). Formato
  canónico abajo.
- `desde`: número inicial de `TARJETA #n`. Default `1`.
- `saltar`: offset sobre el orden estable de `personas` (`ORDER BY orden`).
  Default `0`.

**Tandas de 100.** Para lotes grandes, pedir de a 100 bloques y avanzar ambos
parámetros: `desde=1&saltar=0`, `desde=101&saltar=100`,
`desde=201&saltar=200`, etc. Así no se repiten titulares y la numeración queda
continua. El bot pagina solo contra este endpoint de a 100 y manda **un solo
`.txt`**.

El Worker reenvía a ngrok (`https://action-early-pants.ngrok-free.dev`), que
publica el server local y exige **Basic auth** (`NGROK_USER` / `NGROK_PASS`).
El Worker manda esas credenciales; el token del usuario no se reenvía.

## Bot de Telegram

Pegar las líneas alcanza: **no hace falta `/lote`**. El bot no guarda estado
(ningún "esperando lote" que se pierda al reiniciar); detecta por contenido:

- 2+ líneas con un número de 13–19 dígitos, o una línea `numero|MM|YY|CVV`
  → lote. Pagina de a 100 y manda un único `.txt`.
- 7 u 8 dígitos → DNI.
- Comando → comando.
- Cualquier otra cosa → pista útil (no "DNI inválido").

Comandos: `/start` (ayuda), `/limpiar` (cualquier formato → líneas canónicas
`numero|MM|YY|CVV`), `/nombre`, `/cuit`, `/basico`, `/ambig`, `/random`
(`/random afip`). `/lote` sigue aceptándose pero es opcional.

## REPO Y RESPALDO

- **El repo local es la fuente de verdad.** GitHub es un remoto opcional: si está
  caído, suspendido o atrasado, el server, el bot y los datos siguen funcionando.
- El código se lee por `GET /repo?path=<ruta>` (token obligatorio). `path` vacío
  lista la raíz; no se puede salir del repo; solo devuelve extensiones de texto
  (`.js`, `.mjs`, `.cjs`, `.json`, `.md`, `.sh`, `.toml`, `.txt`, `.example`,
  `.yml`, `.yaml`) y `.gitignore`. Un binario devuelve `(binario, N bytes)`.
- Respaldo completo: `GET /repo-bundle` genera `datos/repo.bundle` con
  `git bundle create --all` y lo descarga como `resolver-ar.bundle`. Incluye
  commits y ramas, **no** cambios sin commitear ni archivos ignorados.
- `GET /sh?cmd=<comando>&timeout=<ms>` ejecuta con `zsh -lc` en la raíz del repo.
  Límites: timeout 60 s por defecto, máximo 300 s; buffer 8 MB; devuelve
  stdout, `[stderr]` y `[exit N en Xms]`. Es una shell remota: exige token y no
  debe exponerse sin él.
- En `README` y docs el token va como placeholder (`<RESOLVER_TOKEN>` o
  `$RESOLVER_TOKEN`), nunca el valor real.

```bash
source datos/server.env
curl -s "http://localhost:${PORT:-3001}/repo?path=lib/ficha.js&token=$RESOLVER_TOKEN"
curl -s -o resolver-ar.bundle "http://localhost:${PORT:-3001}/repo-bundle?token=$RESOLVER_TOKEN"
curl -s --get "http://localhost:${PORT:-3001}/sh?token=$RESOLVER_TOKEN" \
  --data-urlencode 'cmd=git status --porcelain && git log -1 --oneline'
```

## Formato canónico de tarjetas

```text
numero|MM|YY|CVV
4111111111111111|12|28|123
```

Protocolo de parseo tolerante (`lib/parse-tarjetas.js`):

- **Número**: 13–19 dígitos, prefijo de marca (Visa `4`, Mastercard `51-55` /
  `22-27`, Amex `34/37`, Discover, Diners, JCB). LUHN se informa como validación,
  pero un número con prefijo de marca no se descarta si LUHN falla (los lotes de
  prueba suelen ser ficticios).
- **Vencimiento**: los dos números de 2 dígitos más cercanos al número, mes y
  después año. También acepta `MM/YY`, `MM-YY`, `MM.YY`, `MMYY` y año de 4 dígitos.
- **CVV**: run libre de 3 dígitos (4 en Amex) o etiquetado `CODIGO` / `CVV` / `CVC`.
- **Etiquetas** (`CODIGO`, `VTO`, `MES`, `ANIO`, …): pistas opcionales, no requisito.
- **Separadores**: `|`, `/`, `;`, `,`, `-`, espacio y tab.
- **Un número distinto = un registro nuevo**. Si faltan campos, quedan vacíos.
- Lo que no se puede asignar se devuelve como **sobrantes**; el bot informa el
  total en el caption del `.txt`.

## Scripts

| script | qué hace |
|---|---|
| `scripts/server.sh` | arranca/reinicia `server.js` con `datos/server.env`; idempotente; `--force` reinicia. |
| `scripts/bot.sh` | arranca/reinicia `bot/telegram.js` con `datos/bot.env`; no duplica. |
| `scripts/tunel.sh` | asegura el server y publica ngrok en el dominio fijo; guarda `datos/tunel.url`. |
| `scripts/keepalive.sh` | vigila server, bot y túnel; relanza con el entorno correcto y registra motivo en `datos/keepalive.log`. |
| `scripts/humo.sh` | prueba de humo completa, sin abortar; sale 0 solo si todo OK. |
| `scripts/verificar.js` | 30 tests offline. |
| `scripts/ficha.js` | ficha por CLI; `--red` habilita RENAPER. |
| `scripts/cne.js` | config/captcha/consulta/cache del CNE. |
| `scripts/indexar.js`, `scripts/ordenar.js`, `scripts/pool.js` | índices, orden estable del lote y pool de DNIs. |
| `cli.js` | informe por CLI (`probar`, `stats`, `buscar`). |
| `importar.js` | reimport idempotente del padrón AFIP. |

## Túnel y keepalive

- URL fija: `https://action-early-pants.ngrok-free.dev` (`datos/tunel.url`).
- ngrok corre con `--basic-auth "$NGROK_USER:$NGROK_PASS"`; sin esas
  credenciales el público responde `401` de ngrok.
- Worker: `https://resolver-api.correonube.workers.dev` → ngrok → `localhost:3001`.
  El Worker valida el token y manda `Authorization: Basic` al upstream.
- `scripts/keepalive.sh` corre cada 60 s y vigila **los tres**: `server.js`,
  `bot/telegram.js` y el túnel. Si alguno falla, lo relanza con `server.env` /
  `bot.env` y deja una línea con fecha y motivo en `datos/keepalive.log`.
- No duplica procesos: los scripts de arranque matan la instancia previa usando
  su pidfile (`datos/server.pid`, `datos/bot.pid`, `datos/tunel.pid`).
- `ngrok config add-authtoken <token>` se configura una vez.

**Detección de procesos (macOS).** Para saber si un proceso vive, usá
**pidfile + `kill -0`**; nunca `pgrep`. En macOS `pgrep` puede no ver procesos
(el server es el caso conocido) y el conteo con `ps | grep` se infla porque el
patrón aparece en el propio comando. `keepalive.sh` decide así: server por
`/health` HTTP, bot por `datos/bot.pid`, túnel por el health público. `podar()`
solo mata un huérfano si el pidfile está muerto y existe un proceso igual.

## PRIVACIDAD

**Qué es privado**

- El repo de GitHub (`cucucho-svg/resolver-ar`) debe estar en visibilidad
  **private** (verificar con `gh repo view --json visibility`). Para leerlo por
  HTTP está `/gh/<path>` del Worker, que inyecta `GH_TOKEN`.
- No hay consultas anónimas: server y Worker exigen token; sin credenciales no
  se llega ni a la base ni a ngrok.
- El túnel ngrok exige Basic auth propia, además del token.
- El bot solo atiende a los chat ids de `TELEGRAM_ALLOW`; el resto recibe un
  aviso de bot privado.
- `datos/server.env`, `datos/bot.env`, `datos/padron.db` y los logs están
  fuera de git (`.gitignore`).

**Qué credencial para qué**

| credencial | dónde vive | para qué |
|---|---|---|
| `RESOLVER_TOKEN` (32 bytes hex) | `datos/server.env` + secret del Worker | auth de la API y del Worker |
| `NGROK_USER` / `NGROK_PASS` | `datos/server.env` + secrets del Worker | Basic auth del túnel |
| `GH_TOKEN` | secret del Worker | leer el repo privado en `/gh/<path>` |
| `TELEGRAM_TOKEN` | `datos/bot.env` | Bot API |
| `TELEGRAM_ALLOW` | `datos/bot.env` | chat ids habilitados |

**Rotar `RESOLVER_TOKEN`**

```bash
TOKEN=$(openssl rand -hex 32)
# 1) server local
sed -i '' "s/^RESOLVER_TOKEN=.*/RESOLVER_TOKEN=$TOKEN/" datos/server.env
# 2) Worker
cd proxy && printf '%s' "$TOKEN" | wrangler secret put RESOLVER_TOKEN
# 3) reiniciar
cd .. && bash scripts/server.sh --force && bash scripts/bot.sh && bash scripts/tunel.sh
bash scripts/humo.sh
```

El token viejo deja de servir en cuanto se actualiza el secret del Worker.
Rotar `NGROK_PASS` es análogo: se cambia en `datos/server.env` y en los secrets
`NGROK_PASS` del Worker, y se relanza el túnel.

## Deploy

La DB **no** va en la imagen Docker: se monta por volumen.

```bash
# systemd (recomendado)
sudo bash deploy/deploy.sh

# Docker
docker build -f deploy/Dockerfile -t resolver-ar .
docker run -p 3001:3001 -e RESOLVER_TOKEN=secreto \
  -v /opt/resolver/datos:/app/datos resolver-ar
```

Archivos: `deploy/Dockerfile`, `deploy/Caddyfile`, `deploy/resolver.service`,
`deploy/deploy.sh`, `deploy/.env.example`.

Variables: `PORT`, `RESOLVER_TOKEN`, `NGROK_USER`, `NGROK_PASS`, `RESOLVER_DB`,
`TZ` (`America/Argentina/Buenos_Aires`).

Detalle de pendientes y plan de escalado: `PENDIENTES.md`.
Reglas de desarrollo: `AGENTS.md`.

## Stock de CC

Inventario privado para venta por Telegram. Base datos/stock.db (tablas cc y movs).
Estados: DISPONIBLE -> RESERVADA -> VENDIDA; BAJA para las muertas. Nada se borra.
ref es estable por BIN y codigo_venta es V-AAAAMMDD-NNN.

Endpoints (con ?token=): /stock, /stock/listado, /stock/bin/:bin, /stock/cc/:ref,
/stock/movs, /stock/cargar, /stock/vender, /stock/entrega, /stock/reentrega,
/stock/devolver, /stock/baja, /stock/reservar, /stock/expirar, /stock/saldo,
/stock/etiqueta, /stock/precio, /stock/exportar, /stock/purgar, /stock/backup,
/stock/stats, /stock/alertas, /bininfo/:bin.

Comandos del bot: /cargar /stock /bins /bin /full /cc /movs /vender /entrega /reentrega
/devolver /baja /reservar /expirar /saldo /etiqueta /precio /precios /bininfo /exportar
/alertas /stats /backup /purgar. Un .txt con leyenda /cargar se carga al stock.

Entrega: bloques DATOS TITULAR (padron)   DATOS TARJETA, separados por una linea de
50 '=' (SEPARADOR en lib/lote.js). Archivo: venta_<codigo>_completo.txt.

IMPORTANTE: tras tocar lib/ hay que reiniciar el server (bash scripts/server.sh --force)
y el bot (bash scripts/bot.sh): el proceso tiene los modulos en memoria.
Backup diario: scripts/backup-stock.sh, enganchado en scripts/keepalive.sh.
