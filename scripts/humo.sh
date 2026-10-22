#!/usr/bin/env bash
# humo.sh — prueba de humo del resolver. NO aborta al primer fallo: corre todos
# los chequeos, imprime OK/FAIL y termina con 0 solo si todos dieron OK.
#
#   bash scripts/humo.sh
#
# Chequea: instancias unicas, /health, /stats, /ficha/30756789, /repo,
# /lote (1 tarjeta), /titulares?n=2, X-Ms y <200 ms en /lote, tunel publico,
# Worker y bot (getMe), 401 sin token (local y Worker) y /gh/README.md.
# /gh se marca SKIP si falta GH_TOKEN. Las credenciales salen de datos/server.env.
set -uo pipefail

RAIZ="/Users/bunker/resolver"
WORKER_URL="https://resolver-api.correonube.workers.dev"
CARDS="4111111111111111%7C12%7C28%7C123"
TMP=$(mktemp -t resolver-humo.XXXXXX)
TMPH=$(mktemp -t resolver-humo-h.XXXXXX)
trap 'rm -f "$TMP" "$TMPH"' EXIT

cd "$RAIZ" || { echo "ERROR: no existe $RAIZ"; exit 1; }
mkdir -p datos

if [ -f datos/server.env ]; then
  set -a
  # shellcheck disable=SC1091
  . datos/server.env
  set +a
fi
PUERTO="${PORT:-3001}"
if [ -z "${RESOLVER_TOKEN:-}" ]; then
  echo "ERROR: falta RESOLVER_TOKEN en datos/server.env"
  exit 1
fi
TOKEN="$RESOLVER_TOKEN"
BASIC="${NGROK_USER:-}:${NGROK_PASS:-}"
BASE="http://localhost:${PUERTO}"

OK=0
FAIL=0
SKIP=0

ok() {
  OK=$((OK + 1))
  echo "  OK    $1${2:+ :: $2}"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "  FAIL  $1 :: $2"
}

skip() {
  SKIP=$((SKIP + 1))
  echo "  SKIP  $1${2:+ :: $2}"
}

echo "HUMO resolver-ar — $(date '+%Y-%m-%d %H:%M:%S')"
echo "local=$BASE"

# 0) exactamente una instancia de cada proceso
SERVER_N=$(pgrep -f "node server.js" | wc -l | tr -d ' ')
BOT_N=$(pgrep -f "bot/telegram.js" | wc -l | tr -d ' ')
TUNEL_N=$(pgrep -f "ngrok http" | wc -l | tr -d ' ')
INSTANCIAS="instancias server=${SERVER_N} bot=${BOT_N} tunel=${TUNEL_N}"
if [ "$SERVER_N" -gt 1 ] || [ "$BOT_N" -gt 1 ] || [ "$TUNEL_N" -gt 1 ]; then
  fail "instancias unicas" "$INSTANCIAS"
else
  ok "instancias unicas" "$INSTANCIAS"
fi

# 1) /health
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 5 "${BASE}/health?token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '"ok":true' "$TMP"; then
  ok "/health" "http=200 $(head -c 120 "$TMP")"
else
  fail "/health" "http=${CODE:-000} $(head -c 200 "$TMP")"
fi

# 2) /stats
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 20 "${BASE}/stats?token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '"personas"' "$TMP"; then
  ok "/stats" "http=200"
else
  fail "/stats" "http=${CODE:-000} $(head -c 200 "$TMP")"
fi

# 3) /ficha/30756789 (10 lineas)
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 20 "${BASE}/ficha/30756789?token=${TOKEN}" 2>/dev/null || true)
LINEAS=$(wc -l < "$TMP" | tr -d ' ')
if [ "$CODE" = "200" ] && [ "$LINEAS" = "10" ] && grep -q '^DNI 30756789$' "$TMP" && grep -q '^MAIL ' "$TMP"; then
  ok "/ficha/30756789" "http=200 lineas=10"
else
  fail "/ficha/30756789" "http=${CODE:-000} lineas=${LINEAS:-0} $(head -c 200 "$TMP")"
fi

# 3b) /repo lee el repo local (fuente de verdad)
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 10 "${BASE}/repo?path=README.md&token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '^# resolver-ar' "$TMP"; then
  ok "/repo?path=README.md" "http=200"
else
  fail "/repo?path=README.md" "http=${CODE:-000} $(head -c 160 "$TMP")"
fi
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 10 "${BASE}/repo?path=lib/ficha.js&token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '^export' "$TMP"; then
  ok "/repo?path=lib/ficha.js" "http=200"
else
  fail "/repo?path=lib/ficha.js" "http=${CODE:-000} $(head -c 160 "$TMP")"
fi

# 4) /lote con 1 tarjeta
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 30 "${BASE}/lote?token=${TOKEN}&cards=${CARDS}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '^TARJETA #1$' "$TMP" && grep -q '^DATOS TITULAR$' "$TMP" && grep -q '^CC 4111111111111111$' "$TMP"; then
  ok "/lote (1 tarjeta)" "http=200"
