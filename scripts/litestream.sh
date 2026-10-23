#!/usr/bin/env bash
# litestream.sh — wrapper de arranque para launchd.
# Espera el disco externo (hasta 5 min) y ejecuta litestream en primer plano.
# launchd lo relanza si sale (KeepAlive + ThrottleInterval).
set -uo pipefail

RAIZ="/Users/bunker/resolver"
BIN="$RAIZ/varios/bin/litestream"
DESTINO="/Volumes/Boveda/litestream"

if [ ! -x "$BIN" ]; then
  echo "ERROR: falta el binario $BIN (bajar litestream v0.5.17 darwin-arm64)"
  exit 1
fi

for _ in $(seq 1 60); do
  [ -d /Volumes/Boveda ] && break
  sleep 5
done
if [ ! -d /Volumes/Boveda ]; then
  echo "ERROR: disco externo /Volumes/Boveda no montado; reintento en el próximo arranque"
  exit 1
fi

mkdir -p "$DESTINO"
exec "$BIN" replicate -config "$RAIZ/deploy/litestream.yml"
