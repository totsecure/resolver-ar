#!/usr/bin/env bash
# datasette.sh — visor read-only de datos/stock.db en 127.0.0.1:3003.
#
# Auth: token Bearer o ?token=<token>. El token vive en datos/datasette.token
# (chmod 600, datos/ está gitignored). Datasette abre SQLite en mode=ro y con
# PRAGMA query_only=1; no hay endpoints de escritura.
set -euo pipefail

RAIZ="/Users/bunker/resolver"
PUERTO="${DATASETTE_PORT:-3003}"
TOKEN_FILE="$RAIZ/datos/datasette.token"
META="$RAIZ/datos/datasette-metadata.json"
BIN="$RAIZ/varios/datasette-venv/bin/datasette"

cd "$RAIZ" || exit 1
mkdir -p datos
if [ ! -x "$BIN" ]; then
  echo "ERROR: falta $BIN (crear venv e instalar datasette + datasette-auth-tokens)"
  exit 1
fi
if [ ! -f "$TOKEN_FILE" ]; then
  openssl rand -hex 24 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi
TOKEN="$(cat "$TOKEN_FILE")"

umask 077
cat > "$META" <<JSON
{
  "title": "RESOLVER STOCK (solo lectura)",
  "allow": { "id": "resolver" },
  "plugins": {
    "datasette-auth-tokens": {
      "tokens": [
        { "token": "$TOKEN", "actor": { "id": "resolver" } }
      ],
      "param": "token"
    }
  }
}
JSON
chmod 600 "$META"

exec "$BIN" "$RAIZ/datos/stock.db" \
  --metadata "$META" \
  --host 127.0.0.1 --port "$PUERTO" \
  --setting default_page_size 50 \
  --setting sql_time_limit_ms 10000 \
  --setting max_returned_rows 2000 \
  --setting allow_download 0
