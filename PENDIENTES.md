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

## 2. RENAPER — espejo roto, esperando provider

**Qué espera a quién:** el espejo público `apirnpr.onrender.com` responde
`{"error":true,"mensaje":"No se pudo realizar la consulta."}` a todo, incluido
el ejemplo del README (`44444444/F`). El server vive; su backend no.

Se probaron 6 candidatos (detalle completo en `CONTEXTO.md`):

```text
apirnpr.onrender.com            200  {"error":true,...}          (el default actual)
renaperservice.onrender.com     401  sin key; 404 con key válida (simulado, sin 23854064)
apirenaper.idear.gov.ar         403  FORBIDDEN - REMOTE ADDRESS NOT ALLOWED
federales.info                  000  DNS no resuelve
servicios.gcba.gob.ar           000  DNS no resuelve
api.renaper.gob.ar              000  DNS no resuelve
```

`renaperservice` es un **simulador** (`facuPonceGit/RenaperService`) con solo
`30123456F` y `33456789M` hardcodeados. La única key demo válida es
`sk_renaper_inventario_2025_secret_key`; con ella `23854064` da 404. No se usa
como fuente real ni se cachea.

**Dictamen: espejo roto y sin alternativa pública viable.** No se buscan más
mirrors. La ficha degrada a `AUSENTE` (`-`).

**Cómo activarlo sin tocar código** (provider propio con la misma ruta
`/renaper/{dni}/{genero}`):

```bash
export RENAPER_BASE="https://mi-provider.example"
export RENAPER_USER="usuario"      # opcional, basic auth
export RENAPER_PASS="clave"        # opcional, basic auth
node scripts/ficha.js 23854064 --red
```

## 3. Túnel — activo con Pinggy (SSH 443)

Cloudflare Tunnel quedó descartado: esta red bloquea **TCP/UDP 7844**, que es
el puerto del edge de Cloudflare. Pinggy funciona solo con **SSH sobre 443** y
sin cuenta.

```bash
cd /Users/bunker/resolver
bash scripts/tunel.sh
cat datos/tunel.url
curl -s "$(cat datos/tunel.url)/health?token=resolver2026"
```

- URL vigente: `datos/tunel.url` (cambia en cada reconexión).
- `scripts/tunel.sh` deja un loop SSH que reconecta solo cada 5 s.
- El free tier de Pinggy expira a los 60 min; el loop renueva la URL.
- Keepalive:
  `nohup bash scripts/keepalive.sh >> datos/keepalive.log 2>&1 &`
- **Cloudflare no se usa más.**

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
