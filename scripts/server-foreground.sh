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
export HOST="${HOST:-127.0.0.1}"
export RESOLVER_DB="${RESOLVER_DB:-$RAIZ/datos/padron.db}"
export TZ="${TZ:-America/Argentina/Buenos_Aires}"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [ -z "${RESOLVER_TOKEN:-}" ]; then
  echo "ERROR: falta RESOLVER_TOKEN en datos/server.env" >&2
  exit 1
fi

# Gate de arranque: si un deploy deja un módulo con error de sintaxis, avisamos
# claro en el log en vez de morir con SyntaxError y quedar en loop de reinicio.
for f in server.js lib/panel.js lib/catalogo.js lib/auth.js lib/stock.js; do
  if ! /usr/local/bin/node --check "$RAIZ/$f" 2>/tmp/_check.$$; then
    echo "ERROR de sintaxis en $f:" >&2
    cat /tmp/_check.$$ >&2
    rm -f /tmp/_check.$$
    exit 1
  fi
done
rm -f /tmp/_check.$$

echo $$ > datos/server.pid
exec /usr/local/bin/node server.js