else
  fail "/lote (1 tarjeta)" "http=${CODE:-000} $(head -c 200 "$TMP")"
fi

# 5) /titulares?n=2
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 20 "${BASE}/titulares?n=2&token=${TOKEN}" 2>/dev/null || true)
BLOQUES=$(grep -c '^DATOS TITULAR$' "$TMP" 2>/dev/null || true)
if [ "$CODE" = "200" ] && [ "$BLOQUES" = "2" ] && grep -q '^DNI 30756789$' "$TMP" && grep -q '^DNI 39466006$' "$TMP"; then
  ok "/titulares?n=2" "http=200 bloques=2"
else
  fail "/titulares?n=2" "http=${CODE:-000} bloques=${BLOQUES:-0} $(head -c 200 "$TMP")"
fi

# 6) /lote devuelve X-Ms y tarda menos de 200 ms
RESULTADO=$(curl -s -D "$TMPH" -o "$TMP" -w '%{http_code} %{time_total}' --max-time 30 \
  "${BASE}/lote?token=${TOKEN}&cards=${CARDS}" 2>/dev/null || true)
STATUS=$(echo "$RESULTADO" | awk '{print $1}')
TIEMPO=$(echo "$RESULTADO" | awk '{print $2}')
XMS=$(grep -i '^x-ms:' "$TMPH" 2>/dev/null | tail -1 | tr -d '\r' | awk '{print $2}')
if [ "$STATUS" = "200" ] && [ -n "$XMS" ] && awk -v t="$TIEMPO" 'BEGIN { exit !(t < 0.2) }'; then
  ok "/lote X-Ms" "x-ms=${XMS} tiempo=${TIEMPO}s"
else
  fail "/lote X-Ms" "http=${STATUS:-000} x-ms=${XMS:-'-'} tiempo=${TIEMPO:-'-'}s (limite 0.2s)"
fi

# 7) tunel publico (ngrok con basic auth)
URL=$(cat datos/tunel.url 2>/dev/null || true)
if [ -z "$URL" ]; then
  fail "tunel publico" "falta datos/tunel.url"
else
  CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 15 \
    -u "$BASIC" -H 'ngrok-skip-browser-warning: 1' "${URL}/health?token=${TOKEN}" 2>/dev/null || true)
  if [ "$CODE" = "200" ] && grep -q '"ok":true' "$TMP"; then
    ok "tunel publico" "http=200 $URL"
  else
    fail "tunel publico" "http=${CODE:-000} $URL $(head -c 160 "$TMP")"
  fi
fi

# 8) Worker publico
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 15 "${WORKER_URL}/health?token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '"ok":true' "$TMP"; then
  ok "Worker publico" "$WORKER_URL"
else
  fail "Worker publico" "http=${CODE:-000} $WORKER_URL $(head -c 160 "$TMP")"
fi

# 8b) sin token: local y Worker deben dar 401 (el Worker no llega a ngrok)
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 10 "${BASE}/health" 2>/dev/null || true)
[ "$CODE" = "401" ] && ok "local sin token" "http=401" || fail "local sin token" "http=${CODE:-000}"
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 10 "${WORKER_URL}/health" 2>/dev/null || true)
[ "$CODE" = "401" ] && ok "Worker sin token" "http=401" || fail "Worker sin token" "http=${CODE:-000}"

# 8c) /gh/README.md por el Worker (repo privado con GH_TOKEN)
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 15 "${WORKER_URL}/gh/README.md?token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '^# resolver-ar' "$TMP"; then
  ok "/gh/README.md" "http=200"
elif grep -q 'falta GH_TOKEN' "$TMP"; then
  skip "/gh/README.md" "falta GH_TOKEN en el Worker"
else
  fail "/gh/README.md" "http=${CODE:-000} $(head -c 160 "$TMP")"
fi

# 9) bot vivo (getMe + proceso)
if [ -f datos/bot.env ]; then
  set -a
  # shellcheck disable=SC1091
  . datos/bot.env
  set +a
fi
TG_TOKEN="${TELEGRAM_TOKEN:-}"
BOT_PID=$(pgrep -f "bot/telegram.js" | head -1 || true)
if [ -z "$TG_TOKEN" ]; then
  fail "bot getMe" "falta TELEGRAM_TOKEN en datos/bot.env"
else
  CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 15 \
    "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>/dev/null || true)
  if [ "$CODE" = "200" ] && grep -q '"ok":true' "$TMP" && grep -q '"is_bot":true' "$TMP" && [ -n "$BOT_PID" ]; then
    ok "bot getMe" "pid=${BOT_PID}"
  else
    fail "bot getMe" "http=${CODE:-000} pid=${BOT_PID:-'-'} $(head -c 160 "$TMP")"
  fi
fi

echo ""
echo "RESUMEN: ${OK} OK / ${FAIL} FAIL / ${SKIP} SKIP"
[ "$FAIL" -eq 0 ] && exit 0
exit 1
