#!/usr/bin/env bash
# humo.sh — prueba de humo del resolver. NO aborta al primer fallo: corre todos
# los chequeos, imprime OK/FAIL y termina con 0 solo si todos dieron OK.
#
#   bash scripts/humo.sh
#
# Chequea: liveness del server, /health, /stats,
# /ficha/30756789, /repo, /lote (1 tarjeta), /titulares?n=2, X-Ms y <200 ms
# en /lote, tunel publico (/health con token), Worker (/gh con y sin token),
# bot (getMe) y snapshot /gh desde el KV (sin GH_TOKEN).
# Las credenciales salen de datos/server.env. No usa pgrep.
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

vivo() {
  local pf="$1" pid
  [ -f "$pf" ] || return 1
  pid="$(cat "$pf" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ "$pid" -gt 0 ] || return 1
  kill -0 "$pid" 2>/dev/null
}

DB_REAL="$RAIZ/datos/stock.db"
contar_db() { sqlite3 "$DB_REAL" "$1" 2>/dev/null || echo '?'; }
CC0=$(contar_db 'SELECT COUNT(*) FROM cc;')
USR0=$(contar_db 'SELECT COUNT(*) FROM usuarios;')

echo "HUMO resolver-ar — $(date '+%Y-%m-%d %H:%M:%S')"
echo "local=$BASE"

# 0) liveness del server por pidfile + kill -0 (el bot y el tunel se miden por
#    respuesta real en sus propias secciones, no por pidfile).
SERVER_OK=0; vivo datos/server.pid && SERVER_OK=1
INSTANCIAS="instancias server=${SERVER_OK}"
if [ "$SERVER_OK" -eq 1 ]; then
  ok "instancias unicas" "$INSTANCIAS"
else
  fail "instancias unicas" "$INSTANCIAS (pidfile server muerto)"
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

# 4b) carga masiva de CC: 3 validas + 1 duplicada + 1 invalida (DB temporal)
if node scripts/test-carga-cc.mjs > "$TMP" 2>&1; then
  ok "carga CC (analizar/confirmar)" "$(tail -1 "$TMP")"
else
  fail "carga CC (analizar/confirmar)" "$(tail -3 "$TMP" | tr '\n' ' ')"
fi

# 4c) auth fase 1: hash/sesiones/2FA (base temporal) y flujo HTTP real
if node scripts/test-auth.mjs > "$TMP" 2>&1; then
  ok "auth (fase 1)" "$(tail -1 "$TMP")"
else
  fail "auth (fase 1)" "$(tail -3 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-auth-http.mjs > "$TMP" 2>&1; then
  ok "auth HTTP (fase 1)" "$(tail -1 "$TMP")"
else
  fail "auth HTTP (fase 1)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-fase2.mjs > "$TMP" 2>&1; then
  ok "vendedores/saldo/catalogo (fase 2)" "$(tail -1 "$TMP")"
else
  fail "vendedores/saldo/catalogo (fase 2)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-fase2-http.mjs > "$TMP" 2>&1; then
  ok "fase 2 HTTP" "$(tail -1 "$TMP")"
else
  fail "fase 2 HTTP" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-fase3.mjs > "$TMP" 2>&1; then
  ok "concurrencia/ventana/pago (fase 3)" "$(tail -1 "$TMP")"
else
  fail "concurrencia/ventana/pago (fase 3)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-fase3-http.mjs > "$TMP" 2>&1; then
  ok "fase 3 HTTP" "$(tail -1 "$TMP")"
else
  fail "fase 3 HTTP" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-fase4.mjs > "$TMP" 2>&1; then
  ok "web<->telegram (fase 4)" "$(tail -1 "$TMP")"
else
  fail "web<->telegram (fase 4)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-fase4-http.mjs > "$TMP" 2>&1; then
  ok "fase 4 HTTP" "$(tail -1 "$TMP")"
else
  fail "fase 4 HTTP" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-fase5.mjs > "$TMP" 2>&1; then
  ok "admin/precios/reclamos (fase 5)" "$(tail -1 "$TMP")"
else
  fail "admin/precios/reclamos (fase 5)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-fase5-http.mjs > "$TMP" 2>&1; then
  ok "fase 5 HTTP" "$(tail -1 "$TMP")"
else
  fail "fase 5 HTTP" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-fase6.mjs > "$TMP" 2>&1; then
  ok "checker hook/cola (fase 6)" "$(tail -1 "$TMP")"
