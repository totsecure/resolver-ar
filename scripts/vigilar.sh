#!/usr/bin/env bash
# vigilar.sh — watchdog de salud cada minuto (cron de root en el VPS; antes launchd en la Mac).
#
# Mide servicios REALES, no pidfiles, y CURA lo que encuentra colgado:
#   1) server local    GET /health?token=            -> 200 + ok:true
#   2) publico (Worker) GET $WORKER_URL/health?token -> 200 + ok:true
#      El Worker pega al VPS por nip.io: la Mac NO esta en ese camino.
#   3) bots           latido del log + cola de updates + MainPID
#
# Un bot COLGADO no muere: sigue vivo y systemd (Restart=always) no lo toca, y
# Telegram tampoco lo nota mientras el socket siga abierto. La senal fiable es
# el latido que los bots escriben cada 30s: si el log enmudece, esta trabado.
# La cola de updates (pending_update_count) cubre el 409, donde el bot pelea y
# reconecta. Cualquiera de las dos cosas reinicia la unit y avisa.
# VIGILAR_REINICIAR=0 desactiva la cura; VIGILAR_SIN_SYSTEMD=1 la saltea (util
# para probar en la Mac, donde no hay esas units).
#
# Alerta por Telegram (scripts/alertar.sh) en la transicion OK->FALLA y avisa
# cuando se recupera. Mientras sigue caido recuerda cada VIGILAR_COOLDOWN seg.
# Estado por chequeo en datos/vigilar-<nombre>.estado. Log: datos/vigilar.log.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_URL="${WORKER_URL:-https://resolver-api.correonube.workers.dev}"
COOLDOWN="${VIGILAR_COOLDOWN:-1800}"
COLA_MAX="${VIGILAR_COLA_MAX:-5}"        # updates pendientes que toleramos
LATIDO_MAX="${VIGILAR_LATIDO_MAX:-180}"  # segundos sin latido antes de curar
REINICIAR="${VIGILAR_REINICIAR:-1}"      # curar colgados con systemctl
SIN_SYSTEMD="${VIGILAR_SIN_SYSTEMD:-0}"  # 1 = no tocar systemctl (probar)
# En la Mac no hay systemctl y los bots viven en el VPS: sin esta deteccion el
# vigilar de la Mac alertaria "bots caidos" cada minuto por mirar units ajenas.
if ! command -v systemctl >/dev/null 2>&1; then
  SIN_SYSTEMD=1
  VIGILAR_BOTS="${VIGILAR_BOTS:-0}"
else
  VIGILAR_BOTS="${VIGILAR_BOTS:-1}"
fi
cd "$RAIZ" || exit 1
mkdir -p datos

[ -f datos/server.env ] && set -a && . datos/server.env && set +a
[ -f datos/bot.env ] && set -a && . datos/bot.env && set +a
TOKEN="${RESOLVER_TOKEN:-}"
PUERTO="${PORT:-3001}"
TG_VENTAS="${TELEGRAM_TOKEN:-}"

# Token del bot de consultas: en el VPS vive en /etc/resolver-consultas.env
# (systemd EnvironmentFile); en la Mac, en datos/consultas.env. Sin ninguno de
# los dos el bot no arranca y el chequeo debe decir por que.
leer_token() { sed -n 's/^TELEGRAM_TOKEN=//p' "$1" 2>/dev/null | head -1 | tr -d '"'; }
TG_CONSULTAS=""
for f in datos/consultas.env datos/bot-consultas.env /etc/resolver-consultas.env; do
  [ -f "$f" ] || continue
  TG_CONSULTAS="$(leer_token "$f")"
  [ -n "$TG_CONSULTAS" ] && break
done

LOG="$RAIZ/datos/vigilar.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
alertar() { bash "$RAIZ/scripts/alertar.sh" "$1" >> "$LOG" 2>&1; }

# mainpid <unit>: PID real segun systemd (no pidfile).
mainpid() { systemctl show -p MainPID --value "$1" 2>/dev/null || echo 0; }

# reiniciar <unit> <motivo>: cura y deja rastro. Nunca rompe el chequeo.
reiniciar() {
  local unit="$1" motivo="$2"
  [ "$REINICIAR" = "1" ] || return 0
  [ "$SIN_SYSTEMD" = "1" ] && return 0
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl restart "$unit" 2>/dev/null && log "CURA: $unit reiniciado ($motivo)" \
    || log "CURA: fallo el restart de $unit ($motivo)"
  return 0
}

