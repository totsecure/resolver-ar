#!/usr/bin/env bash
# consultas-foreground.sh — bot de consultas en primer plano para launchd.
# Mismo patron que bot-foreground.sh. datos/consultas.env va DESPUES de bot.env
# para pisar TELEGRAM_TOKEN con el del bot de consultas (si no, 409).
set -uo pipefail
RAIZ="/Volumes/Boveda/resolver"
cd "$RAIZ" || exit 1
mkdir -p datos
[ -f datos/server.env ] && set -a && . datos/server.env && set +a
[ -f datos/bot.env ] && set -a && . datos/bot.env && set +a
[ -f datos/consultas.env ] && set -a && . datos/consultas.env && set +a
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"

echo $$ > datos/consultas.pid
limpiar() { rm -f datos/consultas.pid; }
trap limpiar EXIT
node bot/consultas.js &
HIJO=$!
trap 'kill "$HIJO" 2>/dev/null; wait "$HIJO" 2>/dev/null; limpiar' TERM INT EXIT
wait "$HIJO"
