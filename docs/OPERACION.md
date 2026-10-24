# OPERACIÓN — RESOLVER STORE

Última actualización: 2026-10-23.

## 1. Servicios y supervisión

Los cinco servicios críticos corren como **LaunchDaemons** (`system`) y como
usuario `bunker:staff` (nunca root). Los plists viven en
`/Library/LaunchDaemons/` y las plantillas versionadas en `deploy/daemons/`.

| label | qué hace | log | verificación |
|---|---|---|---|
| `ar.resolver.server` | `node server.js` en `127.0.0.1:3001` | `datos/launchd-server.log`, `datos/server.log` | `curl 127.0.0.1:3001/health?token=…` |
| `ar.resolver.tunel` | ngrok en primer plano → `:3001` | `datos/tunel.log` | Worker `/health` |
| `ar.resolver.litestream` | replicación continua de `stock.db` | `datos/litestream.log` | `launchctl print system/ar.resolver.litestream` |
| `ar.resolver.datasette` | visor read-only en `127.0.0.1:3003` | `datos/datasette.log` | `/datasette/stock/cc.json` con token |
| `ar.resolver.vigilar` | chequeo cada 60 s + alertas Telegram | `datos/vigilar.log` | `launchctl print system/ar.resolver.vigilar` |

Siguen como **LaunchAgents** (`gui/$UID`): `ar.resolver.backup` (03:30) y
`ar.resolver.caffeinate`.

Comandos útiles:

```bash
launchctl print system/ar.resolver.server | grep -E 'state|pid'
sudo launchctl kickstart -k system/ar.resolver.server
sudo launchctl bootout system/ar.resolver.server
sudo launchctl bootstrap system /Library/LaunchDaemons/ar.resolver.server.plist
```

Verificación integral:

```bash
bash /Users/bunker/resolver/scripts/migrar-daemons.sh --verificar
```

## 2. Después de un corte de luz

1. Encender la Mac. **FileVault pide desbloquear el disco**: sin eso no arranca
   ningún daemon, porque el volumen está cifrado.
2. Ingresar la contraseña de FileVault. Los LaunchDaemons de `system` arrancan
   solos, sin necesidad de login gráfico.
3. Verificar:

```bash
launchctl list | grep -i resolver
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:3001/health?token=$RESOLVER_TOKEN"
curl -s -o /dev/null -w '%{http_code}\n' "https://resolver-api.correonube.workers.dev/health?token=$RESOLVER_TOKEN"
bash /Users/bunker/resolver/scripts/humo.sh
```

Para reinicios programados (actualizaciones, etc.) usar:

```bash
sudo fdesetup authrestart
```

Pide credenciales, reinicia y desbloquea el volumen automáticamente. No usar
`reboot` a secas si no hay alguien para desbloquear FileVault.

## 3. Restaurar un backup

### 3.1 stock.db desde `datos/backups/`

```bash
cd /Users/bunker/resolver
sudo launchctl bootout system/ar.resolver.server
sudo launchctl bootout system/ar.resolver.litestream

# elegir el backup
ls -1t datos/backups/stock-*.db.gz | head

# validar ANTES de pisar producción
gzip -dc datos/backups/stock-20260101-030000.db.gz > /tmp/stock-restore.db
sqlite3 /tmp/stock-restore.db "PRAGMA quick_check; SELECT COUNT(*) FROM cc;"

# preservar la base actual y restaurar
cp datos/stock.db _bak/stock.db.pre-restore-$(date +%Y%m%d-%H%M%S)
rm -f datos/stock.db-wal datos/stock.db-shm
cp /tmp/stock-restore.db datos/stock.db
chown bunker:staff datos/stock.db
chmod 644 datos/stock.db

sudo launchctl bootstrap system /Library/LaunchDaemons/ar.resolver.litestream.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/ar.resolver.server.plist
bash scripts/humo.sh
```

### 3.2 stock.db desde Litestream (point-in-time)

```bash
cd /Users/bunker/resolver
sudo launchctl bootout system/ar.resolver.server
sudo launchctl bootout system/ar.resolver.litestream
rm -f /tmp/stock-litestream.db
varios/bin/litestream restore -config deploy/litestream.yml \
  -o /tmp/stock-litestream.db datos/stock.db
sqlite3 /tmp/stock-litestream.db "PRAGMA quick_check; SELECT COUNT(*) FROM cc;"
cp datos/stock.db _bak/stock.db.pre-litestream-restore-$(date +%Y%m%d-%H%M%S)
rm -f datos/stock.db-wal datos/stock.db-shm
cp /tmp/stock-litestream.db datos/stock.db
chown bunker:staff datos/stock.db
sudo launchctl bootstrap system /Library/LaunchDaemons/ar.resolver.litestream.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/ar.resolver.server.plist
```

### 3.3 padron.db (semanal)

```bash
cd /Users/bunker/resolver
sudo launchctl bootout system/ar.resolver.server
sudo launchctl bootout system/ar.resolver.datasette

ls -1t datos/backups/padron-semanal-*.db.gz | head
gzip -dc datos/backups/padron-semanal-20261023-073517.db.gz > /tmp/padron-restore.db
sqlite3 /tmp/padron-restore.db "PRAGMA quick_check; SELECT COUNT(*) FROM personas;"
# esperado hoy: 5.664.575

cp datos/padron.db _bak/padron.db.pre-restore-$(date +%Y%m%d-%H%M%S)
rm -f datos/padron.db-wal datos/padron.db-shm
cp /tmp/padron-restore.db datos/padron.db
chown bunker:staff datos/padron.db
chmod 644 datos/padron.db

sudo launchctl bootstrap system /Library/LaunchDaemons/ar.resolver.server.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/ar.resolver.datasette.plist
bash scripts/humo.sh
```

