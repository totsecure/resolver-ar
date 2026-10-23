#!/usr/bin/env bash
# server-foreground.sh — server.js en primer plano para launchd.
# Carga datos/server.env, escribe datos/server.pid con su propio PID y hace exec
# (el PID no cambia), así humo.sh sigue verificando por pidfile + kill -0.
set -uo pipefail

RAIZ="/Users/bunker/resolver"
cd "$RAIZ" || exit 1
mkdir -p datos

if [ -f datos/server.env ]; then
  set -a
  # shellcheck disable=SC1091
  . datos/server.env
  set +a
fi

export PORT="${PORT:-3001}"
export RESOLVER_DB="${RESOLVER_DB:-$RAIZ/datos/padron.db}"
export TZ="${TZ:-America/Argentina/Buenos_Aires}"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [ -z "${RESOLVER_TOKEN:-}" ]; then
  echo "ERROR: falta RESOLVER_TOKEN en datos/server.env" >&2
  exit 1
fi

echo $$ > datos/server.pid
exec /usr/local/bin/node server.js
