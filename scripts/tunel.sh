#!/usr/bin/env bash
# tunel.sh — publica el server local con Pinggy (SSH sobre 443, sin cuenta).
#
# Topologia:  Internet -> https://<random>.pinggy... -> ssh :443 -> localhost:3001
# El loop de SSH reconecta solo y actualiza datos/tunel.url en cada reconexion.
#
# Uso:
#   bash scripts/tunel.sh            # asegura server, arranca el loop, verifica y sale
#   bash scripts/tunel.sh --loop     # solo el loop de reconexion (lo lanza el anterior)
set -uo pipefail

RAIZ="/Users/bunker/resolver"
TOKEN="resolver2026"
PUERTO="3001"
PINGGY_HOST="free@a.pinggy.io"
SSH_OPTS=(
  -T
  -p 443
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o ExitOnForwardFailure=yes
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -R0:localhost:3001
)

cd "$RAIZ" || { echo "ERROR: no existe $RAIZ"; exit 1; }
mkdir -p datos

# ---------------------------------------------------------------------------
# Modo loop: reconecta el SSH para siempre y guarda la URL vigente.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--loop" ]; then
  echo "== tunel loop $(date '+%Y-%m-%d %H:%M:%S') =="
  while true; do
    ssh "${SSH_OPTS[@]}" "$PINGGY_HOST" 2>&1 | while IFS= read -r linea; do
      printf '%s\n' "$linea" >> datos/tunel.log
      URL_LINEA=$(printf '%s\n' "$linea" | grep -oE 'https://[A-Za-z0-9._-]+\.(pinggy\.net|pinggy-free\.link|pinggy\.link)' | head -1 || true)
      if [ -n "$URL_LINEA" ]; then
        printf '%s\n' "$URL_LINEA" > datos/tunel.url
      fi
    done
    echo "[loop] ssh cerro $(date '+%Y-%m-%d %H:%M:%S'), reconectando en 5s..." >> datos/tunel.log
    sleep 5
  done
fi

# ---------------------------------------------------------------------------
# Modo normal: server + loop + verificacion.
# ---------------------------------------------------------------------------
echo "== tunel.sh $(date '+%Y-%m-%d %H:%M:%S') =="

echo "[1/4] chequeando server local..."
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:${PUERTO}/health" 2>/dev/null || true)
if [ -z "$CODE" ] || [ "$CODE" = "000" ]; then
  echo "  server no responde, arrancando con RESOLVER_TOKEN=${TOKEN}..."
  RESOLVER_TOKEN="$TOKEN" nohup node server.js >> datos/server.log 2>&1 &
  SERVER_OK=0
  for _ in $(seq 1 15); do
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:${PUERTO}/health" 2>/dev/null || true)
    if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then SERVER_OK=1; break; fi
    sleep 1
  done
  if [ "$SERVER_OK" -ne 1 ]; then
    echo "  ERROR: el server no respondio en 15s. Ver datos/server.log"
    tail -20 datos/server.log 2>/dev/null || true
    exit 1
  fi
  echo "  server OK (http=${CODE})"
else
  echo "  server ya responde (http=${CODE}); no se reinicia"
fi

echo "[2/4] cerrando tuneles previos..."
if [ -f datos/tunel.pid ]; then
  kill "$(cat datos/tunel.pid)" 2>/dev/null || true
fi
pkill -f 'a\.pinggy\.io' >/dev/null 2>&1 || true
pkill -f 'cloudflared' >/dev/null 2>&1 || true
sleep 1

echo "[3/4] arrancando loop SSH sobre 443..."
: > datos/tunel.log
rm -f datos/tunel.url
nohup bash "$0" --loop >> datos/tunel.log 2>&1 &
echo $! > datos/tunel.pid
echo "  loop pid=$(cat datos/tunel.pid)"

URL=""
for _ in $(seq 1 45); do
  URL=$(cat datos/tunel.url 2>/dev/null || true)
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then
  echo "  ERROR: Pinggy no entrego URL en 45s. Ultimas lineas:"
  tail -30 datos/tunel.log 2>/dev/null || true
  kill "$(cat datos/tunel.pid)" 2>/dev/null || true
  pkill -f 'a\.pinggy\.io' >/dev/null 2>&1 || true
  rm -f datos/tunel.url
  exit 1
fi
echo "  URL: $URL"

echo "[4/4] verificando health publico..."
JSON=""
PUBLICO_OK=0
for _ in $(seq 1 30); do
  JSON=$(curl -s --max-time 10 "${URL}/health?token=${TOKEN}" 2>/dev/null || true)
  case "$JSON" in
    *'"ok"'*) PUBLICO_OK=1; break ;;
  esac
  sleep 1
done
if [ "$PUBLICO_OK" -ne 1 ]; then
  echo "  ERROR: la URL publica no respondio /health en 30s."
  echo "  Ultimas lineas de datos/tunel.log:"
  tail -20 datos/tunel.log 2>/dev/null || true
  kill "$(cat datos/tunel.pid)" 2>/dev/null || true
  pkill -f 'a\.pinggy\.io' >/dev/null 2>&1 || true
  rm -f datos/tunel.url
  exit 1
fi
echo "$JSON"

echo ""
echo "LISTO"
echo "URL=$URL"
echo "TOKEN=$TOKEN"
echo "VERIFICAR: curl -s \"${URL}/health?token=${TOKEN}\""
echo "FICHA:     curl -s \"${URL}/ficha/3348?token=${TOKEN}\""
