#!/usr/bin/env bash
# tunel.sh — publica el server local con Cloudflare Quick Tunnel.
# Deja: datos/tunel.url, datos/server.log, datos/tunel.log
set -uo pipefail

RAIZ="/Users/bunker/resolver"
TOKEN="resolver2026"
PUERTO="3001"

cd "$RAIZ" || { echo "ERROR: no existe $RAIZ"; exit 1; }
mkdir -p datos

echo "== tunel.sh $(date '+%Y-%m-%d %H:%M:%S') =="

echo "[1/5] matando procesos previos..."
pkill -f cloudflared >/dev/null 2>&1 || true
pkill -f "node server.js" >/dev/null 2>&1 || true
# Red de seguridad: si algo quedo escuchando en el puerto, liberarlo.
lsof -ti "tcp:${PUERTO}" 2>/dev/null | xargs kill >/dev/null 2>&1 || true
sleep 1

echo "[2/5] arrancando server en :${PUERTO}..."
RESOLVER_TOKEN="$TOKEN" nohup node server.js >> datos/server.log 2>&1 &
SERVER_PID=$!
echo "  server pid=$SERVER_PID"

SERVER_OK=0
CODE="000"
for _ in $(seq 1 15); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:${PUERTO}/health" 2>/dev/null || true)
  if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then SERVER_OK=1; break; fi
  sleep 1
done
if [ "$SERVER_OK" -ne 1 ]; then
  echo "ERROR: el server no respondio en 15s. Ultimas lineas de datos/server.log:"
  tail -20 datos/server.log 2>/dev/null || true
  exit 1
fi
echo "  server OK (health http=${CODE}; 401 sin token es lo esperado)"

echo "[3/5] arrancando cloudflared..."
# Se trunca para no levantar una URL vieja de una corrida anterior.
: > datos/tunel.log
nohup cloudflared tunnel --url "http://localhost:${PUERTO}" >> datos/tunel.log 2>&1 &
TUNEL_PID=$!
echo "  cloudflared pid=$TUNEL_PID"

URL=""
for _ in $(seq 1 45); do
  if grep -q 'failed to request quick Tunnel' datos/tunel.log 2>/dev/null; then
    echo "ERROR: Cloudflare no pudo crear el quick tunnel (¿red bloqueando el puerto 7844?)."
    grep -E 'failed to request quick Tunnel|Port 7844|blocked|unreachable' datos/tunel.log | tail -5
    kill "$TUNEL_PID" 2>/dev/null || true
    rm -f datos/tunel.url
    exit 1
  fi
  URL=$(perl -pe 's/\e\[[0-9;]*[A-Za-z]//g' datos/tunel.log 2>/dev/null \
    | grep -oE 'https://[-a-z0-9]+\.trycloudflare\.com' \
    | grep -v '^https://api\.trycloudflare\.com$' | tail -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then
  echo "ERROR: no aparecio una URL *.trycloudflare.com en 45s. Ultimas lineas:"
  tail -30 datos/tunel.log 2>/dev/null || true
  kill "$TUNEL_PID" 2>/dev/null || true
  rm -f datos/tunel.url
  exit 1
fi
printf '%s\n' "$URL" > datos/tunel.url
echo "[4/5] URL: $URL"

echo "[5/5] verificando health publico..."
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
  echo "ERROR: la URL publica no respondio /health en 30s (sin conector al edge)."
  echo "Ultimas lineas de datos/tunel.log:"
  tail -20 datos/tunel.log 2>/dev/null || true
  kill "$TUNEL_PID" 2>/dev/null || true
  rm -f datos/tunel.url
  exit 1
fi
echo "$JSON"

echo ""
echo "LISTO"
echo "URL=$URL"
echo "TOKEN=$TOKEN"
echo "VERIFICAR: curl -s \"${URL}/health?token=${TOKEN}\""
