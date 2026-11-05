#!/bin/bash
# Apaga y deshabilita los daemons de resolver en la Mac: produccion vive en el VPS.
# Se corre como root (una sola vez). Reversible con: launchctl enable system/<label>
set -u
echo "== apagando y deshabilitando (dominio system) =="
for L in bot server tunel vigilar datasette litestream; do
  launchctl bootout "system/ar.resolver.$L" 2>/dev/null && EST="descartado" || EST="(no estaba)"
  launchctl disable "system/ar.resolver.$L" 2>/dev/null && DIS="deshabilitado" || DIS="(ya estaba)"
  echo "  ar.resolver.$L: $EST, $DIS"
done
echo "== estado persistente =="
launchctl print-disabled system | grep -E "ar\.resolver\." || echo "  (vacio)"
echo "== procesos de resolver que sigan vivos =="
ps -eo pid,command | grep -Ei "node server\.js|telegram\.js|litestream|datasette|ngrok http|vigilar\.sh" | grep -v grep || echo "  ninguno"
