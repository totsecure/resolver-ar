#!/usr/bin/env bash
# e2e.sh — corre la suite Playwright del panel.
#
# El seed y el server los levanta playwright.config.js (webServer ->
# scripts/e2e-server.sh) sobre .e2e/stock.db, en el puerto 3002. Al terminar,
# Playwright baja el server. Devuelve el codigo de salida de la suite.
#
#   bash scripts/e2e.sh
#   bash scripts/e2e.sh --grep "papelera"
set -uo pipefail

RAIZ="/Volumes/Boveda/resolver"
cd "$RAIZ" || exit 1

npx playwright test "$@"
CODIGO=$?
exit "$CODIGO"
