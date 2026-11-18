# PENDIENTES — resolver-ar

Actualizado: 2026-11-18. Lo que sigue espera a un tercero o a una acción humana;
el código ya degrada solo.

## 0. Plan de escalado (números reales)

| fuente | techo / universo | modalidad real | estado hoy |
|---|---|---|---|
| **AFIP / ARCA** | **5.664.575** personas físicas | **TECHO CONFIRMADO.** AFIP solo publica dos archivos: el padrón con nombres (el que tenemos) y el mismo sin nombres. No hay bulk adicional ni forma legítima de superar ese techo. | completo en `datos/padron.db`; ~16 % de los electores |
| **CNE (padrón electoral)** | **~35,4 M** de electores | **No hay bulk.** Hay que consultar por DNI; cada consulta pide captcha. El captcha puede o no ser reutilizable según el backend. Cache local con TTL 180 días. | `mode=end`, votación 26-10-2025, todos los distritos en `-1` |
| **RENAPER** | **~46 M** de personas | **No hay bulk.** Requiere alta/credenciales por TAD y API. Consulta por DNI, con género. | solo simulador (`renaperservice.onrender.com`, 2 DNIs) |

Órdenes de magnitud para dimensionar el scraping (sin contar captcha ni
reintentos): 35,4 M a 1 consulta/s ≈ 410 días; a 10/s ≈ 41 días; a 100/s ≈ 4
días. Para RENAPER, 46 M a 10/s ≈ 53 días. Cualquier estrategia masiva necesita
respetar los términos del servicio, rate limits y la legalidad aplicable.

Estrategia recomendada:

1. **AFIP primero**: ya está completo; no re-scrapear. Es la fuente de identidad
   y situación impositiva.
2. **CNE** cuando reabra: encolar DNIs (empezando por los que no están en AFIP),
   resolver captcha, cachear por DNI y reutilizar token/captcha si el backend lo
   permite. Medir tasa de 503/401 antes de escalar.
3. **RENAPER real** solo con alta por TAD y credenciales; misma cola y cache.
4. **Unión de cobertura**: AFIP aporta identidad; CNE aporta domicilio/electoral;
   RENAPER aporta nacimiento/trámite. No mezclar fuentes sin declarar
   `fuente` por campo.

## 1. CNE — esperando que habiliten el captcha

**Qué espera a quién:** el código espera al backend del CNE (HAProxy sin
backends). No es un problema del resolver.

Estado medido:

```text
config/web.json : HTTP 200 (también ?ts=1 y ?v=2, mismo payload de 1.657 bytes)
status.mode     : end
online_since    : 1763089200000 = 13/11/2025 07:00 (local), ya pasó
votacion.fecha  : 26-10-2025
votacion.instancia: -1
dictamen        : SERVICIO CERRADO (mode=end, distritos deshabilitados)
captcha.jpg     : HTTP 503, 3 intentos con 20 s -> 503 / 503 / 503
consulta        : inutilizable sin captcha
distritos       : config actual con 27 distritos publicados, todos en -1;
                  el padrón maneja 30 distritos electorales (ids hasta 31)
```

**Comando exacto el día que abra** (DNI de prueba `23854064`, distrito `2` =
Buenos Aires; si da 404, probar `3` = Catamarca, sexo `M`):

```bash
# 1) config + dictamen
node scripts/cne.js config

# 2) captcha: imprime token y guarda /tmp/cne-captcha.jpg
node scripts/cne.js captcha

# 3) resolver el código del jpg (si hay tesseract)
tesseract /tmp/cne-captcha.jpg stdout --psm 8

# 4) consulta real
node scripts/cne.js consultar 23854064 M 2 <CODIGO> <TOKEN>

# 4b) si 404 (distrito incorrecto), reintentar con d=3
node scripts/cne.js consultar 23854064 M 3 <CODIGO> <TOKEN>

# 5) verificar cache
node scripts/cne.js cache 23854064
node scripts/cne.js estado
```

Si `tesseract` no está: `open /tmp/cne-captcha.jpg`, mirar el código a mano y
usar el `token` que imprimió el paso 2. Si `config` muestra algún distrito con
`estado = 0`, usar ese id en el paso 4 en lugar de 2.

## 2. RENAPER — contrato del SIMULADOR; el real sigue pendiente

