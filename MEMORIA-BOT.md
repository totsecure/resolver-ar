# MEMORIA — bot de consultas de scoring

Estado al 2026-11-08. Lo que sigue documenta decisiones, trampas y verificación
del trabajo hecho sobre `/scoring`, el respaldo NOSIS y los límites anti-spam.

## Qué se construyó

`/scoring <dni>` mide riesgo crediticio. Camino real:

1. ARGOS (`ARGOS_BASE` = `http://104.234.7.128:5100`) da identidad y, si lo
   tiene, el CUIL. **ARGOS casi nunca trae `cuil`** — no confiar en él.
2. Se prueban CUILs derivados por prefijo (`20, 27, 23, 24, 33`) con el DV
   calculado por `lib/validar.js`. Se corta en el primero que el BCRA dé
   `DISPONIBLE`. **El BCRA es la fuente de verdad, no se adivina el sexo.**
3. Si el BCRA no está `DISPONIBLE` (404, 503, caído), se cae al informe NOSIS
   que ARGOS sirve en `/api/v1/nosis/<dni>`.

## Semáforo (criterio del dueño)

- verde `1-2` y "sin deudas" → `EN REGLA`
- amarillo `3-4` → `OJO`
- rojo `5-6` → `NO USABLE`. **Situación 5 es rojo porque no se puede operar.**
- **404 del BCRA = verde `EN REGLA (sin historial en el BCRA)`.** Decisión del
  dueño: no figurar es informacion del BCRA, no una ausencia. Un gris parecia
  un fallo del bot.
- gris `⬜` SOLO cuando el BCRA no respondio y no hay NOSIS cacheado
- El color real en Telegram son los emojis: `<pre>` no tiene color propio.

## Trampas que costaron tiempo

- **`forzar: true` en `armarScoring` era un ancla de 25s.** `datosDeDni` con
  `forzar` IGNORA el cache y **espera** el refresco contra ARGOS. Cada
  `/scoring` pagaba 25s aunque el dato estuviera cacheado hacia 30 dias. La
  medicion que lo aisla: `/persona` 14ms vs `/scoring` 24532ms. Sacar el
  `forzar` dejo `/scoring` en 10ms con cache y el refresco pasa a background.
  Regla: si el cache es fresco, no forzar; el TTL ya decide.
- **El servicio "gordo" (`GORDO_BASE`, puerto 5000) esta MUERTO** y cuelga 25s
  por intento, x2 = 50s. Como es el PRIMER paso de `refrescar`, cada DNI nuevo
  pagaba ese timeout entero. Circuit breaker de 10 min en `lib/gordo.js`:
  33s -> 2-3s. Los DNIs nuevos ya no se pagan los 50s.
- **ARGOS_BASE apuntaba a `127.0.0.1:5100`**, un túnel ya eliminado. Todo
  ARGOS daba `fetch failed`. Debe ser la IP.
- **`console.error` no llega a `datos/server.log`**: `resolver.service` tiene
  `StandardError=inherit` (va a journal) y `StandardOutput=append:server.log`.
  Para depurar usar `console.log`.
- **El BCRA tira `503 en mantenimiento` por horas.** Con el loop probando los 5
  CUILs candidatos y cada uno reintentando 3 veces, eran ~15 llamadas con
  backoff por consulta. Ahora hay circuit breaker (10 min) y el loop corta al
  primer intento. Ojo: el `503` NO es un error del pedido, es el servicio
  entero; reintentar tiene sentido UNA vez, no en cada DNI.
- **ARGOS hace 429 con concurrencia**: el informe NOSIS necesita una cola
  secuencial (`enFila`). Nunca ponerlo en el camino sincrónico de `/scoring`.
- **Un DNI que NOSIS no resuelve (504 a los 180s) congelaba la cola entera.**
  Hay penalidad de 15 min (`fallidos`/`PENALIDAD_MS`) revisada en `precalentar`
  y arriba del closure de `refrescar`.
- **`/health` disparaba un `git status` en `/opt/resolver`, que no es repo.**
  60.994 líneas de `fatal: not a git repository` en el log. Se silencia el
  stderr con `stdio: ['ignore','pipe','ignore']`.
- **El BCRA estuvo en mantenimiento** (`503 El servicio se encuentra en
  mantenimiento`) y por eso todo salía gris: el respaldo NOSIS solo cubría 404.
  Ahora cubre cualquier estado no `DISPONIBLE`.
- **El `429` no se reintentaba**: el filtro era `>= 500`. Es justo el error que
  mas merece reintento. Ahora `REINTENTABLE` cubre 429 y 5xx, 3 intentos, y el
  429 espera 1.5s. Antes una rafaga de comandos se comia el rate-limit.
- **Etiquetar siempre `(NOSIS)`**: `Sin deudas encontradas` de NOSIS NO es una
  afirmación oficial del BCRA.
