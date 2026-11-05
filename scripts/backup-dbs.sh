#!/usr/bin/env bash
# backup-dbs.sh — backups consistentes de stock.db y padron.db.
#
#   stock.db  : diario  (7 copias) + semanal (4 copias)
#   padron.db : semanal (4 copias; 1.4 GB -> ~550 MB gzip)
#
#   bash scripts/backup-dbs.sh              # lo que toque según el día
#   bash scripts/backup-dbs.sh --stock      # fuerza copia diaria de stock
#   bash scripts/backup-dbs.sh --padron     # fuerza copia semanal de padrón
#   bash scripts/backup-dbs.sh --semanal    # fuerza las dos semanales
#
# Cada copia se hace con `sqlite3 .backup` (consistente con WAL), se valida con
# `PRAGMA quick_check` ANTES de comprimir y, si falla, se aborta sin publicar
# una copia rota. Destino local: datos/backups/. Remoto: $BACKUP_REMOTO.
set -uo pipefail

RAIZ="/Volumes/Boveda/resolver"
LOG="$RAIZ/datos/backup.log"
LOCAL="$RAIZ/datos/backups"
BASE_REMOTO="${BACKUP_REMOTO_BASE:-/Volumes/Boveda}"
REMOTO="${BACKUP_REMOTO:-$BASE_REMOTO/resolver-backups}"
TS="$(date +%Y%m%d-%H%M%S)"
HOY="$(date +%Y%m%d)"
SEMANA="$(date +%G%V)"
DOW="$(date +%u)"
FALLAS=0
FORZAR_PADRON=0
FORZAR_STOCK=0
FORZAR_SEMANAL=0
for arg in "$@"; do
  case "$arg" in
    --padron) FORZAR_PADRON=1 ;;
    --stock) FORZAR_STOCK=1 ;;
    --semanal) FORZAR_SEMANAL=1 ;;
  esac
done

cd "$RAIZ" || exit 1
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
alertar() { bash "$RAIZ/scripts/alertar.sh" "$1" >> "$LOG" 2>&1 || true; }

# 1) Exigir el disco externo ANTES de tocar nada.
if [ "${BACKUP_REMOTO_SIN_MONTAJE:-0}" != "1" ]; then
  if [ ! -d "$BASE_REMOTO" ] || ! mount | grep -F " on $BASE_REMOTO " >/dev/null 2>&1; then
    echo "ERROR: disco externo NO montado: $BASE_REMOTO — no se hizo ningún backup." >&2
    log "ABORTO disco externo no montado ($BASE_REMOTO)"
    alertar "Backup falló: disco externo no montado ($BASE_REMOTO)."
    exit 2
  fi
fi
if ! mkdir -p "$REMOTO" 2>/dev/null || ! touch "$REMOTO/.resolver-backup-test" 2>/dev/null; then
  echo "ERROR: destino remoto no escribible: $REMOTO" >&2
  log "ABORTO destino remoto no escribible ($REMOTO)"
  alertar "Backup falló: destino remoto no escribible ($REMOTO)."
  exit 3
fi
rm -f "$REMOTO/.resolver-backup-test"
mkdir -p "$LOCAL"

# Evita dos corridas simultáneas (launchd + manual).
LOCK="$RAIZ/datos/.backup-lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "ERROR: ya hay un backup en curso ($LOCK)" >&2
  exit 4
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# 2) Una copia: .backup -> quick_check -> gzip -> remoto.
respaldar() {
  local db="$1" nombre="$2"
  local tmp="$LOCAL/${nombre}-${TS}.db"
  local gz="${tmp}.gz"

  if [ ! -f "$db" ]; then
    log "ERROR no existe $db"
    FALLAS=$((FALLAS + 1))
    return 1
  fi

  rm -f "$tmp" "$gz"
  if ! sqlite3 "$db" <<SQL
.timeout 30000
.backup '$tmp'
SQL
  then
    log "ERROR .backup falló para $db"
    FALLAS=$((FALLAS + 1))
    return 1
  fi

  local check
  check="$(sqlite3 "$tmp" 'PRAGMA quick_check;' 2>&1 | head -1)"
  if [ "$check" != "ok" ]; then
    log "ABORTO quick_check $db => $check"
    rm -f "$tmp" "${tmp}-wal" "${tmp}-shm"
    alertar "Backup ABORTADO: quick_check falló en $nombre ($check)."
    exit 5
  fi

  if ! nice -n 10 gzip -6 "$tmp"; then
    log "ERROR gzip $tmp"
    FALLAS=$((FALLAS + 1))
    return 1
  fi
  rm -f "${tmp}-wal" "${tmp}-shm"

  if ! cp -f "$gz" "$REMOTO/"; then
    log "ERROR copia remota $gz -> $REMOTO"
    FALLAS=$((FALLAS + 1))
    return 1
  fi

  local bytes
  bytes="$(stat -f '%z' "$gz" 2>/dev/null || echo 0)"
  log "OK $nombre $gz (${bytes} bytes) -> $REMOTO/$(basename "$gz")"
}

