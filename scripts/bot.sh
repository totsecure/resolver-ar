#!/usr/bin/env bash
# bot.sh — arranca el bot de Telegram en background (idempotente).
# La vida del proceso se chequea por datos/bot.pid + kill -0, nunca por pgrep.
set -uo pipefail

cd /Users/bunker/resolver || { echo "ERROR: no existe /Users/bunker/resolver"; exit 1; }
mkdir -p datos

# Token y allow list desde datos/bot.env (el bot tambien lo lee).
if [ -f datos/bot.env ]; then
  set -a
  . datos/bot.env
  set +a
fi

vivo() {
  local pf="$1" pid
  [ -f "$pf" ] || return 1
  pid="$(cat "$pf" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ "$pid" -gt 0 ] || return 1
  kill -0 "$pid" 2>/dev/null
}

arrancar_unico() {
  local pf="$1"; shift
  if vivo "$pf"; then
    local viejo; viejo="$(cat "$pf")"
    kill "$viejo" 2>/dev/null || true
    for _ in $(seq 1 20); do vivo "$pf" || break; sleep 0.25; done
    kill -9 "$viejo" 2>/dev/null || true
  fi
  rm -f "$pf"
  "$@" &
  echo $! > "$pf"
}

arrancar_unico "datos/bot.pid" sh -c 'exec nohup node bot/telegram.js >> datos/bot.log 2>&1' >/dev/null
echo "bot pid=$(cat datos/bot.pid)"
