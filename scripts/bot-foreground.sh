#!/usr/bin/env bash
# bot-foreground.sh — bot de Telegram en primer plano para launchd.
# Escribe datos/bot.pid y lo borra al salir. No usa nohup: launchd supervisa.
set -uo pipefail
RAIZ="/Volumes/Boveda/resolver"
cd "$RAIZ" || exit 1
mkdir -p datos
[ -f datos/server.env ] && set -a && . datos/server.env && set +a
[ -f datos/bot.env ] && set -a && . datos/bot.env && set +a
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"

echo $$ > datos/bot.pid
limpiar() { rm -f datos/bot.pid; }
trap limpiar EXIT
node bot/telegram.js &
HIJO=$!
trap 'kill "$HIJO" 2>/dev/null; wait "$HIJO" 2>/dev/null; limpiar' TERM INT EXIT
wait "$HIJO"
