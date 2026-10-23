#!/usr/bin/env bash
# migrar-daemons.sh — pasa los 5 servicios de LaunchAgent (gui/$UID) a
# LaunchDaemon (system). Requiere sudo. Idempotente.
#
#   sudo bash scripts/migrar-daemons.sh
#
# Los servicios corren como bunker:staff (no root). Los plists nuevos están en
# deploy/daemons/. Los viejos se guardan en _bak/.
set -uo pipefail

RAIZ="/Users/bunker/resolver"
USUARIO="bunker"
UID_USUARIO="${SUDO_UID:-501}"
AGENTS="/Users/$USUARIO/Library/LaunchAgents"
DAEMONS="/Library/LaunchDaemons"
SERVICIOS="server tunel litestream datasette vigilar"
FALLAS=0

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: requiere sudo (sudo bash scripts/migrar-daemons.sh)" >&2
  exit 1
fi

TOKEN="$(sed -n 's/^RESOLVER_TOKEN=//p' "$RAIZ/datos/server.env" 2>/dev/null | head -1 | tr -d '\"')"

verificar() {
  local s="$1" code
  case "$s" in
    server)
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:3001/health?token=${TOKEN}")
      [ "$code" = "200" ] && echo "  OK server http=200" || { echo "  FAIL server http=$code"; FALLAS=$((FALLAS+1)); } ;;
    tunel)
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://resolver-api.correonube.workers.dev/health?token=${TOKEN}")
      [ "$code" = "200" ] && echo "  OK tunel (Worker) http=200" || { echo "  FAIL tunel http=$code"; FALLAS=$((FALLAS+1)); } ;;
    litestream)
      sleep 2
      if launchctl print "system/ar.resolver.litestream" 2>/dev/null | grep -q 'state = running'; then
        echo "  OK litestream running"
      else
        echo "  FAIL litestream no está running"; FALLAS=$((FALLAS+1))
      fi ;;
    datasette)
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:3003/datasette/stock/cc.json?_size=1")
      [ "$code" = "200" ] && echo "  OK datasette http=200" || { echo "  FAIL datasette http=$code"; FALLAS=$((FALLAS+1)); } ;;
    vigilar)
      launchctl kickstart -k "system/ar.resolver.vigilar" >/dev/null 2>&1
      sleep 2
      if launchctl print "system/ar.resolver.vigilar" 2>/dev/null | grep -q 'last exit code = 0'; then
        echo "  OK vigilar corrió (exit 0)"
      else
        echo "  WARN vigilar sin exit 0 todavía (revisar datos/vigilar.log)"
      fi ;;
  esac
}

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

echo ""
echo "== ownership"
for f in datos datos/stock.db datos/stock.db-wal datos/padron.db; do
  [ -e "$RAIZ/$f" ] || continue
  dueno="$(stat -f '%Su:%Sg' "$RAIZ/$f")"
  if [ "$dueno" = "bunker:staff" ] || [ "$dueno" = "bunker:wheel" ]; then
    echo "  OK $f $dueno"
  else
    echo "  FAIL $f dueño $dueno (debería ser bunker)"; FALLAS=$((FALLAS+1))
  fi
done
echo ""
echo "== launchctl"
launchctl list | grep -i resolver || true
echo ""
if [ "$FALLAS" -eq 0 ]; then
  echo "MIGRACIÓN OK. Probar: kill -9 <pid> y esperar que launchd lo relance."
  exit 0
fi
echo "MIGRACIÓN CON $FALLAS FALLA(S)" >&2
exit "$FALLAS"
