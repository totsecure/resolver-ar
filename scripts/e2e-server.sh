#!/usr/bin/env bash
# e2e-server.sh — instancia DESCARTABLE del server para Playwright.
#
# Corre el seed y levanta el server en PORT=3002 con su propio stock.db en .e2e/
# y un symlink al padron real (no se copia el padron). Nunca toca la instancia
# de produccion en :3001 ni datos/stock.db.
#
# Lo usa playwright.config.js como webServer. Tambien se puede correr a mano.
set -euo pipefail

RAIZ="/Volumes/Boveda/resolver"
DIR="$RAIZ/.e2e"
PUERTO="${E2E_PORT:-3002}"

cd "$RAIZ"
mkdir -p "$DIR"
ln -sfn "$RAIZ/datos/padron.db" "$DIR/padron.db"

if [ -f datos/server.env ]; then
  set -a
  # shellcheck disable=SC1091
  . datos/server.env
  set +a
fi

export PORT="$PUERTO"
export HOST="${E2E_HOST:-127.0.0.1}"
export RESOLVER_STOCK_DB="$DIR/stock.db"
export RESOLVER_DB="$DIR/padron.db"

# Aislamiento: nada de mensajes reales ni mantenimiento durante los tests.
# El outbox y los jobs siguen corriendo, pero sin token el envio no sale.
export TELEGRAM_TOKEN=""
export TELEGRAM_ALLOW=""
export MANTENIMIENTO=0
export PRECIO_TIENDA=0
export PUBLICAR_DIRECTO=0

node scripts/e2e-seed.mjs

echo "e2e-server: http://127.0.0.1:$PUERTO (stock.db descartable en .e2e/)"
exec node server.js
