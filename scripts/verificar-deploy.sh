#!/usr/bin/env bash
# verificar-deploy.sh — prueba que el server es portable: arranca y sirve el
# panel/health SIN padrón (caso de un host free sin los 1.4 GB de padron.db).
#
#   bash scripts/verificar-deploy.sh
#
# Usa un puerto y DBs descartables. No toca producción.
set -uo pipefail
RAIZ="/Volumes/Boveda/resolver"
PUERTO="${DEPLOY_PORT:-3023}"
DIR="$(mktemp -d -t resolver-deploy.XXXXXX)"
TOK="deploy-test-token"

cd "$RAIZ"
fails=0
ok()  { echo "  OK    $1"; }
bad() { echo "  FAIL  $1"; fails=$((fails+1)); }

echo "VERIFICAR DEPLOY (portabilidad sin padrón) — $DIR"

env -i PATH="$PATH" HOME="$HOME" TZ=UTC \
  PORT="$PUERTO" HOST=127.0.0.1 RESOLVER_TOKEN="$TOK" \
  RESOLVER_STOCK_DB="$DIR/stock.db" RESOLVER_DB="$DIR/padron.db" \
  node server.js > "$DIR/srv.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "$DIR"' EXIT

# esperar arranque
for _ in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PUERTO/health" 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 0.25
done

[ "$code" = "200" ] && ok "/health público responde sin padrón" || bad "/health (http=$code)"
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PUERTO/panel/datos?token=$TOK")
[ "$c" = "200" ] && ok "panel/datos responde sin padrón" || bad "panel/datos (http=$c)"
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PUERTO/login")
[ "$c" = "200" ] && ok "/login responde sin padrón" || bad "/login (http=$c)"
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PUERTO/texto/3348?token=$TOK")
[ "$c" = "503" ] && ok "/texto avisa 503 (sin padrón) en vez de caer" || bad "/texto (http=$c, se esperaba 503)"
curl -s --max-time 3 "http://127.0.0.1:$PUERTO/health" | grep -q '"padron":false' && ok "health reporta padron=false" || bad "health no reporta padron"

echo ""
if [ "$fails" -eq 0 ]; then echo "DEPLOY OK (portable)"; exit 0; fi
echo "DEPLOY CON $fails FALLA(S)"; sed -n '1,20p' "$DIR/srv.log"; exit 1
