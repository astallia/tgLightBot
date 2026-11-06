#!/usr/bin/env bash
# Prepares an Ubuntu server for the bot: Node.js, a dedicated user and a systemd service.
# Run as root from the unpacked bot folder. Safe to run again. Does not start the bot:
# the laptop copy must be stopped first, because Telegram allows only one running copy.
set -euo pipefail

NODE_VERSION=v22.20.0
APP_DIR=/opt/dtek-svet-bot
SERVICE=dtek-svet-bot
APP_USER=svetbot

case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1
fi

id "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"

mkdir -p "$APP_DIR/data"
cp -r package.json package-lock.json src tools assets "$APP_DIR/"
(cd "$APP_DIR" && PATH="/usr/local/bin:$PATH" npm ci --omit=dev --no-audit --no-fund)
chown -R root:root "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/data"

cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=DTEK Svet Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/local/bin/node --env-file=.env src/index.js
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP_DIR/data

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

echo "Node.js $(/usr/local/bin/node --version), folder $APP_DIR, service $SERVICE: ready, not started"
