#!/usr/bin/env bash
# Pulls the latest code and restarts GameNest. Restarting clears all rooms (they live in memory):
# run it when nobody is playing.
set -euo pipefail
APP_DIR=/opt/gamenest
APP_USER=gamenest

sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
sudo -u "$APP_USER" env HOME="$APP_DIR" npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund
sudo systemctl restart gamenest
sleep 2
systemctl --no-pager --lines=5 status gamenest