- **El anti-spam tenia DOS problemas, no uno.** El segundo: el cooldown de 2.5s
  frenaba el uso real. Medido del log del grupo: la gente escribe un DNI cada
  ~2.2s, o sea que pasaba por el cooldown CADA mensaje y recibia un aviso por
  cada uno (captura real: 17 "Espera un toque" apilados en un minuto). El
  cooldown ahora es 1.2s y el aviso sale solo si el que escribe venia de estar
  quieto (>1s). Resultado medido con el patron real: antes 10 pasan / 10
  avisos, ahora 20 pasan / 0 avisos. En rafaga pegada (400ms) tampoco avisa.
  Regla: el aviso de cooldown es la unica senal de vida del bot, asi que a
  menos que el usuario este spameando de verdad, mejor no decir nada.
- **El anti-spam tenia un riel que no soltaba.** `frenar()` re-escribia
  `ultimoDe` TAMBIEN en el camino frenado, asi que la marca se corria hacia
  adelante en cada mensaje: quien tipeaba un DNI cada 3.5s (menos que el
  cooldown de 4s) quedaba frenado PARA SIEMPRE y veia "Espera un toque" o nada.
  Ahora solo se marca cuando el mensaje PASA. Reproducible con un simulador de
  6 lineas (esta en el historial): intervalos de 3.5s daban FRENADO en las 5
  iteraciones.
- **ARGOS sirve RENAPER de forma INTERMITENTE.** Medido con `41250188`: 9 de
  11 llamadas seguidas a `/api/v1/renaper/<dni>` dan **404** y las otras 2 dan
  **200 con el cuil**, sin patrón; al rato se invierte. O sea que **el 404 de
  RENAPER no significa "no está"**: significa "esta vez no lo sirvió". Con un
  solo intento, el informe marcaba el CUIL como PRESUNTO y hasta daba por
  inexistente a gente que sí tiene datos (`37354048`, `41649704`, `42850893` y
  `40407094` fallaban casi siempre y hoy resuelven todos). Fix: `cuilDeRenaper`
  reintenta 4 veces con espera creciente (~12s) **y cachea el cuil en la tabla
  `argos`** bajo la clave `r:<dni>` (no la pelada, que es del gordo). Una vez
  que aparece, sale de caché en milisegundos y deja de depender de la suerte.
  Las rachas de 404 duran varios segundos: reintentar muy junto cae entero
  adentro de la misma racha y no sirve.
- **La tabla `argos` tiene PK solo en `dni`.** Guardar un registro de RENAPER
  con el dni pelado **PISA el del gordo** y ensucia el cache de `datosDeDni`,
  que filtra por `fuente`. Por eso el cuil de RENAPER se cachea con el prefijo
  `r:` y se lee por endpoint directo, sin pasar por `datos()`.
- **El CUIL derivado por prefijo hay que marcarlo como PRESUNTO hasta que una
  fuente lo confirme.** Con 5 prefijos matemáticamente válidos y el BCRA mudo
  en los 5, mostrarlo pelado hacía creer que era un dato. Ahora la línea dice
  `(confirmado por BCRA)`, `(confirmado por RENAPER)` o `(PRESUNTO, sin
  confirmar)`. Dato duro: en los 19 DNIs del grupo, **cada CUIL que RENAPER
  confirmó coincidió exacto con la derivación** — la matemática nunca estuvo
  mal, lo que faltaba era con qué probarla.

## Límites anti-spam

En los DOS bots (consultas y ventas). Cooldown `LIMITE_COOLDOWN_MS` = 4s por
chat y tope `LIMITE_EN_VUELO` = 4 comandos en vuelo. Una ráfaga manda UN aviso.
`frenar()` devuelve tres estados: texto = aviso, `''` = frenado sin aviso,
`null` = pasa. `/ayuda` y `/estado` nunca se bloquean.

## Cobertura medida

92 % sobre la muestra de 25 (`/tmp/l25.txt` en el VPS), con el BCRA caído.
Baseline era 78 %. Los 2 que fallan (`04390431`, `06719067`) dan 504 en ARGOS
mismo: NOSIS no los resuelve, no es nuestro bug.

## Comandos

`/scoring` pelado, `/completo` con identidad y familia, `/pdf` manda el informe
NOSIS crudo como archivo (si no está cacheado avisa que lo prepara, ~45s).
`/informe` usa el padrón viejo (16 % cobertura) y trae datos impositivos que
NOSIS no tiene; se deja como está a propósito.

## Verificación antes de decir "listo"

```sh
node --check server.js lib/argos-informe.js bot/stock.js bot/consultas.js
md5 -q server.js   # comparar contra md5sum en /opt/resolver
ssh pl2 'systemctl is-active resolver resolver-bot resolver-consultas'
ssh pl2 'tail -2 /opt/resolver/datos/consultas.log'   # latido cada 30s
```

Un solo proceso por servicio: dos bots con el mismo token = loop de 409.
