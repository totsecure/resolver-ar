#!/usr/bin/env bash
# server.sh — arranca/reinicia server.js con el entorno de datos/server.env.
#
#   bash scripts/server.sh            # idempotente: si /health responde, no hace nada
#   bash scripts/server.sh --force    # reinicia aunque /health responda
#
# Carga PORT, RESOLVER_TOKEN y RESOLVER_DB desde datos/server.env. Escribe
# datos/server.pid. La vida del proceso se chequea por pidfile + kill -0,
# nunca por pgrep (en macOS pgrep puede no ver el proceso).
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

vivo() {
  local pf="$1" pid
  [ -f "$pf" ] || return 1
  pid="$(cat "$pf" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ "$pid" -gt 0 ] || return 1
  kill -0 "$pid" 2>/dev/null
}

arrancar_unico() {
  local pf="$1"; shift
  if vivo "$pf"; then
    local viejo; viejo="$(cat "$pf")"
    kill "$viejo" 2>/dev/null || true
    for _ in $(seq 1 20); do vivo "$pf" || break; sleep 0.25; done
    kill -9 "$viejo" 2>/dev/null || true
  fi
  rm -f "$pf"
  "$@" &
  echo $! > "$pf"
}

PF="datos/server.pid"
CODE=$(health)
if vivo "$PF" && [ "${1:-}" != "--force" ] && [ "$CODE" = "200" ]; then
  echo "server ya corriendo (pid=$(cat "$PF") http=200); no se duplica"
  exit 0
fi

if vivo "$PF"; then
  echo "reiniciando server (pid=$(cat "$PF") http=${CODE:-000})"
fi

echo "arrancando server (PORT=$PUERTO RESOLVER_DB=$RESOLVER_DB)"
arrancar_unico "$PF" sh -c 'exec nohup node server.js >> datos/server.log 2>&1' >/dev/null
PID=$(cat "$PF")

FIN=$((SECONDS + 15))
while [ "$SECONDS" -lt "$FIN" ]; do
  CODE=$(health)
  if [ "$CODE" = "200" ] && vivo "$PF"; then
    echo "server OK (pid=$PID http=200)"
    exit 0
  fi
  sleep 1
done

echo "ERROR: el server no respondio 200 en 15s (pid=$PID http=${CODE:-000})"
tail -20 datos/server.log 2>/dev/null || true
exit 1
