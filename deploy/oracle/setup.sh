#!/usr/bin/env bash
# One-time setup of GameNest on an Oracle Cloud (or any) Ubuntu 22.04/24.04 VM, x86 or ARM.
#   curl -fsSL https://raw.githubusercontent.com/yiyang2001/GameNest/master/deploy/oracle/setup.sh -o setup.sh
#   bash setup.sh play.example.com
# Installs Node.js 22, runs server.js as a systemd service on 127.0.0.1:3000 behind Caddy, which serves
# the domain over HTTPS (certificate issued and renewed automatically). Safe to run again.
# Works on a VM that already runs other sites: an existing Caddyfile is kept (GameNest is added through
# an import), and the script stops before changing anything if its ports are taken by other programs.
# Another app port: GAMENEST_PORT=3100 bash setup.sh play.example.com
set -euo pipefail

DOMAIN="${1:?usage: bash setup.sh <domain> [git-repo-url]}"
REPO="${2:-https://github.com/yiyang2001/GameNest.git}"
APP_DIR=/opt/gamenest
APP_USER=gamenest
PORT="${GAMENEST_PORT:-3000}"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
# sudo drops exported variables, so they go on the command line. NEEDRESTART_MODE=a: Ubuntu 22.04's
# needrestart would otherwise stop and ask which services to restart.
apt_get() { sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get "$@"; }
# Names of the processes listening on a TCP port (empty when free)
port_owner() { sudo ss -ltnpH "sport = :$1" | grep -o 'users:(("[^"]*"' | cut -d'"' -f2 | sort -u | tr '\n' ' '; }

log "Checking ports before changing anything"
owner=$(port_owner "$PORT")
if [ -n "$owner" ] && ! systemctl is-active --quiet gamenest; then
  die "port $PORT is already used by: $owner. Pick another one: GAMENEST_PORT=3100 bash setup.sh $DOMAIN"
fi
for p in 80 443; do
  owner=$(port_owner "$p")
  if [ -n "$owner" ] && [ "$owner" != "caddy " ]; then
    die "port $p is used by: $owner. This script serves HTTPS with Caddy; stop that web server or add GameNest to its config by hand (proxy $DOMAIN to 127.0.0.1:$PORT, WebSockets included)."
  fi
done
echo "ok: app port $PORT is free, 80/443 are free or already Caddy's"

log "System packages"
apt_get update -y
apt_get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

log "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a bash -
  apt_get install -y nodejs
fi
node --version

log "Caddy (HTTPS reverse proxy)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt_get update -y
  apt_get install -y caddy
fi

log "App user and code in $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 || sudo useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
else
  sudo mkdir -p "$APP_DIR"
  sudo chown "$APP_USER:$APP_USER" "$APP_DIR"
  sudo -u "$APP_USER" git clone --depth 1 "$REPO" "$APP_DIR"
fi
sudo -u "$APP_USER" env HOME="$APP_DIR" npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund

log "systemd service"
sudo tee /etc/systemd/system/gamenest.service >/dev/null <<EOF
[Unit]
Description=GameNest game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable gamenest
sudo systemctl restart gamenest

log "Caddy site for $DOMAIN"
# GameNest gets its own file; the main Caddyfile only imports it, so sites already configured on this
# VM are left alone. Caddy proxies WebSockets as-is and sets X-Forwarded-Proto (used by the QR join link).
CADDYFILE=/etc/caddy/Caddyfile
SITE_FILE=/etc/caddy/gamenest.caddy
IMPORT_LINE="import $SITE_FILE"
sudo tee "$SITE_FILE" >/dev/null <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}
EOF
backup=""
if [ -f "$CADDYFILE" ]; then
  backup="$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"
  sudo cp "$CADDYFILE" "$backup"
fi
if [ ! -f "$CADDYFILE" ] || sudo grep -q 'root \* /usr/share/caddy' "$CADDYFILE"; then
  # missing, or still the package's placeholder site on :80 (it would clash with the HTTPS redirect)
  echo "$IMPORT_LINE" | sudo tee "$CADDYFILE" >/dev/null
elif ! sudo grep -qxF "$IMPORT_LINE" "$CADDYFILE"; then
  printf '\n%s\n' "$IMPORT_LINE" | sudo tee -a "$CADDYFILE" >/dev/null
fi
if ! sudo caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
  [ -n "$backup" ] && sudo cp "$backup" "$CADDYFILE"
  sudo rm -f "$SITE_FILE"
  tail -5 /tmp/caddy-validate.log >&2
  die "the Caddy config did not validate (is $DOMAIN already configured in $CADDYFILE?). Restored the previous Caddyfile."
fi
[ -n "$backup" ] && echo "previous Caddyfile saved as $backup"
sudo systemctl enable caddy
sudo systemctl reload caddy || sudo systemctl restart caddy

log "Firewall: open 80/443 on the VM"
# Oracle's Ubuntu images end the INPUT chain with a REJECT rule: the ACCEPT rules must go above it.
# The app port stays closed; only Caddy is exposed.
for p in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null; then
    line=$(sudo iptables -L INPUT --line-numbers -n | awk '/REJECT/ {print $1; exit}')
    if [ -n "$line" ]; then
      sudo iptables -I INPUT "$line" -p tcp --dport "$p" -m state --state NEW -j ACCEPT
    else
      sudo iptables -A INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT
    fi
  fi
done
sudo netfilter-persistent save

log "Check"
for i in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  sleep 1
done
if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "GameNest is running on 127.0.0.1:$PORT"
else
  echo "GameNest did not answer; see: sudo journalctl -u gamenest -n 50" >&2
  exit 1
fi
cat <<EOF

Done. Remaining steps outside this VM (see deploy/README.md):
  1. Oracle console: allow TCP 80 and 443 in the VCN security list (or network security group).
  2. DNS: point $DOMAIN (A record) at this VM's public IP.
Then open https://$DOMAIN — Caddy gets the certificate on the first visit after DNS resolves.
Logs: sudo journalctl -u gamenest -f     Update later: bash $APP_DIR/deploy/oracle/update.sh
EOF
