#!/usr/bin/env bash
# consultas.sh — arranca el bot de consultas en background (idempotente).
# Igual que bot.sh pero con datos/consultas.env: ese env DEBE cargarse despues
# de bot.env para que su TELEGRAM_TOKEN (distinto) pise al de ventas, o Telegram
# corta con 409 por doble poller.
set -uo pipefail

cd /Volumes/Boveda/resolver || { echo "ERROR: no existe /Volumes/Boveda/resolver"; exit 1; }
mkdir -p datos

if [ -f datos/bot.env ]; then
  set -a
  . datos/bot.env
  set +a
fi
if [ -f datos/consultas.env ]; then
  set -a
  . datos/consultas.env
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

arrancar_unico "datos/consultas.pid" sh -c 'exec nohup node bot/consultas.js >> datos/consultas.log 2>&1' >/dev/null
echo "consultas pid=$(cat datos/consultas.pid)"
