# resolver-ar — reglas del proyecto

Leer también `CONTEXTO.md`.

## Comandos

```
node scripts/verificar.js                 18 tests offline (criterio de exito: 18 OK / 0 FAIL)
node cli.js probar <dni>                  informe + fuentes externas
node cli.js probar <dni> --offline        sin red
node cli.js stats                         invariantes del padron
node cli.js buscar <texto>                por apellido/nombre
node server.js                            http://localhost:3001/texto/<dni>
node importar.js <archivo>                reimport idempotente del padron AFIP
node scripts/cne.js estado                estado de la cache CNE (sin red)
node scripts/cne.js config                config del CNE + cache en datos/cne-config.json
node scripts/cne.js captcha               pide captcha -> /tmp/cne-captcha.jpg
node scripts/cne.js cache <dni>           fila cruda de la cache CNE
node scripts/cne.js consultar <dni> <m|f|x> <distritoId> <codigo> <token>
node scripts/cne.js probe                 diagnostico real del endpoint CNE
node scripts/ficha.js <dni> [genero] [--red] [--fuentes]
                                          ficha de 10 lineas; --fuentes declara origen
```

## Reglas duras

1. **Nunca inventar datos del padrón AFIP.** Lo que no está, no está. Si un DNI no
   figura, el resultado es "no encontrado" y no se completa con nada.
2. **Cada campo declara fuente**, con uno de estos valores:
   `REAL_AFIP | REAL_CNE | REAL_RENAPER | DERIVADO | SINTETICO | AUSENTE`.
   - `REAL_AFIP`: apellido, nombre, DNI, CUIT, situación impositiva (padrón ARCA/AFIP).
   - `REAL_CNE`: domicilio, localidad, fecha de ejemplar, circuito, sección,
     establecimiento, dirección de voto, mesa, orden, lat/lng, codRef (padrón CNE).
   - `REAL_RENAPER`: fecha de nacimiento, nro de trámite, dirección, ciudad,
     provincia, CP, CUIL del espejo público de RENAPER (NO oficial).
   - `DERIVADO`: sexo por prefijo de CUIT (20/27/23/24), CUIL candidato cuando el
     DNI no está, y `PAIS Argentina` en la ficha.
   - `SINTETICO`: mail y teléfono (lib/faker-ar.js).
   - `AUSENTE`: no hay dato (p. ej. CNE caído, RENAPER dormido o DNI fuera de cache).
3. **CUIL = el CUIT real del padrón, sin recalcular.** Se toma tal cual viene en la
   columna `cuit` (con o sin guiones según el contrato del campo). Solo si el DNI
   no figura se ofrecen CUIL candidatos, marcados `DERIVADO`.
4. **Determinismo:** mismo DNI ⇒ mismo mail y mismo teléfono, siempre.
   Semilla = FNV-1a 32 bits de `(dni + ':' + campo)`. Prohibido `Math.random()`.
   Regla del mail cuando faltan datos:
   - sin nombre ni apellido ⇒ `u<dni sin ceros>` (ej. `u23854064@gmail.com`);
   - con nombre y sin apellido ⇒ solo el nombre;
   - con apellido y sin nombre ⇒ solo el apellido;
   - **nunca** `personatitular`.
5. **Los tests no usan red.** El endpoint del CNE está caído (captcha 503) y
   RENAPER es un free tier que puede dormir. Todo lo que consulte red debe
   degradar a `AUSENTE` con `motivo`.
6. **No romper** `cli.js`, `server.js`, `importar.js`, `lib/validar.js`,
   `lib/resolver.js`, `lib/informe.js`.
7. **Backup `.bak` antes de parchear.** Los parches son idempotentes y llevan el
   marcador `AGENTS.md:`; si el marcador ya está, no se vuelve a aplicar.
8. **No tocar `datos/padron.db`** salvo crear (si faltan) las tablas `cne`,
   `cne_intentos`, `renaper` y `renaper_intentos`. El padrón es de solo lectura.
9. **Entorno:** Node 24, `node:sqlite` (NO `better-sqlite3`), macOS/zsh, ESM
   (`"type": "module"`). Rutas absolutas para la DB.

## Campos y fuentes

| campo | fuente | módulo |
|---|---|---|
| apellido, nombre, dni, cuit, cuil | REAL_AFIP | lib/resolver.js |
| situación impositiva (ganancias, iva, monotributo, …) | REAL_AFIP | lib/resolver.js |
| sexo | DERIVADO (prefijo CUIT) | lib/resolver.js |
| mail, teléfono | SINTETICO | lib/faker-ar.js |
| domicilio, localidad, fechaEjemplar, circuito, sección, establecimiento, direccionVoto, mesa, orden, lat, lng, codRef | REAL_CNE | lib/cne.js |
| fechaNac, nroTramite, dirección, ciudad, provincia, cpostal, cuilRenaper | REAL_RENAPER | lib/renaper.js |
| cobertura poblacional | calculada del padrón | lib/cobertura.js |