revisar() {
  local nombre="$1" ok="$2" detalle="$3"
  local f="$RAIZ/datos/vigilar-${nombre}.estado"
  local previo="" ultimo=0 fallos=0
  if [ -f "$f" ]; then read -r previo ultimo fallos < "$f" || true; fi
  local ahora; ahora="$(date +%s)"
  case "$ultimo" in ''|*[!0-9]*) ultimo=0 ;; esac
  case "$fallos" in ''|*[!0-9]*) fallos=0 ;; esac

  if [ "$ok" = "1" ]; then
    if [ "$previo" = "down" ]; then
      alertar "RECUPERADO: $nombre — $detalle"
      log "$nombre UP (recuperado) $detalle"
    else
      log "$nombre UP $detalle"
    fi
    echo "up $ahora 0" > "$f"
    return 0
  fi

  # Un 404/5xx aislado del Worker (Cloudflare/red) no debe alertar: exigimos
  # VIGILAR_FALLOS (2 por defecto) fallos consecutivos antes de declarar caida.
  fallos=$((fallos + 1))
  local umbral="${VIGILAR_FALLOS:-2}"
  if [ "$fallos" -lt "$umbral" ] && [ "$previo" != "down" ]; then
    log "$nombre DOWN? (1/$umbral) $detalle"
    echo "down $ahora $fallos" > "$f"
    return 0
  fi

  if [ "$previo" != "down" ] || [ $((ahora - ultimo)) -ge "$COOLDOWN" ]; then
    alertar "FALLA: $nombre — $detalle"
    log "$nombre DOWN (alerta) $detalle"
    echo "down $ahora $fallos" > "$f"
  else
    log "$nombre DOWN (cooldown) $detalle"
    echo "down $ultimo $fallos" > "$f"
  fi
}

TMP="$(mktemp -t resolver-vigilar.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

# 1) server local
CODE=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 8 "http://127.0.0.1:${PUERTO}/health?token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '"ok":true' "$TMP"; then
  revisar "local" 1 "http=200"
else
  revisar "local" 0 "http=${CODE:-000} http://127.0.0.1:${PUERTO}/health"
  reiniciar "resolver" "server local http=${CODE:-000}"
fi

# 2) publico a traves del Worker (prueba el camino real del usuario)
CODE=$(curl -sL -o "$TMP" -w '%{http_code}' --max-time 15 "${WORKER_URL}/health?token=${TOKEN}" 2>/dev/null || true)
if [ "$CODE" = "200" ] && grep -q '"ok":true' "$TMP"; then
  revisar "publico" 1 "http=200"
else
  revisar "publico" 0 "http=${CODE:-000} ${WORKER_URL}/health"
fi

# 3) bots: latido del log + cola de updates + MainPID. Cubre los dos.
chequear_bot() {
  local nombre="$1" tok="$2" unit="$3" logb="$RAIZ/datos/$4"
  if [ -z "$tok" ]; then
    revisar "$nombre" 0 "falta TELEGRAM_TOKEN"
    return 0
  fi
  CODE=$(curl -4 -s -o "$TMP" -w '%{http_code}' --max-time 15 \
    "https://api.telegram.org/bot${tok}/getWebhookInfo" 2>/dev/null || true)
  if [ "$CODE" != "200" ] || ! grep -q '"ok":true' "$TMP"; then
    revisar "$nombre" 0 "getWebhookInfo http=${CODE:-000}"
    return 0
  fi
  local cola err pid
  cola="$(sed -n 's/.*"pending_update_count":\([0-9]*\).*/\1/p' "$TMP" | head -1)"
  err="$(sed -n 's/.*"last_error_message":"\([^"]*\)".*/\1/p' "$TMP" | head -1)"
  case "$cola" in ''|*[!0-9]*) cola=0 ;; esac
  pid="$(mainpid "$unit")"
  if [ "$SIN_SYSTEMD" != "1" ] && { [ -z "$pid" ] || [ "$pid" = "0" ]; }; then
    revisar "$nombre" 0 "unit $unit sin proceso (pid=0)"
    reiniciar "$unit" "$nombre sin proceso"
    return 0
  fi

  # Latido: los bots escriben 'latido' cada 30s. Si el log no se refresca en
  # LATIDO_MAX segundos, el proceso esta vivo pero trabado (deadlock); cosa que
  # ni systemd ni Telegram detectan. Es la senal principal de este chequeo.
  local edad=-1
  if [ -f "$logb" ]; then
    local mtime ahora
    mtime="$(stat -c %Y "$logb" 2>/dev/null || stat -f %m "$logb" 2>/dev/null || echo 0)"
    ahora="$(date +%s)"
    [ "$mtime" -gt 0 ] && edad=$((ahora - mtime))
  fi
  if [ "$edad" -ge 0 ] && [ "$edad" -gt "$LATIDO_MAX" ]; then
    revisar "$nombre" 0 "log sin latido hace ${edad}s (>${LATIDO_MAX}s)"
    reiniciar "$unit" "latido viejo (${edad}s)"
    return 0
  fi

  if [ "$cola" -gt "$COLA_MAX" ]; then
    revisar "$nombre" 0 "cola de updates=${cola} (poller trabado${err:+: $err})"
    reiniciar "$unit" "cola=${cola}"
  else
    revisar "$nombre" 1 "pid=${pid:-?} cola=${cola} latido=${edad}s"
  fi
}

# En la Mac (sin systemd) los bots viven en el VPS: el server local se mide,
# pero los bots no. Se marcan como up para no dejar estados "down" colgados.
if [ "$VIGILAR_BOTS" = "1" ]; then
  chequear_bot "bot-ventas"    "$TG_VENTAS"    "resolver-bot"       "bot.log"
  chequear_bot "bot-consultas" "$TG_CONSULTAS" "resolver-consultas" "consultas.log"
else
  for n in bot-ventas bot-consultas; do
    echo "up $(date +%s) 0" > "$RAIZ/datos/vigilar-${n}.estado"
  done
fi

exit 0
