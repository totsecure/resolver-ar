#!/bin/bash
# backup-stock-server.sh — backup de stock.db en el server pl1.
# Versión Linux del respaldo: no usa sqlite3 (no está instalado), usa node:sqlite.
# Pensado para cron cada 6 h:
#   0 */6 * * * /opt/resolver/scripts/backup-stock-server.sh >> /var/log/resolver-backup.log 2>&1
# VACUUM INTO es consistente con la base viva y no bloquea a la API.
set -euo pipefail
NODE=/opt/delta-node/bin/node
DEST=/opt/resolver/datos/backups
FUENTE=/opt/resolver/datos/stock.db
RETENER=20
mkdir -p "$DEST"
TS=$(date -u +%Y%m%d-%H%M%S)
SALIDA="$DEST/stock-$TS.db"

"$NODE" -e '
const { DatabaseSync } = require("node:sqlite");
const [fuente, salida] = process.argv.slice(1);
const db = new DatabaseSync(fuente, { readOnly: true });
db.exec("VACUUM INTO \x27" + salida + "\x27");
db.close();
' "$FUENTE" "$SALIDA"

# Verificación: si la copia no pasa integridad, se borra y el script falla.
OK=$("$NODE" -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const r = db.prepare("PRAGMA integrity_check").get().integrity_check;
const n = db.prepare("select count(*) c from cc").get().c;
db.close();
process.stdout.write(r + " cc=" + n);
' "$SALIDA")

echo "$(date -u +%FT%TZ) backup stock: $SALIDA $OK"
case "$OK" in
  ok*) ;;
  *) echo "FALLO la integridad de $SALIDA, la borro"; rm -f "$SALIDA"; exit 1 ;;
esac

# Retención: se conservan las RETENER copias más nuevas.
ls -1t "$DEST"/stock-*.db 2>/dev/null | tail -n +$((RETENER + 1)) | while read -r viejo; do
  echo "borro backup viejo: $viejo"
  rm -f "$viejo"
done