`lib/resolver.js` y `lib/informe.js` están envueltos (marcador `AGENTS.md:`) para
pasar todo resultado por `lib/enriquecer.js` (soporta promesas y arrays).
`lib/informe.js` además agrega `lineaCobertura()` si el resultado es un string
sin "COBERTURA POBLACIONAL", o setea `.cobertura` si es un objeto.

## Contrato real del CNE

Base: `https://www.padron.gob.ar` (mismo server que `www.padron.gov.ar`,
IP 170.246.76.10).

```
GET  {BASE}/padron-api/config/web.json
POST {BASE}/padron-api/captcha.jpg     -> cuerpo "token|segundos|base64(jpeg)"
POST {BASE}/padron-api/consulta        -> form-urlencoded
     c=<captcha>  e=""  m=<DNI>  d=<idDistrito>  s=<m|f|x>
```

- El `token` que devuelve el captcha va como **cookie** `token=<token>` en el
  request de `/consulta`.
- El jpeg del captcha se guarda en `/tmp/cne-captcha.jpg`.
- Respuesta de `/consulta` (claves de una letra):

  | clave | campo |
  |---|---|
  | `e` | domicilio |
  | `t` | localidad |
  | `j` | **fecha de EJEMPLAR** (no de nacimiento) |
  | `f` | circuito |
  | `g` | sección |
  | `h` | establecimiento |
  | `i` | dirección de voto |
  | `n` | mesa |
  | `o` | orden |
  | `p` / `q` | latitud / longitud |
  | `l` | codRef |
  | `s` | estado |

- **El CNE NO devuelve fecha de nacimiento.** El campo `j` es la fecha de
  ejemplar. Por eso el campo interno se llama `fechaEjemplar` y está prohibido
  derivar `anioNac`/`fechaNacimiento` de él.
- Errores: `400` validación · `401` captcha · `403` sesión · `404` no encontrado ·
  `406` versión · `409` distrito · `503` servicio no habilitado.

### Ids de distrito

| id | distrito |
|---|---|
| 1 | Capital Federal |
| 2 | Buenos Aires |
| 3 | Catamarca |
| 4 | Cordoba |
| 5 | Corrientes |
| 6 | Chaco |
| 7 | Chubut |
| 8 | Entre Rios |
| 9 | Formosa |
| 10 | Jujuy |
| 11 | La Pampa |
| 12 | La Rioja |
| 13 | Mendoza |
| 14 | Misiones |
| 15 | Neuquen |
| 16 | Rio Negro |
| 17 | Salta |
| 18 | San Juan |
| 19 | San Luis |
| 20 | Santa Cruz |
| 21 | Santa Fe |
| 22 | Santiago del Estero |
| 23 | Tucuman |
| 24 | Tierra del Fuego |
| 25 | Extranjeros-Buenos Aires |
| 28 | Argentinos en el exterior |
| 31 | Extranjeros-CABA |

`node scripts/cne.js config` imprime `SERVICIO CERRADO (mode=end, distritos
deshabilitados)` cuando `status.mode != "on"`.

### Estado del endpoint (2026-10-21)

- `config/web.json`: HTTP 200. Devuelve banner, `votacion.fecha=26-10-2025`,
  `status.mode="end"` y la lista de distritos con `estado:-1`.
- `captcha.jpg`: **HTTP 503** en ~0,3–0,7 s (HAProxy sin backends).
- `consulta`: sin captcha no se puede usar; con el captcha caído, timeout.
- Consecuencia: todo el sistema funciona **sin red**. `lib/cne.js` devuelve
  `fuente:'AUSENTE'` con `motivo` y registra el intento; nunca lanza.

### Cache CNE

Tablas en `datos/padron.db` (las únicas que este proyecto puede crear):

```sql
cne(dni PK, domicilio, localidad, fechaEjemplar, circuito, seccion,
    establecimiento, direccionVoto, mesa, orden, lat, lng, codRef,
    distrito, fuente, capturado, ttl_dias, crudo)
cne_intentos(id, dni, ts, http, motivo)
```

TTL 180 días. Log de intentos en `datos/cne.log`. `interpretar()` es pura (sin
red, sin DB). `obtenerSync()` lee **solo cache** salvo `opts.red === true` (y
aun así requiere captcha resuelto).

## Contrato RENAPER (espejo público, NO oficial)

Base: `https://apirnpr.onrender.com` (free tier de onrender: puede dormir).

```
GET {BASE}/renaper/{dni}/{genero}      genero = M | F | X
```

Respuesta JSON: `apellido`, `nombres`, `fechaNacimiento` (`YYYY-MM-DD`), `calle`,
`numeroCalle`, `ciudad`, `provincia`, `cpostal`, `monoblock`, `barrio`,
`municipio`, `cuil`, `idTramitePrincipal`, `codigoError` (200 = ok), `error`
(bool), `descripcionError`.

