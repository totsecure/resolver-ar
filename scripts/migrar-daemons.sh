#!/usr/bin/env bash
# migrar-daemons.sh — pasa los servicios de LaunchAgent (gui/$UID) a
# LaunchDaemon (system). Requiere sudo. IDEMPOTENTE y a prueba de re-ejecución:
#
#   sudo bash scripts/migrar-daemons.sh
#   bash scripts/migrar-daemons.sh --verificar   # solo comprueba, sin root
#
# Reglas de oro (por qué el script viejo dejaba todo abajo):
#   - un bootstrap que falla con EIO (5) NO es un fallo: significa "ya cargado".
#   - nunca se hace bootout en gui hasta confirmar que system quedó sano.
#   - nunca se hace bootout en system antes de bootstrap si ya está sano.
#   - el estado final por servicio es OK / YA CARGADO / FALLA <motivo>.
#
# Los servicios corren como bunker:staff (no root). Los plists viven en
# deploy/daemons/.
set -uo pipefail

RAIZ="/Volumes/Boveda/resolver"
USUARIO="bunker"
UID_USUARIO="${SUDO_UID:-$(id -u)}"
AGENTS="/Users/$USUARIO/Library/LaunchAgents"
DAEMONS="/Library/LaunchDaemons"
SERVICIOS="server tunel bot consultas litestream datasette vigilar"
MODO="${1:-}"
FALLAS=0
LOCK="/tmp/resolver-migrar-daemons.lock"

if [ "$MODO" != "--verificar" ] && [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: requiere sudo (sudo bash scripts/migrar-daemons.sh)" >&2
  exit 1
fi

# Lockfile: no correr dos veces en paralelo (excepto en modo --verificar).
if [ "$MODO" != "--verificar" ]; then
  if ! mkdir "$LOCK" 2>/dev/null; then
    # Si existe pero quedó viejo (>1h) lo reclamamos.
    if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
      rmdir "$LOCK" 2>/dev/null || true
      mkdir "$LOCK" 2>/dev/null || true
    fi
  fi
  if [ ! -d "$LOCK" ]; then
    echo "ERROR: ya hay otra corrida en curso ($LOCK). Si es un resto, borrá ese directorio." >&2
    exit 1
  fi
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
fi

TOKEN="$(sed -n 's/^RESOLVER_TOKEN=//p' "$RAIZ/datos/server.env" 2>/dev/null | head -1 | tr -d '"')"
TG_TOKEN="$(sed -n 's/^TELEGRAM_TOKEN=//p' "$RAIZ/datos/bot.env" 2>/dev/null | head -1 | tr -d '"')"
WORKER="https://resolver-api.correonube.workers.dev"

# ¿Está el label cargado en system?
en_system() { launchctl print "system/ar.resolver.$1" >/dev/null 2>&1; }
# ¿Está el label cargado en gui?
en_gui() { launchctl print "gui/$UID_USUARIO/ar.resolver.$1" >/dev/null 2>&1; }

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

# Salud real de un servicio. Imprime OK/FALLA y devuelve 0/1.
salud() {
  local s="$1" code bp dueno
  case "$s" in
    server)
      code=$(esperar_http "http://127.0.0.1:3001/health?token=${TOKEN}")
      if [ "$code" = "200" ]; then echo "OK server http=200"; return 0; fi
      echo "FALLA server http=$code"; return 1 ;;
    tunel)
      code=$(esperar_http "${WORKER}/health?token=${TOKEN}")
      if [ "$code" = "200" ]; then echo "OK tunel (Worker) http=200"; return 0; fi
      echo "FALLA tunel http=$code"; return 1 ;;
    bot)
      bp="$(cat "$RAIZ/datos/bot.pid" 2>/dev/null || true)"
      if [ -z "$bp" ] || ! kill -0 "$bp" 2>/dev/null; then echo "FALLA bot sin proceso"; return 1; fi
      code=$(esperar_http "https://api.telegram.org/bot${TG_TOKEN:-}/getMe")
      if [ "$code" = "200" ]; then echo "OK bot proceso pid=$bp"; return 0; fi
      echo "FALLA bot token http=$code"; return 1 ;;
    litestream)
      for _ in $(seq 1 15); do
        if launchctl print "system/ar.resolver.litestream" 2>/dev/null | grep -q 'state = running'; then
          echo "OK litestream running"; return 0
        fi
        sleep 1
      done
      echo "FALLA litestream no está running"; return 1 ;;
    datasette)
      code=$(esperar_http "http://127.0.0.1:3003/datasette/stock/cc.json?_size=1" 200 "Authorization: Bearer ${TOKEN}")
      if [ "$code" = "200" ]; then echo "OK datasette http=200"; return 0; fi
      echo "FALLA datasette http=$code"; return 1 ;;
    vigilar)
      if launchctl print "system/ar.resolver.vigilar" 2>/dev/null | grep -q 'state = not running\|last exit code = 0\|state = running'; then
        echo "OK vigilar cargado"; return 0
      fi
      echo "FALLA vigilar no está cargado"; return 1 ;;
    *) echo "FALLA servicio desconocido"; return 1 ;;
  esac
}

