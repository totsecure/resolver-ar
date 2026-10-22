#!/usr/bin/env bash
# bot.sh — arranca el bot de Telegram en background (idempotente).
set -uo pipefail

cd /Users/bunker/resolver || { echo "ERROR: no existe /Users/bunker/resolver"; exit 1; }
mkdir -p datos

# Token y allow list desde datos/bot.env (el bot tambien lo lee).
if [ -f datos/bot.env ]; then
  set -a
  . datos/bot.env
  set +a
fi

# Si ya hay un bot corriendo, matarlo antes de relanzar.
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

arrancar_unico "bot/telegram.js" sh -c 'exec nohup node bot/telegram.js >> datos/bot.log 2>&1' >/dev/null
echo "bot pid=$(cat datos/bot.pid)"
