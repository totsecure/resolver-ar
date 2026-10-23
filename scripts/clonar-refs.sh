#!/usr/bin/env bash
# clonar-refs.sh — clona en refs/ los repos open-source del handoff, solo para LEER.
# Idempotente: si el repo ya existe, hace fetch y no re-clona.
# Nunca copia node_modules ni instala dependencias de terceros.
#
#   bash scripts/clonar-refs.sh
set -uo pipefail

RAIZ="/Users/bunker/resolver"
DESTINO="$RAIZ/refs"

REPOS=(
  tabler/tabler
  grid-js/gridjs
  sweetalert2/sweetalert2
  apvarun/toastify-js
  chartjs/Chart.js
  jaywcjlove/hotkeys-js
  simonw/datasette
  benbjohnson/litestream
  louislam/uptime-kuma
  microsoft/playwright
  v2board/v2board
  GorvGoyl/Clone-Wars
)

mkdir -p "$DESTINO" || exit 1
cd "$DESTINO" || exit 1

OK=0
FALLA=0

for repo in "${REPOS[@]}"; do
  nombre="${repo##*/}"
  url="https://github.com/${repo}.git"
  if [ -d "$nombre/.git" ]; then
    printf '  ..   %-24s ya existe, fetch\n' "$nombre"
    if git -C "$nombre" fetch --depth 1 origin >/dev/null 2>&1; then
      OK=$((OK + 1))
    else
      printf '  FAIL %-24s fetch\n' "$nombre"
      FALLA=$((FALLA + 1))
    fi
  else
    printf '  ..   %-24s clonando\n' "$nombre"
    if git clone --depth 1 --single-branch "$url" "$nombre" >/dev/null 2>&1; then
      OK=$((OK + 1))
    else
      printf '  FAIL %-24s clone\n' "$nombre"
      FALLA=$((FALLA + 1))
    fi
  fi
done

printf '\n%d OK / %d FAIL en %s\n' "$OK" "$FALLA" "$DESTINO"
[ "$FALLA" -eq 0 ]
