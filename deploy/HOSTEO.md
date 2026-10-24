# Deploy de resolver-ar en un host 24/7

El server es un proceso Node + SQLite. Se puede hostear en cualquier VPS o
plataforma con Docker. **No necesita el padrón (1.4 GB) para funcionar**: con
`datos/stock.db` alcanza para el panel, el stock, `/saldeadas`, `/pedir` y el
bot. El padrón es opcional (sólo lo usan `/texto`, `/lote`, `/ficha`,
`/titulares`); si no está, esas rutas avisan y el resto sigue andando.

Requisitos reales:
- Node 24 (o el Dockerfile, que ya trae `node:24-alpine`).
- Disco persistente para `datos/` (stock.db ~0.5 MB; +1.4 GB si subís el padrón).
- Variables: `RESOLVER_TOKEN` (obligatoria) y `TELEGRAM_TOKEN` si corrés el bot.

---

## Opción A — VPS con Docker (recomendada si ya tenés host)

```bash
git clone <repo> /opt/resolver && cd /opt/resolver
cp deploy/.env.example deploy/.env      # completá RESOLVER_TOKEN
docker compose -f deploy/docker-compose.yml up -d --build
```

Queda en `127.0.0.1:3001`. Poné un reverse proxy con HTTPS (Caddy):

```
resolver.tudominio.com {
    encode gzip
    reverse_proxy 127.0.0.1:3001
}
```

Sin Docker, con systemd: `sudo bash deploy/deploy.sh` (ya trae el unit).

---

## Opción B — Fly.io (free tier con volumen)

```bash
fly launch --no-deploy --copy-config --config deploy/fly.toml
fly volumes create resolver_datos --size 3        # 3 GB: stock + padrón
fly secrets set RESOLVER_TOKEN=xxxxx
fly deploy
```

`/health` es público y sirve de healthcheck. `auto_stop_machines=suspend`
ahorra cuando no hay tráfico. El volumen `/app/datos` persiste la DB.

---

## Opción C — Railway / Render (baratos, sin Docker propio)

- Build: `npm ci --omit=dev`
- Start: `node server.js`
- Env: `PORT`, `HOST=0.0.0.0`, `RESOLVER_TOKEN`, `RESOLVER_STOCK_DB=/data/stock.db`,
  `RESOLVER_DB=/data/padron.db`
- Agregá un **volumen** montado en `/data` (SQLite necesita disco, no efímero).
- Healthcheck: `/health` (público).

> Render free duerme el servicio sin tráfico (arranca en segundos). Railway
> tiene crédito mensual. Para el bot Telegram conviene un plan chico o un
> worker aparte, porque el bot necesita estar siempre escuchando.

---

## Backup de la base (importante en cualquier host)

La DB es un archivo. Backeala con SQLite online:

```bash
sqlite3 datos/stock.db ".backup 'backup-stock-$(date +%F).db'"
```

O corré el bot con `/backup`. Para replicación continua: Litestream
(`deploy/litestream.yml`) sube el WAL a S3/R2.

---

## Checklist de migración

1. `RESOLVER_TOKEN` fuerte y secreto (no el de dev).
2. `HOST=0.0.0.0` dentro del contenedor (por defecto es 127.0.0.1).
3. Volumen persistente en `/app/datos` (o `datos/`).
4. HTTPS por el host (Caddy/Fly/Cloudflare).
5. Copiar `datos/stock.db` (y opcionalmente `datos/padron.db`) al volumen.
6. Si movés el bot, actualizá `TELEGRAM_TOKEN` y el `RESOLVER_URL` interno.
