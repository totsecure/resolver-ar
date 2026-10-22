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
pkill -f '^node bot/telegram\.js$' >/dev/null 2>&1 || true
sleep 1

nohup node bot/telegram.js >> datos/bot.log 2>&1 &
echo $! > datos/bot.pid
echo "bot pid=$(cat datos/bot.pid)"