# Verificación sin efectos: solo lee.
verificar() {
  local s="$1" out rc
  out=$(salud "$s"); rc=$?
  if [ "$rc" -eq 0 ]; then echo "  $out"; else echo "  $out"; FALLAS=$((FALLAS+1)); fi
  return 0
}

# Instala/arranca UNA vez de forma idempotente el daemon de system.
# Imprime OK / YA CARGADO / FALLA <motivo>. Devuelve 0 si quedó sano.
instalar() {
  local s="$1" plist="$DAEMONS/ar.resolver.$s.plist" base="$RAIZ/deploy/daemons/ar.resolver.$s.plist" out rc
  if [ ! -f "$base" ]; then echo "FALLA falta $base"; FALLAS=$((FALLAS+1)); return 1; fi

  # 1) Si ya está cargado y sano en system: no lo toques.
  if en_system "$s"; then
    out=$(salud "$s"); rc=$?
    if [ "$rc" -eq 0 ]; then echo "YA CARGADO $out"; return 0; fi
    # Está pero no sano: refrescar plist y kickstart una vez.
    cp -f "$base" "$plist"; chown root:wheel "$plist"; chmod 644 "$plist"
    launchctl kickstart -k "system/ar.resolver.$s" >/dev/null 2>&1 || true
    out=$(salud "$s"); rc=$?
    if [ "$rc" -eq 0 ]; then echo "YA CARGADO (relanzado) $out"; return 0; fi
    echo "FALLA $out (ya cargado pero insano)"; FALLAS=$((FALLAS+1)); return 1
  fi

  # 2) No está cargado: instalar plist y bootstrap.
  cp -f "$base" "$plist"
  chown root:wheel "$plist"
  chmod 644 "$plist"
  if launchctl bootstrap system "$plist" 2>/tmp/resolver-bootout-err.$s; then
    out=$(salud "$s"); rc=$?
    if [ "$rc" -eq 0 ]; then echo "$out"; return 0; fi
    echo "FALLA $out"; FALLAS=$((FALLAS+1)); return 1
  fi

  # 3) bootstrap falló. EIO (5/"Input/output error") == ya estaba cargado: no es fallo.
  if grep -qi "Input/output error" /tmp/resolver-bootout-err.$s 2>/dev/null; then
    out=$(salud "$s"); rc=$?
    if [ "$rc" -eq 0 ]; then echo "YA CARGADO $out"; return 0; fi
    echo "FALLA $out"; FALLAS=$((FALLAS+1)); return 1
  fi

  # 4) Fallback: load -w (compatibilidad con el viejo launchctl).
  if launchctl load -w "$plist" >/dev/null 2>&1; then
    out=$(salud "$s"); rc=$?
    if [ "$rc" -eq 0 ]; then echo "$out"; return 0; fi
  fi
  echo "FALLA bootstrap system/ar.resolver.$s: $(cat /tmp/resolver-bootout-err.$s 2>/dev/null | tr '\n' ' ')"
  FALLAS=$((FALLAS+1)); return 1
}

if [ "$MODO" != "--verificar" ]; then
  echo "== migrando a system (idempotente)"
  SANOS=""
  for s in $SERVICIOS; do
    printf '%-11s ' "$s"
    if instalar "$s"; then SANOS="$SANOS $s"; fi
  done

  # Recién ahora, y solo para los que quedaron sanos en system, bajar gui.
  echo ""
  echo "== bajando agentes gui de los servicios ya sanos en system"
  for s in $SANOS; do
    if en_gui "$s"; then
      launchctl bootout "gui/$UID_USUARIO/ar.resolver.$s" >/dev/null 2>&1 || true
    fi
    if [ -f "$AGENTS/ar.resolver.$s.plist" ]; then
      mkdir -p "$RAIZ/_bak"
      mv -f "$AGENTS/ar.resolver.$s.plist" "$RAIZ/_bak/ar.resolver.$s.plist.pre-daemon" || true
    fi
  done
fi

echo ""
echo "== verificación de servicios (system)"
for s in $SERVICIOS; do verificar "$s"; done

echo ""
echo "== dominio gui limpio"
for s in $SERVICIOS; do
  if en_gui "$s"; then
    echo "  FALLA gui/$UID_USUARIO/ar.resolver.$s todavía existe"; FALLAS=$((FALLAS+1))
  else
    echo "  OK gui sin ar.resolver.$s"
  fi
  if [ -f "$AGENTS/ar.resolver.$s.plist" ]; then
    echo "  FALLA plist gui todavía en $AGENTS"; FALLAS=$((FALLAS+1))
  fi
done

echo ""
echo "== ownership de datos"
for f in datos datos/stock.db datos/stock.db-wal datos/padron.db; do
  [ -e "$RAIZ/$f" ] || continue
  dueno="$(stat -f '%Su:%Sg' "$RAIZ/$f")"
  case "$dueno" in
    bunker:*) echo "  OK $f $dueno" ;;
    *) echo "  FALLA $f dueño $dueno (debería ser bunker)"; FALLAS=$((FALLAS+1)) ;;
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
