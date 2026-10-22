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

# Si hay mas de una instancia, deja la mas vieja y mata los sobrantes.
podar() {
  local patron="$1"
  local pids n sobrantes
  pids="$(pgrep -f "$patron" || true)"
  n="$(printf '%s\n' "$pids" | grep -c . || true)"
  if [ "$n" -gt 1 ]; then
    sobrantes="$(printf '%s\n' "$pids" | tail -n +2)"
    log "motivo=duplicados patron=\"$patron\" instancias=$n; matando sobrantes $(printf '%s' "$sobrantes" | tr '\n' ' ')"
    kill $sobrantes 2>/dev/null || true
    sleep 1
    kill -9 $sobrantes 2>/dev/null || true
  fi
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
  podar "node server.js"
  podar "bot/telegram.js"
  podar "ngrok http"

  LOCAL=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://localhost:${PUERTO}/health?token=${TOKEN}" 2>/dev/null || true)
  LOCAL="${LOCAL:-000}"

  SERVER_N=$(pgrep -f "node server.js" | wc -l | tr -d ' ')
  BOT_PID=$(pgrep -f "bot/telegram.js" | head -1 || true)
  BOT_N=$(pgrep -f "bot/telegram.js" | wc -l | tr -d ' ')
  TUNEL_N=$(pgrep -f "ngrok http" | wc -l | tr -d ' ')
  [ -n "$BOT_PID" ] || BOT_N=0

  URL=$(cat datos/tunel.url 2>/dev/null || true)
  PUBLICO="000"
  if [ -n "$URL" ]; then
    PUBLICO=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -u "$BASIC" -H 'ngrok-skip-browser-warning: 1' \
      "${URL}/health?token=${TOKEN}" 2>/dev/null || true)
    PUBLICO="${PUBLICO:-000}"
  fi

  log "local=${LOCAL} bot=${BOT_PID:-'-'} publico=${PUBLICO} url=${URL:-'-'} instancias server=${SERVER_N} bot=${BOT_N} tunel=${TUNEL_N}"

  if [ "$LOCAL" != "200" ] || [ "$SERVER_N" -eq 0 ]; then
    log "motivo=server no responde (http=${LOCAL} instancias=${SERVER_N}); relanzando scripts/server.sh"
    bash scripts/server.sh >> datos/keepalive.log 2>&1
  fi

  if [ -z "$BOT_PID" ]; then
    log "motivo=bot caido; relanzando scripts/bot.sh"
    bash scripts/bot.sh >> datos/keepalive.log 2>&1
  fi

  if [ "$PUBLICO" != "200" ] || [ "$TUNEL_N" -eq 0 ]; then
    log "motivo=tunel publico no responde (http=${PUBLICO} instancias=${TUNEL_N}); relanzando scripts/tunel.sh"
    bash scripts/tunel.sh >> datos/keepalive.log 2>&1
  fi

  sleep "$INTERVALO"
done