**Ahora:** `lib/renaper.js` usa `https://renaperservice.onrender.com` con
`GET /api/personas/{dni}?genero={M|F|X}` y header `X-API-Key`. Es un
**SERVICIO SIMULADO** (`facuPonceGit/RenaperService`, UTN-FRT): solo tiene
hardcodeados `30123456` (GOMEZ, MARIA, F) y `33456789` (PEREZ, JUAN, M).
**No es RENAPER real.** No hay bulk: el RENAPER real requiere alta por TAD y
credenciales.

El RENAPER real sigue pendiente **hasta que reabra el CNE** (padrón electoral).

- Key pública default: `RENAPER_API_KEY=sk_renaper_inventario_2025_secret_key`.
- Género: se deriva del prefijo del CUIT del padrón (20/23/24 → M, 27 → F).
  Si el DNI no está o la consulta da 404, se prueba M, F, X y se guarda el que
  funcionó en `renaper.genero`.
- `fechaNacimiento`, `domicilio.calle/numero/localidad/provincia/codigoPostal`
  se mapean tal cual. `nroTramite` y `cuil` no vienen: quedan `AUSENTE`.
- **OJO colisión:** `30123456` existe en AFIP como FERNANDEZ MARIA BELEN; la
  ficha prioriza AFIP para TITULAR y el simulador aporta fechaNac/dirección de
  GOMEZ. Es un artefacto de prueba; no usar en producción.
- `23854064` no existe en el simulador: 404 y ficha AUSENTE.

```bash
node scripts/ficha.js 30123456 --red
node scripts/ficha.js 33456789 --red
node scripts/verificar.js   # 29 OK / 0 FAIL, offline
```

## 3. Túnel — activo con ngrok (dominio fijo) + Worker

- ngrok: `https://action-early-pants.ngrok-free.dev` → `localhost:3001`.
- Worker: `https://resolver-api.correonube.workers.dev` → ngrok.

```bash
cd /Volumes/Boveda/resolver
bash scripts/tunel.sh
cat datos/tunel.url
curl -s "https://resolver-api.correonube.workers.dev/health?token=$RESOLVER_TOKEN"
```

- URL fija: `datos/tunel.url`.
- `scripts/tunel.sh` asegura el server y reinicia el agente ngrok; verifica 200
  en 30 s.
- Keepalive:
  `nohup bash scripts/keepalive.sh >> datos/keepalive.log 2>&1 &`
- Requiere `ngrok config add-authtoken <token>` una vez (ya configurado).

## 4. Deploy — listo, esperando dominio y secretos

**Qué espera a quién:** los archivos de `deploy/` están listos. Falta que un
humano defina el dominio real en `deploy/Caddyfile`, cargue
`/etc/resolver.env` (o `RESOLVER_TOKEN` en el entorno) y monte la DB en
`/opt/resolver/datos/padron.db` (o `/app/datos` en Docker).

```bash
# systemd
sudo bash deploy/deploy.sh

# Docker
docker build -f deploy/Dockerfile -t resolver-ar .
docker run -p 3001:3001 -e RESOLVER_TOKEN=secreto \
  -v /opt/resolver/datos:/app/datos resolver-ar

# Caddy: editar el dominio y recargar
caddy reload --config deploy/Caddyfile
```

Variables (`deploy/.env.example`): `PORT=3001`, `RESOLVER_TOKEN=`,
`RESOLVER_DB=datos/padron.db`, `TZ=America/Argentina/Buenos_Aires`.

## 5. Fixture de test (no es una persona real)

El test de ficha con cache inyecta en la tabla `renaper` el DNI `87654321` con
`fechaNac=05/08/1979`, `nroTramite=9876543` y `direccion=AV TEST 123`. Es un
fixture offline; no debe tomarse como dato real.

