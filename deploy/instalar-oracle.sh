#!/usr/bin/env bash
# instalar-oracle.sh — deja resolver-ar corriendo en una VM Oracle Cloud Free
# (Ubuntu aarch64). Idempotente: se puede correr de nuevo.
#
#   sudo bash deploy/instalar-oracle.sh resolver.tudominio.com
#
# Hace:
#  - instala Docker y Caddy (HTTPS automático)
#  - crea /opt/resolver/datos persistente
#  - levanta el server (server.js) + el bot (bot/telegram.js) con docker compose
#  - Caddy publica 80/443 hacia el server y renueva el certificado solo
#  - systemd units para arranque automático
#
# Si no pasás dominio, usa la IP pública en HTTP (sin HTTPS).
set -euo pipefail

DOMINIO="${1:-}"
APP_DIR="${APP_DIR:-/opt/resolver}"
DATOS="$APP_DIR/datos"
ENV_FILE="$APP_DIR/deploy/.env"

if [ "$(id -u)" -ne 0 ]; then echo "Corré con sudo." >&2; exit 1; fi

echo "== 1/7 paquetes base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git sqlite3 ufw

echo "== 2/7 docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
systemctl enable --now docker

echo "== 3/7 caddy"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "== 4/7 datos persistentes"
mkdir -p "$DATOS"
chmod 750 "$DATOS"

echo "== 5/7 env"
mkdir -p "$APP_DIR/deploy"
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="$(openssl rand -hex 24)"
  cat > "$ENV_FILE" <<EOF
PORT=3001
HOST=0.0.0.0
RESOLVER_TOKEN=$TOKEN
RESOLVER_STOCK_DB=/app/datos/stock.db
RESOLVER_DB=/app/datos/padron.db
TZ=America/Argentina/Buenos_Aires
TELEGRAM_TOKEN=
TELEGRAM_ALLOW=
RESOLVER_URL=http://resolver:3001
EOF
  chmod 600 "$ENV_FILE"
  echo "   RESOLVER_TOKEN generado (guardalo): $TOKEN"
else
  echo "   ya existe $ENV_FILE (no se toca)"
fi

echo "== 6/7 firewall"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 80 >/dev/null 2>&1 || true
ufw allow 443 >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

echo "== 7/7 Caddy"
if [ -n "$DOMINIO" ]; then
  cat > /etc/caddy/Caddyfile <<EOF
$DOMINIO {
	encode gzip
	reverse_proxy 127.0.0.1:3001
}
EOF
else
  IP="$(curl -s --max-time 5 https://api.ipify.org || echo 127.0.0.1)"
  cat > /etc/caddy/Caddyfile <<EOF
http://$IP {
	encode gzip
	reverse_proxy 127.0.0.1:3001
}
EOF
fi
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy

echo ""
echo "LISTO. Ahora:"
echo "  1) cd $APP_DIR && docker compose -f deploy/docker-compose.yml up -d --build"
echo "  2) copiá datos/stock.db (y opcional padron.db) a $DATOS"
echo "  3) si vas a usar el bot: editá TELEGRAM_TOKEN en $ENV_FILE y descomentá el servicio bot"
echo "  4) probá: http://$(hostname -I | awk '{print $1}')/health"
