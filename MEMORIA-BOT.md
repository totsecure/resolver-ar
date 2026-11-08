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

- **`ARGOS_BASE` apuntaba a `127.0.0.1:5100`**, un túnel ya eliminado. Todo
  ARGOS daba `fetch failed`. Debe ser la IP.
- **`console.error` no llega a `datos/server.log`**: `resolver.service` tiene
  `StandardError=inherit` (va a journal) y `StandardOutput=append:server.log`.
  Para depurar usar `console.log`.
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
