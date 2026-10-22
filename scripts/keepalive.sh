#!/usr/bin/env bash
# keepalive.sh — vigila los TRES procesos del resolver:
#   1) server.js          (health local)
#   2) bot/telegram.js    (proceso vivo)
#   3) tunel ngrok        (health publico)
#
# Relanza con el entorno correcto:
#   - server: datos/server.env (PORT, RESOLVER_TOKEN, RESOLVER_DB, TZ)
#   - bot:    datos/bot.env (TELEGRAM_TOKEN, TELEGRAM_ALLOW)
#   - tunel:  scripts/tunel.sh (usa el mismo server.env)
#
# No duplica procesos: server.sh, bot.sh y tunel.sh son idempotentes.
# Cada relanzamiento queda en datos/keepalive.log con fecha y motivo.
#
# Arranque:
#   nohup bash scripts/keepalive.sh >> datos/keepalive.log 2>&1 &
set -uo pipefail

RAIZ="/Users/bunker/resolver"
INTERVALO="60"

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
TOKEN="$RESOLVER_TOKEN"
BASIC="${NGROK_USER:-}:${NGROK_PASS:-}"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*"
}

# Evita dos keepalive corriendo a la vez.
if [ -f datos/keepalive.pid ]; then
  OTRO=$(cat datos/keepalive.pid 2>/dev/null || true)
  if [ -n "$OTRO" ] && kill -0 "$OTRO" 2>/dev/null; then
    echo "keepalive ya corriendo (pid=$OTRO)"
    exit 0
  fi
fi
echo $$ > datos/keepalive.pid

log "== keepalive pid=$$ intervalo=${INTERVALO}s puerto=${PUERTO} =="

while true; do
  LOCAL=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://localhost:${PUERTO}/health?token=${TOKEN}" 2>/dev/null || true)
  LOCAL="${LOCAL:-000}"

  BOT_PID=$(pgrep -f '^node bot/telegram\.js$' | head -1 || true)

  URL=$(cat datos/tunel.url 2>/dev/null || true)
  PUBLICO="000"
  if [ -n "$URL" ]; then
    PUBLICO=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -u "$BASIC" -H 'ngrok-skip-browser-warning: 1' \
      "${URL}/health?token=${TOKEN}" 2>/dev/null || true)
    PUBLICO="${PUBLICO:-000}"
  fi

  log "local=${LOCAL} bot=${BOT_PID:-'-'} publico=${PUBLICO} url=${URL:-'-'}"

  if [ "$LOCAL" != "200" ]; then
    log "motivo=server no responde (http=${LOCAL}); relanzando scripts/server.sh"
    bash scripts/server.sh >> datos/keepalive.log 2>&1
  fi

  if [ -z "$BOT_PID" ]; then
    log "motivo=bot caido; relanzando scripts/bot.sh"
    bash scripts/bot.sh >> datos/keepalive.log 2>&1
  fi

  if [ "$PUBLICO" != "200" ]; then
    log "motivo=tunel publico no responde (http=${PUBLICO}); relanzando scripts/tunel.sh"
    bash scripts/tunel.sh >> datos/keepalive.log 2>&1
  fi

  sleep "$INTERVALO"
done
