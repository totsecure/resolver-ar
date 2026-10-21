#!/usr/bin/env bash
# deploy.sh — deploy idempotente en el server (systemd).
# Uso: sudo bash /opt/resolver/deploy/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/resolver}"
SERVICE="${SERVICE:-resolver}"
ENV_FILE="${ENV_FILE:-/etc/resolver.env}"

cd "$APP_DIR"

# Usuario de servicio (idempotente).
if ! id -u resolver >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin resolver
fi

# Código: si es un checkout git, actualizar; si no, seguir con lo que hay.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --ff-only
fi

npm ci --omit=dev

# La DB/caché tiene que ser legible por el usuario del servicio.
chown -R resolver:resolver "$APP_DIR/datos" 2>/dev/null || true
chmod 750 "$APP_DIR/datos" 2>/dev/null || true

# Env file: se crea desde el ejemplo solo si no existe (idempotente).
if [ ! -f "$ENV_FILE" ]; then
  install -m 640 -o root -g resolver deploy/.env.example "$ENV_FILE"
fi

install -m 644 deploy/resolver.service /etc/systemd/system/resolver.service
systemctl daemon-reload
systemctl enable resolver >/dev/null 2>&1 || true
systemctl restart resolver
sleep 1
systemctl is-active --quiet resolver

echo "deploy OK: $SERVICE"
