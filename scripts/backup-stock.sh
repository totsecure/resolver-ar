#!/usr/bin/env bash
# backup-stock.sh — una copia por dia de datos/stock.db.
set -uo pipefail
cd /Users/bunker/resolver || exit 1
HOY="$(date +%Y%m%d)"
mkdir -p datos/backups
[ -f "datos/backups/stock-${HOY}.db" ] && exit 0
node --input-type=module -e "const s=await import('./lib/stock.js');console.log('backup',s.backup())" >> datos/keepalive.log 2>&1
cp -f datos/stock.db "datos/backups/stock-${HOY}.db"
echo "$(date +%Y-%m-%dT%H:%M:%S) backup stock ok" >> datos/keepalive.log
