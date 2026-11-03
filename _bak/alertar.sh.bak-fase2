#!/usr/bin/env bash
# alertar.sh — manda una alerta al Telegram del admin (o al primer permitido).
set -uo pipefail
RAIZ="/Users/bunker/resolver"
[ -f "$RAIZ/datos/bot.env" ] && set -a && . "$RAIZ/datos/bot.env" && set +a
[ -f "$RAIZ/datos/server.env" ] && set -a && . "$RAIZ/datos/server.env" && set +a
MSG="${1:-Alerta de resolver}"
if [ "${ALERTA_DRY:-0}" = "1" ]; then
  echo "ALERTA: $MSG"
  exit 0
fi
TOKEN="${TELEGRAM_TOKEN:-}"
CHAT="${TELEGRAM_ADMIN:-${TELEGRAM_AUDIT:-${TELEGRAM_ALLOW%%,*}}}"
[ -z "$TOKEN" ] || [ -z "$CHAT" ] && { echo "sin TELEGRAM_TOKEN/TELEGRAM_ADMIN" >&2; exit 1; }
curl -sS --max-time 10 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT}" --data-urlencode "text=⚠️ ${MSG}" >/dev/null
