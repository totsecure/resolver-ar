#!/usr/bin/env bash
# keepalive.sh — vigila los TRES procesos del resolver:
#   1) server.js          (health HTTP local)
#   2) bot/telegram.js    (datos/bot.pid + kill -0)
#   3) tunel ngrok        (health publico)
#
# Relanza con el entorno correcto:
#   - server: datos/server.env (PORT, RESOLVER_TOKEN, RESOLVER_DB, TZ)
#   - bot:    datos/bot.env (TELEGRAM_TOKEN, TELEGRAM_ALLOW)
#   - tunel:  scripts/tunel.sh (usa el mismo server.env)
#
# Liveness SIEMPRE por pidfile + kill -0, nunca por pgrep: en macOS pgrep
# puede no ver el proceso y el conteo con ps|grep se infla con el propio comando.
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

vivo() {
  local pf="$1" pid
  [ -f "$pf" ] || return 1
  pid="$(cat "$pf" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ "$pid" -gt 0 ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# Procesos con el comando exacto, sin pgrep ni grep sobre la lista de ps.
pids_de() {
  local tipo="$1"
  ps -Ao pid=,args= | awk -v tipo="$tipo" -v yo="$$" '
    $1 == yo { next }
    tipo == "server" && $2 == "node" && $3 == "server.js" { print $1 }
    tipo == "bot" && $2 == "node" && $3 == "bot/telegram.js" { print $1 }
    tipo == "tunel" && $2 == "ngrok" && $3 == "http" { print $1 }
  '
}

# Si el pidfile apunta a un proceso vivo, no toca nada. Solo si el pidfile
# esta muerto y hay un proceso huerfano del mismo tipo, mata el sobrante.
podar() {
  local nombre="$1" pf="$2" pids
  vivo "$pf" && return 0
  pids="$(pids_de "$nombre")"
  if [ -z "$pids" ]; then
    rm -f "$pf"
    return 0
  fi
  log "motivo=pidfile muerto ($pf) y proceso huerfano $nombre; matando $(printf '%s' "$pids" | tr '\n' ' ')"
  kill $pids 2>/dev/null || true
  sleep 1
  kill -9 $pids 2>/dev/null || true
  rm -f "$pf"
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
  podar server datos/server.pid
  podar bot datos/bot.pid
  podar tunel datos/tunel.pid

  LOCAL=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://localhost:${PUERTO}/health?token=${TOKEN}" 2>/dev/null || true)
  LOCAL="${LOCAL:-000}"

  BOT_PID=$(cat datos/bot.pid 2>/dev/null || true)

  URL=$(cat datos/tunel.url 2>/dev/null || true)
  PUBLICO="000"
  if [ -n "$URL" ]; then
    PUBLICO=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -u "$BASIC" -H 'ngrok-skip-browser-warning: 1' \
      "${URL}/health?token=${TOKEN}" 2>/dev/null || true)
    PUBLICO="${PUBLICO:-000}"
  fi

  log "local=${LOCAL} bot_pid=${BOT_PID:-'-'} bot_vivo=$(vivo datos/bot.pid && echo si || echo no) publico=${PUBLICO} url=${URL:-'-'}"

  if [ "$LOCAL" != "200" ]; then
    log "motivo=server no responde (http=${LOCAL}); relanzando scripts/server.sh"
    bash scripts/server.sh >> datos/keepalive.log 2>&1
  fi

  if ! vivo datos/bot.pid; then
    log "motivo=bot sin pidfile vivo; relanzando scripts/bot.sh"
    bash scripts/bot.sh >> datos/keepalive.log 2>&1
  fi

  if [ "$PUBLICO" != "200" ]; then
    log "motivo=tunel publico no responde (http=${PUBLICO}); relanzando scripts/tunel.sh"
    bash scripts/tunel.sh >> datos/keepalive.log 2>&1
  fi

  bash scripts/backup-stock.sh
  sleep "$INTERVALO"
done
