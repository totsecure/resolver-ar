#!/usr/bin/env bash
# exportar-datos.sh — empaqueta las DB para migrar a otro host.
#
#   bash scripts/exportar-datos.sh            # stock.db (liviano)
#   bash scripts/exportar-datos.sh --con-padron   # + padron.db (1.4 GB)
#
# Usa `.backup` de SQLite (consistente aunque el server esté corriendo) y deja
# los archivos en dist-migracion/. Nunca copia el WAL crudo.
set -euo pipefail
RAIZ="/Volumes/Boveda/resolver"
DEST="$RAIZ/dist-migracion"
CON_PADRON="${1:-}"

mkdir -p "$DEST"

echo "== backup stock.db"
sqlite3 "$RAIZ/datos/stock.db" ".backup '$DEST/stock.db'"
echo "   $(du -sh "$DEST/stock.db" | awk '{print $1}') $DEST/stock.db"

# Archivos de config necesarios (sin secretos: se cargan a mano en el host).
[ -f "$RAIZ/datos/cobertura.json" ] && cp "$RAIZ/datos/cobertura.json" "$DEST/" || true

if [ "$CON_PADRON" = "--con-padron" ]; then
  echo "== backup padron.db (grande, puede tardar)"
  sqlite3 "$RAIZ/datos/padron.db" ".backup '$DEST/padron.db'"
  echo "   $(du -sh "$DEST/padron.db" | awk '{print $1}') $DEST/padron.db"
fi

echo ""
echo "Listo. Subí con:"
echo "  scp $DEST/stock.db usr@host:/tmp/ && ssh usr@host 'sudo mv /tmp/stock.db /opt/resolver/datos/'"
[ "$CON_PADRON" = "--con-padron" ] && echo "  scp $DEST/padron.db usr@host:/tmp/ && ssh usr@host 'sudo mv /tmp/padron.db /opt/resolver/datos/'"
echo ""
echo "OJO: si corrés el bot en el host, PARÁ el bot en la Mac (mismo token,"
echo "uno solo puede escuchar getUpdates a la vez)."
