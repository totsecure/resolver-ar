#!/bin/bash
# Setea la foto de perfil de un bot de Telegram desde la Mac.
# Uso: scripts/set-bot-photo.sh <archivo.jpg> <consultas|ventas>
# El archivo tiene que ser JPG (la API pide InputProfilePhotoStatic en .JPG).
set -euo pipefail
IMG="${1:?falta el jpg}"; Q="${2:?falta consultas|ventas}"
case "$Q" in
  consultas) ENVF=/etc/resolver-consultas.env ;;
  ventas)    ENVF=/etc/resolver-bot.env ;;
  *) echo "uso: $0 <archivo.jpg> <consultas|ventas>"; exit 1 ;;
esac
H=root@179.43.134.10
K="$HOME/.ssh/privlayer_ed25519"
scp -q -i "$K" -o BatchMode=yes "$IMG" "$H:/tmp/_botphoto.jpg"
ssh -i "$K" -o BatchMode=yes "$H" "ENVF=$ENVF bash -s" <<'EOS'
set -e
t=$(sed -n 's/^TELEGRAM_TOKEN=//p' "$ENVF" | tr -d '"')
curl -s --max-time 30 \
  -F 'photo={"type":"static","photo":"attach://f"}' \
  -F 'f=@/tmp/_botphoto.jpg;type=image/jpeg' \
  "https://api.telegram.org/bot$t/setMyProfilePhoto"
echo
EOS
