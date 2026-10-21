#!/usr/bin/env bash
# keepalive.sh — cada 60s chequea server local y tunel; si alguno no responde,
# vuelve a ejecutar scripts/tunel.sh.
# (Pinggy SSH sobre 443; tunel.sh reconecta solo.)
#
# Arranque:
#   nohup bash scripts/keepalive.sh >> datos/keepalive.log 2>&1 &
set -uo pipefail

RAIZ="/Users/bunker/resolver"
TOKEN="resolver2026"
PUERTO="3001"
INTERVALO="60"

cd "$RAIZ" || { echo "ERROR: no existe $RAIZ"; exit 1; }
mkdir -p datos

# Evita dos keepalive corriendo a la vez.
if [ -f datos/keepalive.pid ]; then
  OTRO=$(cat datos/keepalive.pid 2>/dev/null || true)
  if [ -n "$OTRO" ] && kill -0 "$OTRO" 2>/dev/null; then
    echo "keepalive ya corriendo (pid=$OTRO)"
    exit 0
  fi
fi
echo $$ > datos/keepalive.pid

echo "== keepalive $(date '+%Y-%m-%d %H:%M:%S') pid=$$ =="

while true; do
  TS=$(date '+%Y-%m-%d %H:%M:%S')

  LOCAL=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:${PUERTO}/health" 2>/dev/null || true)
  URL=$(cat datos/tunel.url 2>/dev/null || true)
  PUBLICO="000"
  if [ -n "$URL" ]; then
    PUBLICO=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${URL}/health?token=${TOKEN}" 2>/dev/null || true)
  fi

  echo "$TS local=${LOCAL:-000} publico=${PUBLICO:-000} url=${URL:-'-'}"

  if [ -z "$LOCAL" ] || [ "$LOCAL" = "000" ] || [ "$PUBLICO" != "200" ]; then
    echo "$TS relanzando scripts/tunel.sh"
    bash scripts/tunel.sh >> datos/tunel.log 2>&1
  fi

  sleep "$INTERVALO"
done
