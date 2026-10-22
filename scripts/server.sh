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
if [ -z "${RESOLVER_TOKEN:-}" ]; then
  echo "ERROR: falta RESOLVER_TOKEN en datos/server.env"
  exit 1
fi
export PORT="$PUERTO"
export RESOLVER_TOKEN
export RESOLVER_DB="${RESOLVER_DB:-$RAIZ/datos/padron.db}"
export TZ="${TZ:-America/Argentina/Buenos_Aires}"

health() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
    "http://localhost:${PUERTO}/health?token=${RESOLVER_TOKEN}" 2>/dev/null || true
}

arrancar_unico() {
  local patron="$1"; shift
  local pids; pids="$(pgrep -f "$patron" || true)"
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null
    for _ in $(seq 1 20); do pgrep -f "$patron" >/dev/null || break; sleep 0.25; done
    pgrep -f "$patron" | xargs -r kill -9 2>/dev/null
  fi
  "$@" &
  echo $! > "datos/$(basename "$0" .sh).pid"
}

PATRON="node server.js"
INSTANCIAS=$(pgrep -f "$PATRON" | wc -l | tr -d ' ')
CODE=$(health)
if [ "$INSTANCIAS" -eq 1 ] && [ "${1:-}" != "--force" ] && [ "$CODE" = "200" ]; then
  echo "server ya corriendo (pid=$(pgrep -f "$PATRON" | head -1) http=200); no se duplica"
  exit 0
fi

if [ "$INSTANCIAS" -gt 0 ]; then
  echo "reiniciando server (instancias=$INSTANCIAS http=${CODE:-000})"
fi

echo "arrancando server (PORT=$PUERTO RESOLVER_DB=$RESOLVER_DB)"
arrancar_unico "$PATRON" sh -c 'exec nohup node server.js >> datos/server.log 2>&1' >/dev/null
PID=$(cat datos/server.pid)

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
