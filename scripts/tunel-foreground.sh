#!/usr/bin/env bash
# tunel-foreground.sh — ngrok en primer plano para launchd (ar.resolver.tunel).
# launchd es el supervisor: si ngrok muere, lo relanza (KeepAlive).
# No hay loop de sleep ni auto-relanzado dentro del script.
set -euo pipefail

RAIZ="/Volumes/Boveda/resolver"
URL="https://action-early-pants.ngrok-free.dev"
cd "$RAIZ" || exit 1
mkdir -p datos

if [ -f datos/server.env ]; then
  set -a
  # shellcheck disable=SC1091
  . datos/server.env
  set +a
fi
PUERTO="${PORT:-3001}"
if [ -z "${NGROK_USER:-}" ] || [ -z "${NGROK_PASS:-}" ]; then
  echo "ERROR: faltan NGROK_USER/NGROK_PASS en datos/server.env"
  exit 1
fi
if [ ! -x /opt/homebrew/bin/ngrok ]; then
  echo "ERROR: falta /opt/homebrew/bin/ngrok"
  exit 1
fi

echo "== tunel-foreground $(date '+%Y-%m-%d %H:%M:%S') pid=$$ =="
echo $$ > datos/tunel.pid
printf '%s\n' "$URL" > datos/tunel.url

exec /opt/homebrew/bin/ngrok http "$PUERTO" --url="$URL" --basic-auth="${NGROK_USER}:${NGROK_PASS}"
