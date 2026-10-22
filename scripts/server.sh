#!/usr/bin/env bash
# server.sh — arranca/reinicia server.js con el entorno de datos/server.env.
#
#   bash scripts/server.sh            # idempotente: si /health responde, no hace nada
#   bash scripts/server.sh --force    # reinicia aunque /health responda
#
# Carga PORT, RESOLVER_TOKEN y RESOLVER_DB desde datos/server.env. Escribe
# datos/server.pid y no duplica procesos.
set -uo pipefail

RAIZ="/Users/bunker/resolver"
cd "$RAIZ" || { echo "ERROR: no existe $RAIZ"; exit 1; }
mkdir -p datos

if [ -f datos/server.env ]; then
  set -a
  # shellcheck disable=SC1091
  . datos/server.env
  set +a
fi

PUERTO="${PORT:-3001}"
export PORT="$PUERTO"
export RESOLVER_TOKEN="${RESOLVER_TOKEN:-resolver2026}"
export RESOLVER_DB="${RESOLVER_DB:-$RAIZ/datos/padron.db}"
export TZ="${TZ:-America/Argentina/Buenos_Aires}"

health() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
    "http://localhost:${PUERTO}/health?token=${RESOLVER_TOKEN}" 2>/dev/null || true
}

CODE=$(health)
if pgrep -f '^node server\.js$' >/dev/null 2>&1; then
  if [ "${1:-}" != "--force" ] && [ "$CODE" = "200" ]; then
    echo "server ya corriendo (pid=$(pgrep -f '^node server\.js$' | head -1) http=200)"
    exit 0
  fi
  echo "reiniciando server (http=${CODE:-000})"
  pkill -f '^node server\.js$' >/dev/null 2>&1 || true
  sleep 1
fi

echo "arrancando server (PORT=$PUERTO RESOLVER_DB=$RESOLVER_DB)"
nohup node server.js >> datos/server.log 2>&1 &
PID=$!
echo "$PID" > datos/server.pid

FIN=$((SECONDS + 15))
while [ "$SECONDS" -lt "$FIN" ]; do
  CODE=$(health)
  if [ "$CODE" = "200" ]; then
    echo "server OK (pid=$PID http=200)"
    exit 0
  fi
  sleep 1
done

echo "ERROR: el server no respondio 200 en 15s (pid=$PID http=${CODE:-000})"
tail -20 datos/server.log 2>/dev/null || true
exit 1