else
  fail "checker hook/cola (fase 6)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-fase6-http.mjs > "$TMP" 2>&1; then
  ok "fase 6 HTTP" "$(tail -1 "$TMP")"
else
  fail "fase 6 HTTP" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-b4-config.mjs > "$TMP" 2>&1; then
  ok "decisiones B4" "$(tail -1 "$TMP")"
else
  fail "decisiones B4" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-b6-lotes.mjs > "$TMP" 2>&1; then
  ok "lotes B6" "$(tail -1 "$TMP")"
else
  fail "lotes B6" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-b7-pipe.mjs > "$TMP" 2>&1; then
  ok "pipe/DNI B7" "$(tail -1 "$TMP")"
else
  fail "pipe/DNI B7" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-b9-reactivar.mjs > "$TMP" 2>&1; then
  ok "reactivar BAJA B9" "$(tail -1 "$TMP")"
else
  fail "reactivar BAJA B9" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-a1-a5.mjs > "$TMP" 2>&1; then
  ok "tienda busca/pide/filtra (A)" "$(tail -1 "$TMP")"
else
  fail "tienda busca/pide/filtra (A)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-fix1-fix2.mjs > "$TMP" 2>&1; then
  ok "trámite/teléfono (fix 1-2)" "$(tail -1 "$TMP")"
else
  fail "trámite/teléfono (fix 1-2)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-b1-b4.mjs > "$TMP" 2>&1; then
  ok "grupo B (bloque/saldo/busqueda)" "$(tail -1 "$TMP")"
else
  fail "grupo B (bloque/saldo/busqueda)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-concurrencia.mjs > "$TMP" 2>&1; then
  ok "concurrencia 20 reservas" "$(tail -1 "$TMP")"
else
  fail "concurrencia 20 reservas" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-c1-c4.mjs > "$TMP" 2>&1; then
  ok "grupo C (menu/paridad/avisos)" "$(tail -1 "$TMP")"
else
  fail "grupo C (menu/paridad/avisos)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-d1-d4.mjs > "$TMP" 2>&1; then
  ok "grupo D (pedidos/links/comprobante)" "$(tail -1 "$TMP")"
else
  fail "grupo D (pedidos/links/comprobante)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-e1-e5.mjs > "$TMP" 2>&1; then
  ok "grupo E (acciones/metricas/alertas)" "$(tail -1 "$TMP")"
else
  fail "grupo E (acciones/metricas/alertas)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-f1-f4.mjs > "$TMP" 2>&1; then
  ok "grupo F (cuenta/seguridad)" "$(tail -1 "$TMP")"
else
  fail "grupo F (cuenta/seguridad)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-g1-g4.mjs > "$TMP" 2>&1; then
  ok "grupo G (operacion/export)" "$(tail -1 "$TMP")"
else
  fail "grupo G (operacion/export)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-h1-h2.mjs > "$TMP" 2>&1; then
  ok "grupo H (checker)" "$(tail -1 "$TMP")"
else
  fail "grupo H (checker)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-fix6.mjs > "$TMP" 2>&1; then
  ok "FIX-6 (es_test quirurgico)" "$(tail -1 "$TMP")"
else
  fail "FIX-6 (es_test quirurgico)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi
if node scripts/test-precio-par.mjs > "$TMP" 2>&1; then
  ok "precio par (1 pago/cuotas)" "$(tail -1 "$TMP")"
else
  fail "precio par (1 pago/cuotas)" "$(tail -4 "$TMP" | tr '\n' ' ')"
fi

# 5) /titulares?n=2
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 20 "${BASE}/titulares?n=2&token=${TOKEN}" 2>/dev/null || true)
BLOQUES=$(grep -c '^DATOS TITULAR$' "$TMP" 2>/dev/null || true)
if [ "$CODE" = "200" ] && [ "$BLOQUES" = "2" ] && grep -q '^DNI 30756789$' "$TMP" && grep -q '^DNI 39466006$' "$TMP"; then
  ok "/titulares?n=2" "http=200 bloques=2"
else
  fail "/titulares?n=2" "http=${CODE:-000} bloques=${BLOQUES:-0} $(head -c 200 "$TMP")"
fi

# 5b) /panel/movs (pestaña Movimientos del panel)
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 10 "${BASE}/panel/movs?n=2&token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '"movs"' "$TMP" && grep -q '"cols"' "$TMP"; then
  ok "/panel/movs" "http=200"
else
  fail "/panel/movs" "http=${CODE:-000} $(head -c 160 "$TMP")"
fi