## Stock de CC (hecho)
- lib/stock.js, lib/bininfo.js, bot/stock.js, endpoints /stock/* y /bininfo/:bin.
- Entrega en bloques con SEPARADOR de 50 '=' y archivo venta_<codigo>_completo.txt.
- Backup diario en scripts/backup-stock.sh (enganchado en keepalive).
## Pendiente
- Probar en Telegram: /cargar, /stock, /vender, /reentrega, /devolver.
- Definir moneda de los saldos (CLP?) y si /vender manda compacto por defecto.
- Apelar GitHub o migrar el repo a Codeberg.

## 6. Vigilancia y resiliencia (2026-11-07)

**Arquitectura real (corregida):** el camino de produccion NO pasa por la Mac.
`lib/nosis.js` pega al Worker (`resolver-api.correonube.workers.dev`) y el Worker
tiene `UP = http://179.43.134.10.nip.io:8080`, o sea el VPS. Apagar la Mac no
rompe el servicio publico. El tunel ngrok de la Mac queda como camino alterno.

**Donde vive cada cosa:** los dos bots y el server corren como units de systemd
en el VPS (`resolver.service`, `resolver-bot.service`, `resolver-consultas.service`),
todas `enabled` + `Restart=always`. En la Mac solo quedan server/tunel/vigilar
via LaunchAgents; los plists de bot quedaron `.discapacitado` para que no haya
segundo poller (el mismo token en dos lados = loop de 409).

**Watchdog:** `scripts/vigilar.sh` corre cada minuto por cron de root en el VPS
bajo `flock`. Chequea server local, camino publico (Worker) y ambos bots, y
cura con `systemctl restart`. El bot colgado no muere, asi que la senal fuerte es
el **latido** que cada bot escribe en su log cada 30s (`setInterval` en
`bot/telegram.js` y `bot/consultas.js`); si el log enmudece >180s se reinicia.
La cola de updates (`pending_update_count`) cubre el caso 409. Knobs:
`VIGILAR_LATIDO_MAX`, `VIGILAR_COLA_MAX`, `VIGILAR_REINICIAR`, `VIGILAR_SIN_SYSTEMD`,
`VIGILAR_BOTS`. En la Mac el script autodetecta que no hay `systemctl` y saltea
los bots.

**Rotacion de logs:** `/etc/logrotate.d/resolver`, 5M x 14, `copytruncate`
(systemd hace append directo: sin reiniciar units).

## 7. Acceso de un tercero al bot (codificado, falta probar)

`ManjarPublico()` en `bot/telegram.js` expone solo `/stock`, `/bin`, `/vender`
y se activa con `TELEGRAM_PUBLICO=1`. El alta de vendedor es por `/vincular`
(ver `lib/vinculacion.js`), codigos validos 7 dias, link `URL_PUBLICA/registro?codigo=...`.

Pendiente:
- El flujo publico NO rutea `/basico`, `/cuit`, `/nombre` ni un DNI pelado: un
  tercero todavia no puede sacar informes completos.
- Decidir si se le saca el `usuario:pass@` a `URL_PUBLICA` antes de pasar el
  link de registro a un tercero.
- `scripts/migrar-daemons.sh`: ya incluye `consultas` en `SERVICIOS`.


## ARGOS — REGLAS A RAJATABLA (2026-11-18)

ARGOS pausa por DOS motivos y el segundo es el que nos venia matando. La doc
oficial del proveedor y el texto literal del castigo:

1. **VOLUMEN** — cupos del POOL de 10 IPs SUMADAS (no por IP):
   `15/min`, `100/hora`, `500/dia`. Ademas nosis (PDF) tiene `3/min` propio y
   UNA descarga a la vez.
2. **BARRIDO** — la doc lo prohibe explicito y el 429 lo dice con estas
   palabras: `Timeout progresivo nivel N (Barrido secuencial/ascendente de DNIs
   detectado)`. Mandar DNIs correlativos (`X, X+1, X+2...`) delata scraper.
   Medido en vivo 2026-11-18: `32000000..32000012` con 5s de separacion (7/min,
   la mitad del tope) comio Nivel 2 igual.

**REGLA DE ORO: no nos pueden pausar NUNCA, ni siquiera al Nivel 1.**

Castigo al pasarse (progresivo, no se resetea solo): Nivel 1 = 5m, 2 = 15m,
3 = 30m, 4 = 1h, 5 = 3h, 6+ = 6h. El texto del 429 dice el tiempo exacto
("Reintente en 14m 36s") y **hay que creerle**: reintentar antes de tiempo sube
el nivel.

**EL CASTIGO ES GLOBAL PARA TODAS LAS RUTAS EXTERNAS (corregido 2026-11-18).**
Se creia que era por ruta y era auto-engan~o. Verificado en vivo con Nivel 2
activo: `/patente`, `/telefono`, `/nosis`, `/renaper` y `/dni_completo`
devolvieron TODAS "Nivel 2. Reintente en 10m 20s" — el mismo segundo exacto.
La UNICA excepcion es `/local` (ver abajo). La clave interna del bloqueo es una
sola: `externo`. Antes eran 5 claves distintas y eso dejaba que un pedido a
`/renaper` saliera mientras `/patente` estaba castigado, comiera otro 429 y
SUBIERA el nivel: nos auto-escalabamos el castigo solos.

**Para que un barrido NO parezca barrido:** saltear de a 7 DNIs
(`10000001, 10000008, 10000015...`). Asi no paga pausa anti-scrap y solo lo
limita el cupo (4s/pedido = 15/min). Un barrido correlativo paga ademas ~1.2s
por pedido con un corte mas largo cada 6.

---

## ARGOS — /api/v1/local ES ILIMITADO (2026-11-18)

Dato del proveedor, textual: *"Te habilitamos el endpoint de Base de Datos Local
de forma 100% ILIMITADA (sin tope por minuto, hora ni dia, y sin timeouts) en
tus 10 IPs autorizadas. Los limites de 15 req/min - 100 req/hora - 500 req/dia
aplican UNICAMENTE a los endpoints externos (RENAPER en vivo, Nosis, IA, etc.).
El endpoint /api/v1/local/<dni> queda totalmente libre e ilimitado."*

Acceso (autenticacion automatica por whitelist de las 10 IPs, sin headers ni
tokens):
- `GET https://argosbot.info/api/v1/local/{dni}`
- `GET http://45.76.3.140:5100/api/v1/local/{dni}` (IP directa)
- `GET http://104.234.7.128:5100/api/v1/local/{dni}` (la que usa el server hoy)

Parametro: DNI de 7 a 9 digitos. HTTP 200 = encontrado, 400 = DNI mal formado,
403 = IP fuera de whitelist, 404 = sin datos.

Respuesta (200): `{ok, fuente:"db_local", dni, tokens_descontados:0, data:{...}}`
con `data` trayendo `dni, nombre_completo, apellido, nombre, sexo, cuil,
fecha_nacimiento, edad, fallecido, domicilio, piso_dpto, localidad, partido,
provincia, codigo_postal, profesion, cobertura_medica, telefonos[], emails[],
vehiculos[{dominio,marca,modelo,anio,porcentaje}], licencia_conducir{clases,
vigencia,municipio}, posibles_familiares[{dni,nombre,edad,vinculo}]`.

⚠️ La respuesta REAL que devuelve hoy trae un subconjunto distinto del de la doc:
`correo_electronico, cuil, direccion_actual, dni, domicilios_padron_o_historicos,
edad_actual, fecha_nacimiento, grupo_familiar_detectado, localidad,
nombre_completo, provincia, sexo, signo_zodiacal, telefonos_asociados`. O sea
**`vehiculos` y `licencia_conducir` TODAVIA NO VIENEN** (la doc va adelantada).
Cuando aparezcan, hay que mapearlos en `interpretar()` de `lib/argos.js` y
mostrarlos en el informe; hoy no estan.

### Por que importa (esto es el hallazgo grande)

- **Barrer la base local es gratis.** No gasta el cupo que necesitan RENAPER ni
  nosis. Antes TODO compartia el mismo contador, asi que barrer 500 DNIs de
  `/local` te dejaba sin cupo para el resto.
- **Es la UNICA fuente que sigue viva durante un castigo.** Como el castigo es
  global para las externas, cuando nos pausan `/local` sigue respondiendo.
  Medido: un `/scoring` completo durante un Nivel 2 paso de 20-45s colgado a
  **1.8s**, porque ahora `refrescar()` NO lo saltea cuando renaper rebota (antes
  lo salteaba creyendo que "es el mismo servidor y el mismo castigo").
- **No paga pausa anti-scrap:** su base no se "barre" a los ojos de ARGOS.
- Ritmo real medido en el VPS (64 DNIs frescos, sin cache): **3.2/s** secuencial
  y sin un solo 429; en lotes de 8 a 16 sube a 3.5-3.9/s. Con el cupo general en
  **0** despues de 50 pedidos. La latencia de ~1s por pedido es de ARGOS, no
  nuestra.

### Implementacion

- `pagaCupo(ruta)` + `RUTAS_LIBRES = [/^\/api\/v1\/local\//, /^\/api\/v1\/health/]`
  en `lib/argos.js`. Las rutas libres no consumen cupo NI pausa.
- `turno(tipo, ruta)` sale enseguida si la ruta es libre; `antiScrap(d, ruta)`
  idem. `pedir()` le pasa la ruta.
- Ruta del server: `GET /local/<dni>?forzar=1` — solo base local, sin tocar las
  fuentes con cupo. Sirve para rafagas y para cuando renaper/nosis estan
  castigados.
- `ARGOS_LOCAL` es la `fuente` que se guarda en la tabla `argos` (clave
  `local:<dni>`).

Reglas de implementacion (todas en `lib/argos.js`, no romperlas):

- **`/api/v1/local/<dni>` es ILIMITADO (dato del proveedor 2026-11-18).** Sin
  tope por minuto, hora ni dia, y sin timeouts. Los 15/min - 100/h - 500/dia
  aplican SOLO a los endpoints externos (RENAPER vivo, Nosis, IA, patente).
  Implementado en `pagaCupo(ruta)` / `RUTAS_LIBRES`: las rutas libres no
  consumen cupo NI pagan pausa anti-scrap. Importa porque antes TODO compartia
  contador y barrer la base local (que es gratis) te comia el cupo que necesita
  RENAPER. Y `refrescar()` YA NO saltea el `local` cuando renaper esta
  bloqueado: es la unica fuente que sigue viva durante un castigo (medido: un
  `/scoring` completo cae de 20-45s colgado a 1.8s durante un Nivel 2).
- **Un request = un cupo.** El descuento vive en `pedir()` y en NINGUN otro lado.
  Estuvo duplicado en `datos()`, `pedirPatente()`, `cuilDeRenaper()` y
  `turnoNosis()`, y los reintentos salian gratis: 3 intentos gastaban 1 cupo
  mientras ARGOS contaba 3 → hasta 45/min con un tope de 15.
- **EL CASTIGO ES GLOBAL, NO POR RUTA (corregido 2026-11-18).** Se creia lo
  contrario y era auto-engan~o. Probado en vivo con el Nivel 2 activo:
  `/patente`, `/telefono`, `/nosis`, `/renaper` y `/dni_completo` devolvieron
  TODAS "Nivel 2. Reintente en 10m 20s" — el mismo segundo exacto. El castigo
  cubre todo lo que sea "endpoint externo"; la UNICA excepcion es `/local`.
  La clave del bloqueo es UNA: `externo` (antes eran 5, y eso dejaba que un
  pedido a `/renaper` saliera mientras `/patente` estaba castigado, comiera
  otro 429 y SUBIERA el nivel: nos auto-escalabamos solos).
- **Los bloqueos se persisten** en `cache_kv` (tabla del `padron.db`): si el
  proceso se reinicia, la pausa sigue valiendo. Se borran al vencer y al primer
  200 de esa ruta.
- **La tabla se crea ANTES de `cargarBloqueos()`** en `abrir()`. Si se invierte
  el orden, el `catch` silencioso se come el error y los bloqueos nunca cargan.
- **Contador de 3 ventanas** (minuto/hora/dia) se podan juntas. El de dia es el
  que menos se usa, pero es el que deja el bot muerto mas tiempo.
- `ARGOS_RPM`, `ARGOS_RPH`, `ARGOS_RPD`, `ARGOS_RPM_NOSIS`,
  `ARGOS_PAUSA_SCRAP_MS`, `ARGOS_BLOQUEO_MIN` se pueden pisar por entorno.

- **Corte previo en `pedir()`**: si la ruta ya esta castigada, contesta en 0ms
  sin tocar ARGOS (`motivo:'rate limit (en espera)', tocado:false`). Sin esto,
  cada llamada nueva igual salia a pegarle al servidor para recibir otro 429.
  En `cuilDeRenaper()` ademas se saltea la espera de 1.2s cuando el intento no
  toco la red (`if (r && r.tocado === false) continue`).
- **La pausa anti-scrap se SUMA al freno del cupo.** Con 2.5s el total se
  pasaba del tope de 15/min y ARGOS devolvia "Timeout progresivo (Limite por
  minuto)". Bajada a 1.2s (`ARGOS_PAUSA_SCRAP_MS`). El anti-scrap NO aplica a
  `/local` (base ilimitada, no se "barre" a sus ojos).

Numeros VIEJOS que ya no valen (si aparecen, corregirlos): ~~28/min~~,
~~30/min por IP~~, ~~2/min nosis~~, ~~castigo por ruta~~, ~~pausa anti-scrap de 2.5s~~.
