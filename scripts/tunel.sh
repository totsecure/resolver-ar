#!/usr/bin/env bash
# tunel.sh — publica el server local con ngrok en un dominio fijo.
#
#   Internet -> https://action-early-pants.ngrok-free.dev -> localhost:3001
#
# El agente ngrok reconecta solo. keepalive.sh lo vigila y relanza este script
# si el local o el publico dejan de responder. El server se arranca con
# scripts/server.sh (entorno de datos/server.env), nunca con env hardcodeado.
set -uo pipefail

RAIZ="/Users/bunker/resolver"
URL="https://action-early-pants.ngrok-free.dev"

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
if [ -z "${NGROK_USER:-}" ] || [ -z "${NGROK_PASS:-}" ]; then
  echo "ERROR: faltan NGROK_USER/NGROK_PASS en datos/server.env"
  exit 1
fi
TOKEN="$RESOLVER_TOKEN"
BASIC="${NGROK_USER}:${NGROK_PASS}"

echo "== tunel.sh $(date '+%Y-%m-%d %H:%M:%S') =="

echo "[1/4] chequeando server local..."
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
  "http://localhost:${PUERTO}/health?token=${TOKEN}" 2>/dev/null || true)
if [ -z "$CODE" ] || [ "$CODE" != "200" ]; then
  echo "  server no responde (http=${CODE:-000}), arrancando scripts/server.sh..."
  bash scripts/server.sh || {
    echo "  ERROR: el server no arranco. Ver datos/server.log"
    tail -20 datos/server.log 2>/dev/null || true
    exit 1
  }
else
  echo "  server ya responde (http=${CODE}); no se reinicia"
fi

echo "[2/4] cerrando ngrok previo..."
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

echo "[3/4] arrancando ngrok..."
: > datos/tunel.log
arrancar_unico "ngrok http" sh -c 'exec nohup ngrok http "$1" --url="$2" --basic-auth="$3" >> datos/tunel.log 2>&1' _ "$PUERTO" "$URL" "$BASIC" >/dev/null
NGROK_PID=$(cat datos/tunel.pid)
echo "  ngrok pid=$NGROK_PID"

echo "[4/4] esperando health publico (hasta 30s)..."
JSON=""
PUBLICO_OK=0
FIN=$((SECONDS + 30))
while [ "$SECONDS" -lt "$FIN" ]; do
  JSON=$(curl -s --max-time 3 -u "$BASIC" -H 'ngrok-skip-browser-warning: 1' \
    "${URL}/health?token=${TOKEN}" 2>/dev/null || true)
  case "$JSON" in
    *'"ok":true'*) PUBLICO_OK=1; break ;;
  esac
  sleep 1
done
if [ "$PUBLICO_OK" -ne 1 ]; then
  echo "  ERROR: ${URL}/health no respondio 200 en 30s."
  echo "  Ultimas lineas de datos/tunel.log:"
  tail -30 datos/tunel.log 2>/dev/null || true
  echo "  Estado del agente (localhost:4040):"
  curl -s --max-time 3 http://localhost:4040/api/tunnels 2>/dev/null | head -c 500 || true
  echo
  kill "$NGROK_PID" 2>/dev/null || true
  rm -f datos/tunel.url
  exit 1
fi

printf '%s\n' "$URL" > datos/tunel.url
echo "$JSON"

echo ""
echo "LISTO"
echo "URL=$URL"
echo "TOKEN=...${TOKEN: -6}"
echo "BASIC_AUTH=$NGROK_USER:***"
echo "VERIFICAR: curl -s -u \"\$NGROK_USER:\$NGROK_PASS\" \"${URL}/health?token=\$RESOLVER_TOKEN\""
echo "FICHA:     curl -s -u \"\$NGROK_USER:\$NGROK_PASS\" \"${URL}/ficha/3348?token=\$RESOLVER_TOKEN\""
