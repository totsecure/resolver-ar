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
- `datos/server.env` para el server (`PORT`, `RESOLVER_TOKEN`, `RESOLVER_DB`, `TZ`).
- `datos/bot.env` para el bot (`TELEGRAM_TOKEN`, opcional `TELEGRAM_ALLOW`).

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
# 29 OK / 0 FAIL  (exit 0)

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

Endpoints de **solo lectura** (header `Authorization: Bearer <token>` o
`?token=<token>`; si `RESOLVER_TOKEN` está vacío no se exige token):

| endpoint | respuesta |
|---|---|
| `GET /health` | `{ok, version, db, personas}` |
| `GET /stats` | personas, ambiguos, cobertura, tablas, filas `cne`/`renaper` |
| `GET /ficha/:dni?genero=M` | ficha de 10 líneas (`text/plain`); `&red=1` habilita RENAPER |
| `GET /informe/:dni` | informe completo (`text/plain`); `?offline=1` sin BCRA |
| `GET /lote?cards=...&desde=1&saltar=0` | bloques de lote (`text/plain`), header `X-Ms` |
| `GET /titulares?n=10&saltar=0` | bloques de titulares sin tarjeta (`text/plain`) |

`/texto/:dni` y `/persona/:dni` siguen existiendo sin token (compatibilidad).

Ejemplos locales:

```bash
curl -s 'http://localhost:3001/health?token=resolver2026'
curl -s 'http://localhost:3001/ficha/30756789?token=resolver2026'
curl -s 'http://localhost:3001/lote?token=resolver2026&cards=4111111111111111%7C12%7C28%7C123'
```

## Usar desde un chat agéntico

URL pública (Worker de Cloudflare):

```text
https://resolver-api.correonube.workers.dev
```

Token:

```text
resolver2026
```

Ejemplo de `/lote` con una tarjeta:

```bash
curl -s 'https://resolver-api.correonube.workers.dev/lote?token=resolver2026&cards=4111111111111111%7C12%7C28%7C123&desde=1&saltar=0'
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
continua. El comando `/lote` del bot ya hace esta paginación internamente
(`generarLotePaginado`).

El Worker reenvía a ngrok (`https://action-early-pants.ngrok-free.dev`), que
publica el server local. Si ngrok free muestra una página de aviso en un
navegador, los endpoints con `curl` y token funcionan directo.

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
- Lo que no se puede asignar se devuelve como **sobrantes** y el bot lo lista en
  un mensaje aparte.

## Scripts

| script | qué hace |
|---|---|
| `scripts/server.sh` | arranca/reinicia `server.js` con `datos/server.env`; idempotente; `--force` reinicia. |
| `scripts/bot.sh` | arranca/reinicia `bot/telegram.js` con `datos/bot.env`; no duplica. |
| `scripts/tunel.sh` | asegura el server y publica ngrok en el dominio fijo; guarda `datos/tunel.url`. |
| `scripts/keepalive.sh` | vigila server, bot y túnel; relanza con el entorno correcto y registra motivo en `datos/keepalive.log`. |
| `scripts/humo.sh` | prueba de humo completa, sin abortar; sale 0 solo si todo OK. |
| `scripts/verificar.js` | 29 tests offline. |
| `scripts/ficha.js` | ficha por CLI; `--red` habilita RENAPER. |
| `scripts/cne.js` | config/captcha/consulta/cache del CNE. |
| `scripts/indexar.js`, `scripts/ordenar.js`, `scripts/pool.js` | índices, orden estable del lote y pool de DNIs. |
| `cli.js` | informe por CLI (`probar`, `stats`, `buscar`). |
| `importar.js` | reimport idempotente del padrón AFIP. |

## Túnel y keepalive

- URL fija: `https://action-early-pants.ngrok-free.dev` (`datos/tunel.url`).
- Worker: `https://resolver-api.correonube.workers.dev` → ngrok → `localhost:3001`.
- `scripts/keepalive.sh` corre cada 60 s y vigila **los tres**: `server.js`,
  `bot/telegram.js` y el túnel. Si alguno falla, lo relanza con `server.env` /
  `bot.env` y deja una línea con fecha y motivo en `datos/keepalive.log`.
- No duplica procesos: los scripts de arranque son idempotentes.
- `ngrok config add-authtoken <token>` se configura una vez.

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

Variables: `PORT`, `RESOLVER_TOKEN`, `RESOLVER_DB`, `TZ`
(`America/Argentina/Buenos_Aires`).

Detalle de pendientes y plan de escalado: `PENDIENTES.md`.
Reglas de desarrollo: `AGENTS.md`.
