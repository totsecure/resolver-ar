#!/usr/bin/env bash
# migrar-daemons.sh — pasa los 5 servicios de LaunchAgent (gui/$UID) a
# LaunchDaemon (system). Requiere sudo. Idempotente.
#
#   sudo bash scripts/migrar-daemons.sh
#   bash scripts/migrar-daemons.sh --verificar   # solo comprueba, sin root
#
# Los servicios corren como bunker:staff (no root). Los plists están en
# deploy/daemons/. Los viejos se guardan en _bak/.
set -uo pipefail

RAIZ="/Users/bunker/resolver"
USUARIO="bunker"
UID_USUARIO="${SUDO_UID:-$(id -u)}"
AGENTS="/Users/$USUARIO/Library/LaunchAgents"
DAEMONS="/Library/LaunchDaemons"
SERVICIOS="server tunel litestream datasette vigilar"
MODO="${1:-}"
FALLAS=0

if [ "$MODO" != "--verificar" ] && [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: requiere sudo (sudo bash scripts/migrar-daemons.sh)" >&2
  exit 1
fi

TOKEN="$(sed -n 's/^RESOLVER_TOKEN=//p' "$RAIZ/datos/server.env" 2>/dev/null | head -1 | tr -d '"')"
WORKER="https://resolver-api.correonube.workers.dev"

# Espera hasta 30 s (1 s entre intentos) a que una URL devuelva el código.
esperar_http() {
  local url="$1" esperado="${2:-200}" header="${3:-}" code="000"
  for _ in $(seq 1 30); do
    if [ -n "$header" ]; then
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "$header" "$url" 2>/dev/null || true)
    else
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)
    fi
    [ "$code" = "$esperado" ] && { echo "$code"; return 0; }
    sleep 1
  done
  echo "${code:-000}"
  return 1
}

verificar() {
  local s="$1" code
  case "$s" in
    server)
      code=$(esperar_http "http://127.0.0.1:3001/health?token=${TOKEN}")
      [ "$code" = "200" ] && echo "  OK server http=200" || { echo "  FAIL server http=$code"; FALLAS=$((FALLAS+1)); } ;;
    tunel)
      code=$(esperar_http "${WORKER}/health?token=${TOKEN}")
      [ "$code" = "200" ] && echo "  OK tunel (Worker) http=200" || { echo "  FAIL tunel http=$code"; FALLAS=$((FALLAS+1)); } ;;
    litestream)
      local ok=0
      for _ in $(seq 1 15); do
        if launchctl print "system/ar.resolver.litestream" 2>/dev/null | grep -q 'state = running'; then ok=1; break; fi
        sleep 1
      done
      [ "$ok" = "1" ] && echo "  OK litestream running" || { echo "  FAIL litestream no está running"; FALLAS=$((FALLAS+1)); } ;;
    datasette)
      code=$(esperar_http "http://127.0.0.1:3003/datasette/stock/cc.json?_size=1" 200 "Authorization: Bearer ${TOKEN}")
      [ "$code" = "200" ] && echo "  OK datasette http=200" || { echo "  FAIL datasette http=$code"; FALLAS=$((FALLAS+1)); } ;;
    vigilar)
      if [ "$MODO" != "--verificar" ]; then
        launchctl kickstart -k "system/ar.resolver.vigilar" >/dev/null 2>&1 || true
        sleep 2
      fi
      if launchctl print "system/ar.resolver.vigilar" 2>/dev/null | grep -q 'state = not running\|last exit code = 0\|state = running'; then
        echo "  OK vigilar cargado"
      else
        echo "  FAIL vigilar no está cargado"; FALLAS=$((FALLAS+1))
      fi ;;
  esac
}

if [ "$MODO" != "--verificar" ]; then
  for s in $SERVICIOS; do
    echo "== $s"
    # 1) bajar el agente de usuario (evita dos instancias y conflictos de puerto)
    launchctl bootout "gui/$UID_USUARIO/ar.resolver.$s" 2>/dev/null || true
    if [ -f "$AGENTS/ar.resolver.$s.plist" ]; then
      mv -f "$AGENTS/ar.resolver.$s.plist" "$RAIZ/_bak/ar.resolver.$s.plist.pre-daemon" || true
    fi

    # 2) instalar el daemon del sistema
    if [ ! -f "$RAIZ/deploy/daemons/ar.resolver.$s.plist" ]; then
      echo "  ERROR falta deploy/daemons/ar.resolver.$s.plist"; FALLAS=$((FALLAS+1)); continue
    fi
    cp -f "$RAIZ/deploy/daemons/ar.resolver.$s.plist" "$DAEMONS/ar.resolver.$s.plist"
    chown root:wheel "$DAEMONS/ar.resolver.$s.plist"
    chmod 644 "$DAEMONS/ar.resolver.$s.plist"

    launchctl bootout "system/ar.resolver.$s" 2>/dev/null || true
    if launchctl bootstrap system "$DAEMONS/ar.resolver.$s.plist"; then
      verificar "$s"
    else
      echo "  FAIL bootstrap system/ar.resolver.$s"; FALLAS=$((FALLAS+1))
    fi
  done
fi

echo ""
echo "== verificación de servicios (system)"
for s in $SERVICIOS; do verificar "$s"; done

echo ""
echo "== dominio gui sin agentes de los 5 servicios"
for s in $SERVICIOS; do
  if launchctl print "gui/$UID_USUARIO/ar.resolver.$s" >/dev/null 2>&1; then
    echo "  FAIL gui/$UID_USUARIO/ar.resolver.$s todavía existe"; FALLAS=$((FALLAS+1))
  else
    echo "  OK gui sin ar.resolver.$s"
  fi
  if [ -f "$AGENTS/ar.resolver.$s.plist" ]; then
    echo "  FAIL plist gui todavía en $AGENTS"; FALLAS=$((FALLAS+1))
  fi
done

echo ""
echo "== ownership"
for f in datos datos/stock.db datos/stock.db-wal datos/padron.db; do
  [ -e "$RAIZ/$f" ] || continue
  dueno="$(stat -f '%Su:%Sg' "$RAIZ/$f")"
  case "$dueno" in
    bunker:*) echo "  OK $f $dueno" ;;
    *) echo "  FAIL $f dueño $dueno (debería ser bunker)"; FALLAS=$((FALLAS+1)) ;;
  esac
done

echo ""
echo "== procesos"
lsof -nP -iTCP:3001 -sTCP:LISTEN 2>/dev/null | tail -n +2 || true
pgrep -fl 'ngrok http' || true
echo ""
if [ "$FALLAS" -eq 0 ]; then
  echo "VERIFICACIÓN OK (0 fallas)"
  exit 0
fi
echo "VERIFICACIÓN CON $FALLAS FALLA(S)" >&2
exit "$FALLAS"
