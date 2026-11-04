#!/bin/bash
# bajar-backups-server.sh — trae los backups de stock.db que genera el server
# (VACUUM INTO cada 6 h) al disco Boveda. Idempotente: no rebaja lo que ya está.
#
#   bash scripts/bajar-backups-server.sh
#
# El server guarda 20 copias; acá se retienen 30. Sólo baja stock-*.db, no el padrón.
set -euo pipefail

SERVER="root@179.43.134.10"
LLAVE="${HOME:-/Users/bunker}/.ssh/privlayer_ed25519"
ORIGEN="/opt/resolver/datos/backups/"
DESTINO="/Volumes/Boveda/resolver-backups/server"
RETENER=30

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*"; }

if [ ! -d "$DESTINO" ]; then
  log "AVISO: $DESTINO no existe (¿Boveda desmontada?). Nada que hacer."
  exit 0
fi
if [ ! -f "$LLAVE" ]; then
  log "ERROR: falta la llave $LLAVE"
  exit 1
fi

antes=$(ls -1 "$DESTINO"/stock-*.db 2>/dev/null | wc -l | tr -d ' ')

ok=0
for intento in 1 2 3; do
  if rsync -a --ignore-existing --partial \
    -e "ssh -i $LLAVE -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=15" \
    "$SERVER:$ORIGEN"stock-*.db "$DESTINO/"; then
    ok=1
    break
  fi
  log "rsync falló (intento $intento/3), espero 15 s"
  [ "$intento" -lt 3 ] && sleep 15
done
if [ "$ok" != "1" ]; then
  log "ERROR: rsync falló los 3 intentos (¿server caído o sin red?)"
  exit 1
fi

# Nada corrupto: los archivos que el server generó con VACUUM INTO arrancan con el header de SQLite.
malos=0
for f in "$DESTINO"/stock-*.db; do
  [ -f "$f" ] || continue
  if [ "$(head -c 15 "$f")" != "SQLite format 3" ]; then
    log "CORRUPTO $(basename "$f"): header inválido, lo borro"
    rm -f "$f"
    malos=$((malos + 1))
  fi
done

despues=$(ls -1 "$DESTINO"/stock-*.db 2>/dev/null | wc -l | tr -d ' ')

# Retención: los RETENER más nuevos.
i=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  i=$((i + 1))
  if [ "$i" -gt "$RETENER" ]; then
    rm -f "$f"
    log "podado $(basename "$f")"
  fi
done < <(ls -1t "$DESTINO"/stock-*.db 2>/dev/null)

log "ok: $antes -> $despues copias (corruptas borradas: $malos, retenidas: $RETENER)"
