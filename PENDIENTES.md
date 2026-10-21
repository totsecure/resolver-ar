# PENDIENTES — resolver-ar

Actualizado: 2026-10-21. Todo lo que sigue espera a un tercero o a una acción
humana; el código ya degrada solo.

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
distritos       : 27, todos con estado -1 (no hay ninguno con estado > 0)
```

**Comando exacto el día que abra** (DNI de prueba `23854064`, distrito `3` =
Catamarca; si da 404, probar `2` = Buenos Aires, sexo `M`):

```bash
# 1) config + dictamen
node scripts/cne.js config

# 2) captcha: imprime token y guarda /tmp/cne-captcha.jpg
node scripts/cne.js captcha

# 3) resolver el código del jpg (si hay tesseract)
tesseract /tmp/cne-captcha.jpg stdout --psm 8

# 4) consulta real
node scripts/cne.js consultar 23854064 M 3 <CODIGO> <TOKEN>

# 4b) si 404 (distrito incorrecto), reintentar con d=2
node scripts/cne.js consultar 23854064 M 2 <CODIGO> <TOKEN>

# 5) verificar cache
node scripts/cne.js cache 23854064
node scripts/cne.js estado
```

Si `tesseract` no está: `open /tmp/cne-captcha.jpg`, mirar el código a mano y
usar el `token` que imprimió el paso 2. Si `config` muestra algún distrito con
`estado = 0`, usar ese id en el paso 4 en lugar de 3.

## 2. RENAPER — contrato del SIMULADOR; el real sigue pendiente

**Ahora:** `lib/renaper.js` usa `https://renaperservice.onrender.com` con
`GET /api/personas/{dni}?genero={M|F|X}` y header `X-API-Key`. Es un
**SERVICIO SIMULADO** (`facuPonceGit/RenaperService`, UTN-FRT): solo tiene
hardcodeados `30123456` (GOMEZ, MARIA, F) y `33456789` (PEREZ, JUAN, M).
**No es RENAPER real.**

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
node scripts/verificar.js   # 18 OK / 0 FAIL, offline
```

El RENAPER real se activa cuando el CNE reabra; hasta entonces esto valida el
contrato y los tests offline.

## 3. Túnel — activo con ngrok (dominio fijo)

`https://action-early-pants.ngrok-free.dev` → `localhost:3001`.

```bash
cd /Users/bunker/resolver
bash scripts/tunel.sh
cat datos/tunel.url
curl -s "https://action-early-pants.ngrok-free.dev/health?token=resolver2026"
```

- URL fija: `datos/tunel.url`.
- `scripts/tunel.sh` reinicia el agente ngrok y verifica 200 en 30 s.
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

# Docker (la DB va por volumen, no en la imagen)
docker build -f deploy/Dockerfile -t resolver-ar .
docker run -p 3001:3001 -e RESOLVER_TOKEN=secreto \
  -v /opt/resolver/datos:/app/datos resolver-ar

# Caddy: editar el dominio y recargar
caddy reload --config deploy/Caddyfile
```

Variables (`deploy/.env.example`): `PORT=3001`, `RESOLVER_TOKEN=`,
`RESOLVER_DB=datos/padron.db`, `TZ=America/Argentina/Buenos_Aires`.

## 5. Fixture de test (no es una persona real)

El test 18 inyecta en la tabla `renaper` el DNI `87654321` con
`fechaNac=05/08/1979`, `nroTramite=9876543` y `direccion=AV TEST 123`.
Es un fixture offline; no debe tomarse como dato real.