- Fuente declarada: **`REAL_RENAPER`**. Si un campo viene vacío o `null`, es
  `AUSENTE`: no se completa ni se deriva.
- `interpretar()` (pura) mapea:
  `fechaNacimiento → fechaNac` (dd/mm/aaaa) · `idTramitePrincipal → nroTramite`
  · `calle + numeroCalle → direccion` · `ciudad → ciudad` · `provincia →
  provincia` · `cpostal → cpostal` · `cuil → cuilRenaper`.
- `codigoError != 200` o `error:true` ⇒ `fuente:'AUSENTE'` + `motivo`.
- **Timeout 60 s** (`RENAPER_TIMEOUT_MS`). Cualquier fallo ⇒ `AUSENTE` con
  motivo; las funciones nunca lanzan.
- Por defecto **solo cache**. La red se habilita con `opts.red === true` (en la
  ficha: `--red` o `FICHA_RED=1`).
- Provider por env: `RENAPER_BASE` (default el espejo), `RENAPER_USER` y
  `RENAPER_PASS` (si están, se manda `Authorization: Basic`), `RENAPER_API_KEY`
  (header `X-API-Key`) y `RENAPER_PATH` (template; default
  `/renaper/{dni}/{genero}`). El módulo agrega el path a la base.
- Cache: tabla `renaper` con TTL **365 días**; intentos en `renaper_intentos` y
  `datos/renaper.log`.

```sql
renaper(dni PK, fechaNac, nroTramite, direccion, ciudad, provincia,
        cpostal, cuilRenaper, fuente, capturado, ttl_dias, crudo)
renaper_intentos(id, dni, ts, http, motivo)
```

Exports de `lib/renaper.js`: `BASE`, `TTL_DIAS`, `asegurar`, `leer`, `guardar`,
`interpretar`, `consultarRemoto`, `obtener`, `obtenerSync`, `stats`.

## Ficha (`lib/ficha.js`)

`ficha(dni, opts)` devuelve **exactamente 10 líneas**, en este orden:

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

Precedencia por campo (la primera fuente con dato):

| campo | orden |
|---|---|
| TITULAR | REAL_AFIP → REAL_RENAPER → AUSENTE |
| DNI | REAL_AFIP → REAL_RENAPER → AUSENTE |
| NRO TRAMITE, FECHA NAC | REAL_RENAPER → AUSENTE |
| DIRECCION, CIUDAD, PROVINCIA | REAL_RENAPER → REAL_CNE (cache) → AUSENTE |
| MAIL, TELEFONO | SINTETICO |
| PAIS | DERIVADO (`Argentina`) |

- Campo `AUSENTE` ⇒ `-`. El DNI se imprime siempre con 8 dígitos.
- `FECHA NAC` sale **solo** de RENAPER: jamás se usa `fechaEjemplar` del CNE.
- Si el DNI no está en AFIP, la ficha se arma igual con RENAPER y `TITULAR`
  declara `REAL_RENAPER`.
- `telefonoDigitos(dni, persona)` (lib/faker-ar.js) devuelve área+número sin 0
  ni 15: CABA/GBA `11` + 8 dígitos; interior área + 7.

## API y deploy

`server.js` (puerto `PORT`, default 3001) mantiene `/texto/:dni` y
`/persona/:dni`. Agrega endpoints de **solo lectura**:

| endpoint | respuesta |
|---|---|
| `GET /health` | `{ok, version, db, personas}` |
| `GET /ficha/:dni?genero=M` | ficha de 10 líneas (`text/plain`) |
| `GET /stats` | personas, ambiguos, cobertura, tablas, filas cne/renaper |
| `GET /informe/:dni` | informe completo (`text/plain`) |

Auth: `Authorization: Bearer <RESOLVER_TOKEN>` o `?token=<RESOLVER_TOKEN>`.
Si `RESOLVER_TOKEN` está vacío no se exige token (modo dev); si está seteado y
falta o no coincide, responde `401`.

Deploy (`deploy/`): `Dockerfile` (node:24-alpine, `npm ci --omit=dev`, EXPOSE
3001), `Caddyfile` (HTTPS automático), `resolver.service` (systemd,
`Restart=always`, `WorkingDirectory=/opt/resolver`,
`EnvironmentFile=/etc/resolver.env`), `deploy.sh` (git pull + npm ci + restart,
idempotente) y `.env.example` (`PORT`, `RESOLVER_TOKEN`, `RESOLVER_DB`, `TZ`).

## Cobertura

5.664.575 personas físicas reales sobre ~35.000.000 de electores ≈ 16,18 %.
"No encontrado" es el caso **normal**. 1.735 DNIs tienen más de un CUIT; se
ordena de forma determinista y se informa el bloque "DNI AMBIGUO".
La cobertura se cachea 7 días en `datos/cobertura.json`.
