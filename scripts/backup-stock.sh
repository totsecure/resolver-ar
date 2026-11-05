#!/usr/bin/env bash
# backup-stock.sh — compatibilidad: el backup vive en backup-dbs.sh.
# Se mantiene el nombre para no romper llamadas viejas.
set -uo pipefail
exec bash /Volumes/Boveda/resolver/scripts/backup-dbs.sh --stock "$@"
