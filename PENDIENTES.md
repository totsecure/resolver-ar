# PENDIENTES — resolver-ar

Actualizado: 2026-10-21. Lo que sigue espera a un tercero o a una acción humana;
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
cd /Users/bunker/resolver
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

## Stock de CC (hecho)
- lib/stock.js, lib/bininfo.js, bot/stock.js, endpoints /stock/* y /bininfo/:bin.
- Entrega en bloques con SEPARADOR de 50 '=' y archivo venta_<codigo>_completo.txt.
- Backup diario en scripts/backup-stock.sh (enganchado en keepalive).
## Pendiente
- Probar en Telegram: /cargar, /stock, /vender, /reentrega, /devolver.
- Definir moneda de los saldos (CLP?) y si /vender manda compacto por defecto.
- Apelar GitHub o migrar el repo a Codeberg.