> `datos/padron.db` es de solo lectura para la aplicación. No se replica con
> Litestream; su respaldo es el semanal comprimido (~548 MB).

## 4. Revocar una API key

Por la web (recomendado): `Mi cuenta` → API keys → revocar. Por HTTP, con
sesión y CSRF:

```bash
curl -X POST "http://127.0.0.1:3001/api/tokens/12/revocar" \
  -H "Cookie: resolver_sesion=…" -H "x-csrf-token: …"
```

La revocación es inmediata (`revocado=1`, `revocado_en`) y queda auditada. Si
hay que hacerlo de emergencia por SQL:

```bash
sqlite3 datos/stock.db \
 "UPDATE api_tokens SET revocado=1, revocado_en=datetime('now') WHERE id=12;"
sqlite3 datos/stock.db \
 "UPDATE api_tokens SET revocado=1, revocado_en=datetime('now') WHERE prefijo LIKE 'rsk_abc%';"
```

Después correr `node scripts/verificar-invariantes.mjs`.

## 5. Monitoreo y silencio de alertas

`scripts/vigilar.sh` (launchd, cada 60 s) chequea:

1. `/health` local en `127.0.0.1:3001`.
2. `/health` del túnel **a través del Worker**.
3. bot por `telegram getMe`.

Alerta por Telegram en la transición OK→FALLA y avisa cuando se recupera.
Mientras sigue caído recuerda cada `VIGILAR_COOLDOWN` segundos (default 1800).
Estado por chequeo en `datos/vigilar-<check>.estado`; log en `datos/vigilar.log`.

Silenciar temporalmente:

```bash
# parar el chequeo (queda apagado hasta que se vuelva a cargar)
sudo launchctl bootout system/ar.resolver.vigilar
# volver a activarlo
sudo launchctl bootstrap system /Library/LaunchDaemons/ar.resolver.vigilar.plist

# resetear el cooldown/estado (la próxima corrida vuelve a alertar)
rm -f datos/vigilar-*.estado

# probar sin mandar mensajes
ALERTA_DRY=1 bash scripts/vigilar.sh
```

Para subir el cooldown: `sudo launchctl setenv VIGILAR_COOLDOWN 7200` (o editar
el plist y re-bootstrapear).

## 6. Retención de backups y `_bak/`

`scripts/backup-dbs.sh` (launchd `ar.resolver.backup`, 03:30):

- `stock.db`: 7 copias diarias + 4 semanales.
- `padron.db`: 4 copias semanales (~548 MB c/u).
- Copias legacy `padron-YYYYMMDD-*.db.gz`: se conservan las 4 más nuevas.
- `_bak/`: se borran archivos con más de **90 días**.
- Destino local `datos/backups/` y remoto `/Volumes/Boveda/resolver-backups`
  (exige el disco montado; si no está, aborta con alerta).

Revisar espacio:

```bash
du -sh datos/backups /Volumes/Boveda/resolver-backups _bak
ls -1t datos/backups | head -20
```

Política: ningún backup se borra antes de que exista uno más nuevo validado
(`quick_check=ok`). Las copias se comprimen y se copian al disco externo; el
local es la fuente rápida de restore, el remoto la copia fuera del equipo.

## 7. Chequeos de salud

```bash
bash scripts/humo.sh                        # 48 OK esperados
node scripts/verificar.js                   # 32 OK esperados
node scripts/verificar-invariantes.mjs      # ledger, pedidos, scopes
node scripts/test-asientos.mjs              # un asiento por camino de saldo
bash scripts/e2e.sh                         # 28 tests E2E
```

## 8. Panel y assets estáticos

- `panel/index.html` usa Tabler (`panel/vendor/tabler.min.css`) y `panel/panel.css`
  para el shell/sidebar/tabla. `panel.css` es público (como `app.js`), porque el HTML
  lo referencia sin token.
- Scripts vendor se cargan al final del body; ApexCharts recién se descarga al abrir
  Dashboard. El sprite `panel/vendor/iconos.svg` se genera con
  `node scripts/iconos.mjs` (solo los iconos usados).
- Cache: `/panel/vendor/*` es `immutable`; `panel.css`, `app.js` e `index.html` son
  `no-cache` (se revalidan). Tras cambiar un asset propio, basta recargar.
- Capturas de referencia: `docs/capturas/`. Para regenerarlas:
  `node scripts/capturas.mjs despues` (usa `RESOLVER_TOKEN` de `datos/server.env`).

## 9. Regenerar la base de BINs (`datos/bins.db`)

`datos/bins.db` es un archivo aparte, reproducible, que **no** se respalda con
stock/padrón. Para regenerarlo:

```bash
cd /Users/bunker/resolver
# el CSV vive en refs/ (ignorado por git)
node scripts/importar-bins.mjs
# completa banco/país/tipo/nivel en las tarjetas existentes
node scripts/enriquecer-bins.mjs
```

- Dataset: `refs/binlist-data-tech/bins.csv` (CC BY 4.0, ver `docs/CREDITOS.md`).
- Fecha del dataset: `2026-09-03`.
- El importador normaliza red/tipo/nivel y reporta filas importadas y descartadas.
- `lib/bininfo.js` consulta `bins` primero (offline), cachea en `bininfo` con
  `fuente='dataset'` y solo cae a APIs si el BIN no está. `binlist` va último por
  su límite de 5 req/hora.
- Si el BIN no existe, devuelve `fuente='sin_datos'` y no lo cachea como éxito.
- `datos/bins.db` puede borrarse y regenerarse en cualquier momento.