# 3) Stock: una copia diaria.
if [ "$FORZAR_STOCK" = "1" ]; then
  log "stock diario FORZADO por --stock"
  respaldar "$RAIZ/datos/stock.db" "stock"
elif [ -n "$(ls -1 "$LOCAL"/stock-${HOY}-*.db.gz 2>/dev/null | head -1)" ]; then
  log "stock diario omitido: ya hay copia de hoy"
else
  respaldar "$RAIZ/datos/stock.db" "stock"
fi

# 4) Stock semanal: domingo, si no hay copia de esta semana, o forzada.
if [ "$FORZAR_SEMANAL" = "1" ] || [ -z "$(ls -1 "$LOCAL"/stock-semanal-${SEMANA}-*.db.gz 2>/dev/null | head -1)" ]; then
  if [ "$FORZAR_SEMANAL" != "1" ] && [ "$DOW" != "7" ]; then
    log "stock semanal pendiente: hoy no es domingo (semana $SEMANA)"
  else
    respaldar "$RAIZ/datos/stock.db" "stock-semanal-${SEMANA}"
  fi
else
  log "stock semanal omitido: ya hay copia de esta semana ($SEMANA)"
fi

# 5) Padrón: semanal (1.4 GB; no cambia seguido).
if [ "$FORZAR_PADRON" = "1" ] || [ "$FORZAR_SEMANAL" = "1" ]; then
  respaldar "$RAIZ/datos/padron.db" "padron-semanal-${SEMANA}"
elif [ -n "$(ls -1 "$LOCAL"/padron-semanal-${SEMANA}-*.db.gz 2>/dev/null | head -1)" ]; then
  log "padron semanal omitido: ya hay copia de esta semana ($SEMANA)"
elif [ "$DOW" = "7" ]; then
  respaldar "$RAIZ/datos/padron.db" "padron-semanal-${SEMANA}"
elif [ -z "$(find "$LOCAL" -maxdepth 1 -type f -name 'padron-semanal-*.db.gz' -mtime -7 2>/dev/null | head -1)" ]; then
  respaldar "$RAIZ/datos/padron.db" "padron-semanal-${SEMANA}"
else
  log "padron semanal omitido: próxima copia el domingo"
fi

# 6) Retención: 7 diarios de stock + 4 semanales de cada base.
podar() {
  local dir="$1" prefijo="$2" keep="$3"
  [ -d "$dir" ] || return 0
  ls -1t "$dir"/${prefijo}*.db.gz 2>/dev/null \
    | tail -n +$((keep + 1)) \
    | while IFS= read -r f; do [ -n "$f" ] && rm -f "$f"; done
  find "$dir" -maxdepth 1 -type f \( -name "${prefijo}*.db-wal" -o -name "${prefijo}*.db-shm" \) -delete 2>/dev/null
}
podar "$LOCAL" "stock-2" 7
podar "$REMOTO" "stock-2" 7
podar "$LOCAL" "stock-semanal-" 4
podar "$REMOTO" "stock-semanal-" 4
podar "$LOCAL" "padron-semanal-" 4
podar "$REMOTO" "padron-semanal-" 4
# LEGACY: padron-YYYYMMDD-HHMMSS.db.gz (dumps manuales previos)
podar "$LOCAL" "padron-2" 4
podar "$REMOTO" "padron-2" 4

# _bak/ no crece para siempre: se conservan 90 días.
BAK_BORRADOS=0
if [ -d "$RAIZ/_bak" ]; then
  BAK_BORRADOS=$(find "$RAIZ/_bak" -type f -mtime +90 2>/dev/null | wc -l | tr -d ' ')
  find "$RAIZ/_bak" -type f -mtime +90 -delete 2>/dev/null || true
fi
log "_bak: $BAK_BORRADOS archivo(s) >90 días eliminados"

log "fin fallas=$FALLAS remoto=$REMOTO"
if [ "$FALLAS" -eq 0 ]; then
  echo "BACKUP OK: local=$LOCAL remoto=$REMOTO"
  exit 0
fi
echo "BACKUP CON FALLAS: $FALLAS (ver $LOG)" >&2
alertar "Backup falló ($FALLAS error/es). Ver $LOG."
exit "$FALLAS"
