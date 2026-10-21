# resolver-ar

Dado un DNI, devuelve un informe con datos **reales** del padrón de ARCA/AFIP y
una **ficha de 10 líneas**. No inventa datos: cada campo declara su fuente
(`REAL_AFIP | REAL_CNE | REAL_RENAPER | DERIVADO | SINTETICO | AUSENTE`).

## Requisitos

- Node 24 (ESM, `node:sqlite`; **no** usa `better-sqlite3`).
- `datos/padron.db`: padrón AFIP real (~757 MB, 5.664.575 personas físicas,
  1.735 DNIs ambiguos). La cobertura es ~16,18 % de los ~35 M de electores:
  **"no encontrado" es el caso normal**, no un error.

## Tests (offline)

```bash
node scripts/verificar.js
# 18 OK / 0 FAIL  (exit 0)
```

Los tests no usan red: CNE está cerrado y el espejo de RENAPER está roto.

## Uso rápido

```bash
node cli.js probar 3348                  # informe + BCRA
node cli.js probar 3348 --offline        # sin red
node scripts/ficha.js 23854064 --red     # ficha (red solo con --red)
node scripts/ficha.js 3348 --fuentes     # ficha + fuente por campo
node scripts/cne.js config               # config CNE + distritos + dictamen
node scripts/cne.js estado               # cache/intentos, sin red
node scripts/cne.js probe                # diagnóstico real del CNE
node scripts/cne.js captcha              # captcha -> /tmp/cne-captcha.jpg
```

## API

```bash
PORT=3001 RESOLVER_TOKEN=secreto node server.js
```

Endpoints de **solo lectura** (header `Authorization: Bearer <token>` o
`?token=<token>`; si `RESOLVER_TOKEN` está vacío no se exige token):

| endpoint | respuesta |
|---|---|
| `GET /health` | `{ok, version, db, personas}` |
| `GET /ficha/:dni?genero=M` | ficha de 10 líneas (`text/plain`); `&red=1` habilita RENAPER |
| `GET /stats` | personas, ambiguos, cobertura, tablas, filas `cne`/`renaper` |
| `GET /informe/:dni` | informe completo (`text/plain`); `?offline=1` sin BCRA |

`/texto/:dni` y `/persona/:dni` siguen existiendo sin token (compatibilidad).

Ejemplos:

```bash
curl -H 'Authorization: Bearer secreto' http://localhost:3001/health
curl 'http://localhost:3001/ficha/3348?genero=M&token=secreto'
curl 'http://localhost:3001/stats?token=secreto'
```

## Estado de cada fuente (2026-10-21)

| fuente | estado | detalle |
|---|---|---|
| **AFIP** | **REAL, offline** | `datos/padron.db`: 5.664.575 personas físicas. Apellido, nombre, DNI, CUIT, CUIL y situación impositiva reales. |
| **CNE** | **CERRADO (`mode=end`)** | `config/web.json` HTTP 200; `online_since` 13/11/2025 07:00; `votacion.fecha` 26-10-2025; captcha HTTP 503. `DISTRITOS` con los 27 nombres. |
| **RENAPER** | **ESPEJO ROTO** | `apirnpr.onrender.com` devuelve `{"error":true,"mensaje":"No se pudo realizar la consulta."}`. 6 candidatos probados, ninguno sirve. Degrada a `AUSENTE`. |
| **BCRA** | best-effort | Flapea; 404 = sin datos (no es caída). |
| **mail / teléfono** | **SINTÉTICO** | Deterministas por DNI (FNV-1a). Sin nombre ni apellido: `u<dni>` (ej. `u23854064@gmail.com`). |

Detalle de candidatos RENAPER y comandos pendientes: `CONTEXTO.md` y
`PENDIENTES.md`. Reglas de desarrollo: `AGENTS.md`.

## Túnel público (Pinggy, SSH sobre 443)

Cloudflare Tunnel queda descartado en esta red: bloquea TCP/UDP 7844.
Se usa **Pinggy**, que solo necesita SSH sobre 443 y no requiere cuenta.

```bash
bash scripts/tunel.sh
# imprime URL=https://<random>.pinggy-free.link
# guarda la URL en datos/tunel.url y verifica /health

curl -s "$(cat datos/tunel.url)/health?token=resolver2026"
curl -s "$(cat datos/tunel.url)/ficha/3348?token=resolver2026"

# keepalive: reconexión automática cada 60 s
nohup bash scripts/keepalive.sh >> datos/keepalive.log 2>&1 &
```

- `scripts/tunel.sh` mantiene un loop SSH con reconexión automática y actualiza
  `datos/tunel.url` en cada reconexión.
- El free tier de Pinggy expira a los 60 min; al reconectar cambia la URL.
- Token del server: `resolver2026`.

## Deploy

La DB **no** va en la imagen Docker: se monta por volumen.

```bash
# systemd (recomendado)
sudo bash deploy/deploy.sh

# Docker
docker build -f deploy/Dockerfile -t resolver-ar .
docker run -p 3001:3001 -e RESOLVER_TOKEN=secreto \
  -v /opt/resolver/datos:/app/datos resolver-ar

# Caddy (HTTPS automático)
# editar deploy/Caddyfile y poner el dominio real
```

Archivos: `deploy/Dockerfile`, `deploy/Caddyfile`, `deploy/resolver.service`,
`deploy/deploy.sh`, `deploy/.env.example`.

Variables: `PORT`, `RESOLVER_TOKEN`, `RESOLVER_DB`, `TZ`
(`America/Argentina/Buenos_Aires`).
