#!/usr/bin/env bash
# vigilar.sh — chequeo de salud cada minuto (cron de root en el VPS; antes launchd en la Mac).
#
# Mide servicios reales, no pidfiles:
#   1) server local      GET /health?token=            -> 200 + ok:true
#   2) tunel (via Worker) GET $WORKER_URL/health?token -> 200 + ok:true
#   3) bot proceso       pidfile vivo (kill -0)
#   4) bot token         Telegram getMe                -> ok:true, is_bot:true
#
# Alerta por Telegram (scripts/alertar.sh) en la transicion OK->FALLA y avisa
# cuando se recupera. Mientras sigue caído, recuerda cada COOLDOWN segundos.
# Estado por chequeo en datos/vigilar-<nombre>.estado. Log: datos/vigilar.log.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_URL="${WORKER_URL:-https://resolver-api.correonube.workers.dev}"
COOLDOWN="${VIGILAR_COOLDOWN:-1800}"
cd "$RAIZ" || exit 1
mkdir -p datos

[ -f datos/server.env ] && set -a && . datos/server.env && set +a
[ -f datos/bot.env ] && set -a && . datos/bot.env && set +a
TOKEN="${RESOLVER_TOKEN:-}"
PUERTO="${PORT:-3001}"
TG_TOKEN="${TELEGRAM_TOKEN:-}"

LOG="$RAIZ/datos/vigilar.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
alertar() { bash "$RAIZ/scripts/alertar.sh" "$1" >> "$LOG" 2>&1; }

revisar() {
  local nombre="$1" ok="$2" detalle="$3"
  local f="$RAIZ/datos/vigilar-${nombre}.estado"
  local previo="" ultimo=0 fallos=0
  if [ -f "$f" ]; then read -r previo ultimo fallos < "$f" || true; fi
  local ahora; ahora="$(date +%s)"
  case "$ultimo" in ''|*[!0-9]*) ultimo=0 ;; esac
  case "$fallos" in ''|*[!0-9]*) fallos=0 ;; esac

  if [ "$ok" = "1" ]; then
    if [ "$previo" = "down" ]; then
      alertar "RECUPERADO: $nombre — $detalle"
      log "$nombre UP (recuperado) $detalle"
    else
      log "$nombre UP $detalle"
    fi
    echo "up $ahora 0" > "$f"
    return 0
  fi

  # Un 404/5xx aislado del tunel (ngrok reconectando) no debe alertar: exigimos
  # VIGILAR_FALLOS (2 por defecto) fallos consecutivos antes de declarar caida.
  fallos=$((fallos + 1))
  local umbral="${VIGILAR_FALLOS:-2}"
  if [ "$fallos" -lt "$umbral" ] && [ "$previo" != "down" ]; then
    log "$nombre DOWN? (1/$umbral) $detalle"
    echo "down $ahora $fallos" > "$f"
    return 0
  fi

  if [ "$previo" != "down" ] || [ $((ahora - ultimo)) -ge "$COOLDOWN" ]; then
    alertar "FALLA: $nombre — $detalle"
    log "$nombre DOWN (alerta) $detalle"
    echo "down $ahora $fallos" > "$f"
  else
    log "$nombre DOWN (cooldown) $detalle"
    echo "down $ultimo $fallos" > "$f"
  fi
}

TMP="$(mktemp -t resolver-vigilar.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

# 1) server local
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 8 "http://127.0.0.1:${PUERTO}/health?token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '"ok":true' "$TMP"; then
  revisar "local" 1 "http=200"
else
  revisar "local" 0 "http=${CODE:-000} http://127.0.0.1:${PUERTO}/health"
fi

# 2) tunel a traves del Worker (el root no tiene ruta; /health si)
CODE=$(curl -sL -o "$TMP" -w '%{http_code}' --max-time 15 "${WORKER_URL}/health?token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '"ok":true' "$TMP"; then
  revisar "publico" 1 "http=200 ${WORKER_URL}/health"
else
  revisar "publico" 0 "http=${CODE:-000} ${WORKER_URL}/health"
fi

# 3) bot proceso: pidfile vivo (esto es lo que faltaba)
BOT_PID="$(cat "$RAIZ/datos/bot.pid" 2>/dev/null || true)"
if [ -n "$BOT_PID" ] && kill -0 "$BOT_PID" 2>/dev/null; then
  revisar "bot-proceso" 1 "pid=${BOT_PID}"
else
  revisar "bot-proceso" 0 "pidfile muerto o ausente (pid='${BOT_PID:-}')"
fi

# 4) bot token: la API responde (no prueba que el proceso local viva)
if [ -z "$TG_TOKEN" ]; then
  revisar "bot-token" 0 "falta TELEGRAM_TOKEN en datos/bot.env"
else
  CODE=$(curl -4 -s -o "$TMP" -w '%{http_code}' --max-time 15 "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>/dev/null || true)
  if [ "$CODE" = "200" ] && grep -q '"ok":true' "$TMP" && grep -q '"is_bot":true' "$TMP"; then
    revisar "bot-token" 1 "getMe http=200"
  else
    revisar "bot-token" 0 "getMe http=${CODE:-000}"
  fi
fi

exit 0