# 5c) panel detras del login: /panel/ sin sesion redirige, /login publico
RESP=$(curl -s -D "$TMPH" -o /dev/null -w '%{http_code}' --max-time 5 "${BASE}/panel/" 2>/dev/null || true)
LOC=$(grep -i '^location:' "$TMPH" 2>/dev/null | tail -1 | tr -d '\r' | awk '{print $2}')
if [ "$RESP" = "302" ] && [ "${LOC#/login}" != "$LOC" ]; then
  ok "/panel detras del login" "http=302 location=$LOC"
else
  fail "/panel detras del login" "http=${RESP:-000} location=${LOC:-'-'}"
fi
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 5 "${BASE}/login" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q 'RESOLVER' "$TMP"; then
  ok "/login publico" "http=200"
else
  fail "/login publico" "http=${CODE:-000}"
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

# 7) tunel publico: se mide a traves del Worker (Worker -> ngrok -> server local).
#    El host crudo de ngrok devuelve interstitial/404 sin basic auth; no sirve.
CODE=$(curl -sL -o "$TMP" -w '%{http_code}' --max-time 20 \
  "${WORKER_URL}/health?token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '"ok":true' "$TMP"; then
  ok "tunel publico" "Worker /health http=200"
else
  fail "tunel publico" "http=${CODE:-000} ${WORKER_URL}/health $(head -c 160 "$TMP")"
fi

# 8) Worker publico: el root no tiene ruta; se mide /gh/README.md con token.
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 15 "${WORKER_URL}/gh/README.md?token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '^# resolver-ar' "$TMP"; then
  ok "Worker publico" "$WORKER_URL/gh/README.md http=200"
else
  fail "Worker publico" "http=${CODE:-000} $WORKER_URL/gh/README.md $(head -c 160 "$TMP")"
fi

# 8b) sin token: local y Worker deben dar 401 (el Worker no llega a ngrok)
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 10 "${BASE}/health" 2>/dev/null || true)
[ "$CODE" = "401" ] && ok "local sin token" "http=401" || fail "local sin token" "http=${CODE:-000}"
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 10 "${WORKER_URL}/gh/README.md" 2>/dev/null || true)
[ "$CODE" = "401" ] && ok "Worker sin token" "http=401" || fail "Worker sin token" "http=${CODE:-000}"

# 8c) snapshot /gh al dia (hash local vs __manifest__.json del KV)
# Se usa --check (API de Cloudflare, consistente). --remoto puede leer un edge
# con KV todavia sin propagar justo despues de subir.
if node scripts/worker-repo.mjs --check > "$TMP" 2>&1; then
  ok "snapshot /gh" "$(tail -1 "$TMP")"
else
  fail "snapshot /gh" "$(tail -2 "$TMP" | tr '\n' ' ') (correr node scripts/worker-repo.mjs)"
fi

# 9) bot vivo (getMe + proceso)
if [ -f datos/bot.env ]; then
  set -a
  # shellcheck disable=SC1091
  . datos/bot.env
  set +a
fi
TG_TOKEN="${TELEGRAM_TOKEN:-}"
BOT_PID=$(cat datos/bot.pid 2>/dev/null || true)
vivo datos/bot.pid || BOT_PID=""
if [ -z "$TG_TOKEN" ]; then
  fail "bot getMe" "falta TELEGRAM_TOKEN en datos/bot.env"
else
  CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 15 \
    "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>/dev/null || true)
  if [ "$CODE" = "200" ] && grep -q '"ok":true' "$TMP" && grep -q '"is_bot":true' "$TMP"; then
    # La API responde: no se falla por pidfile ausente (el proceso puede correr
    # fuera de launchd o con otro pid). Si hay pidfile vivo, se informa.
    ok "bot getMe" "http=200 pid=${BOT_PID:-'-'} (api ok)"
  else
    fail "bot getMe" "http=${CODE:-000} $(head -c 160 "$TMP")"
  fi
fi

CC1=$(contar_db 'SELECT COUNT(*) FROM cc;')
USR1=$(contar_db 'SELECT COUNT(*) FROM usuarios;')
if [ "$CC0" = "$CC1" ] && [ "$USR0" = "$USR1" ]; then
  ok "base real sin cambios" "cc=${CC0}->${CC1} usuarios=${USR0}->${USR1}"
else
  fail "base real sin cambios" "cc=${CC0}->${CC1} usuarios=${USR0}->${USR1}"
fi

echo ""
echo "RESUMEN: ${OK} OK / ${FAIL} FAIL / ${SKIP} SKIP"
[ "$FAIL" -eq 0 ] && exit 0
exit 1
