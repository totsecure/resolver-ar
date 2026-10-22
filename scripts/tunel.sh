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
TOKEN="${RESOLVER_TOKEN:-resolver2026}"

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
pkill -f '^ngrok http' >/dev/null 2>&1 || true
sleep 1

echo "[3/4] arrancando ngrok..."
: > datos/tunel.log
nohup ngrok http "$PUERTO" --url="$URL" >> datos/tunel.log 2>&1 &
NGROK_PID=$!
echo "$NGROK_PID" > datos/tunel.pid
echo "  ngrok pid=$NGROK_PID"

echo "[4/4] esperando health publico (hasta 30s)..."
JSON=""
PUBLICO_OK=0
FIN=$((SECONDS + 30))
while [ "$SECONDS" -lt "$FIN" ]; do
  JSON=$(curl -s --max-time 3 -H 'ngrok-skip-browser-warning: 1' \
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
echo "TOKEN=$TOKEN"
echo "VERIFICAR: curl -s \"${URL}/health?token=${TOKEN}\""
echo "FICHA:     curl -s \"${URL}/ficha/3348?token=${TOKEN}\""
