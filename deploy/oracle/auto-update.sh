#!/usr/bin/env bash
# Keeps /opt/gamenest on the latest origin/master. gamenest-update.timer runs it every 3 minutes.
#   sudo bash auto-update.sh --install   install and start the timer (setup.sh does this)
#   sudo bash auto-update.sh             check once now (what the timer runs)
#   journalctl -u gamenest-update -f     follow what it does
#
# A new master commit is deployed only when:
#   1. `npm test` passes on it, in a scratch copy (nothing checks it before it reaches master);
#      a commit that fails is skipped until master moves again;
#   2. nobody is connected: restarting clears every room (they live in memory). The update waits for
#      players to leave, but at most GAMENEST_MAX_WAIT_H hours (default 6) so a forgotten tab can't
#      block it forever.
# After restarting it checks the server answers, and rolls back to the previous commit if it doesn't.
set -Eeuo pipefail

APP_DIR=/opt/gamenest
APP_USER=gamenest
BRANCH=master
STATE_DIR=/var/lib/gamenest-update
MAX_WAIT_H="${GAMENEST_MAX_WAIT_H:-6}"

log() { echo "[gamenest-update] $*"; }
as_app() { sudo -u "$APP_USER" env HOME="$APP_DIR" "$@"; }
app_git() { as_app git -C "$APP_DIR" "$@"; }

app_port() {
  local p
  p=$(systemctl show gamenest -p Environment --value | grep -o 'PORT=[0-9]*' | cut -d= -f2 || true)
  echo "${p:-3000}"
}

# Open connections to the app (WebSockets of players in a room, plus short-lived HTTP keep-alives from Caddy)
connections() { ss -tnH state established "( sport = :$(app_port) )" | wc -l; }

healthy() {
  local port i
  port=$(app_port)
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null "http://127.0.0.1:$port/" && curl -fs -o /dev/null "http://127.0.0.1:$port/api/room-exists/healthcheck"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Runs the full test suite on a commit in a throwaway copy; the running app is not touched.
# Returns 0 = passed, 1 = tests failed, 2 = could not prepare the copy (network, disk...: retried next run)
test_commit() {
  local sha=$1 tmp rc=0
  tmp=$(mktemp -d /tmp/gamenest-test.XXXXXX)
  chown "$APP_USER:$APP_USER" "$tmp"
  : >"$STATE_DIR/test.log"
  # The app checkout is a shallow clone: a plain clone of it only carries its local branch, so the new
  # commit is fetched explicitly from its remote-tracking ref
  if ! { as_app git clone -q --no-checkout "$APP_DIR" "$tmp/app" &&
         as_app git -C "$tmp/app" fetch -q origin "+refs/remotes/origin/$BRANCH:refs/heads/under-test" &&
         as_app git -C "$tmp/app" checkout -q "$sha" &&
         as_app npm --prefix "$tmp/app" ci --no-audit --no-fund; } >>"$STATE_DIR/test.log" 2>&1; then
    rc=2
  elif ! (cd "$tmp/app" && as_app npm test) >>"$STATE_DIR/test.log" 2>&1; then
    rc=1
  fi
  rm -rf "$tmp"
  return $rc
}

install_npm_deps() { as_app npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund >/dev/null 2>&1; }

deploy() {
  local cur=$1 new=$2
  log "deploying ${cur:0:7} -> ${new:0:7}: $(app_git log -1 --format=%s "$new")"
  app_git reset -q --hard "$new"
  install_npm_deps
  systemctl restart gamenest
  if healthy; then
    log "deployed ${new:0:7}, server is answering"
    rm -f "$STATE_DIR/pending-since"
    return 0
  fi
  log "server did not answer after deploying ${new:0:7}: rolling back to ${cur:0:7}"
  journalctl -u gamenest -n 20 --no-pager || true
  app_git reset -q --hard "$cur"
  install_npm_deps
  systemctl restart gamenest
  echo "$new" >"$STATE_DIR/failed"
  rm -f "$STATE_DIR/pending-since"
  if healthy; then log "rolled back to ${cur:0:7}"; else log "rollback to ${cur:0:7} is not answering either"; fi
  return 1
}

check_once() {
  exec 9>/run/gamenest-update.lock
  if ! flock -n 9; then log "another update run is in progress"; return 0; fi
  mkdir -p "$STATE_DIR"

  app_git fetch -q origin "$BRANCH"
  local cur new
  cur=$(app_git rev-parse HEAD)
  new=$(app_git rev-parse "origin/$BRANCH")
  if [ "$cur" = "$new" ]; then
    rm -f "$STATE_DIR/pending-since"
    return 0
  fi
  if [ "$(cat "$STATE_DIR/failed" 2>/dev/null || true)" = "$new" ]; then
    return 0 # already reported; waits for the next master commit
  fi

  if [ "$(cat "$STATE_DIR/tested" 2>/dev/null || true)" != "$new" ]; then
    log "testing ${new:0:7}: $(app_git log -1 --format=%s "$new")"
    local trc=0
    test_commit "$new" || trc=$?
    if [ "$trc" -eq 2 ]; then
      log "could not prepare a test copy of ${new:0:7}; will retry next run (details: $STATE_DIR/test.log)"
      tail -5 "$STATE_DIR/test.log" || true
      return 1
    fi
    if [ "$trc" -ne 0 ]; then
      echo "$new" >"$STATE_DIR/failed"
      log "tests FAILED on ${new:0:7}; not deploying it (details: $STATE_DIR/test.log)"
      grep -E "^(not ok|✖)|# fail|ℹ fail" "$STATE_DIR/test.log" | head -10 || true
      return 1
    fi
    echo "$new" >"$STATE_DIR/tested"
    log "tests passed on ${new:0:7}"
  fi

  [ -f "$STATE_DIR/pending-since" ] || date +%s >"$STATE_DIR/pending-since"
  local open waited_h
  open=$(connections)
  waited_h=$(( ($(date +%s) - $(cat "$STATE_DIR/pending-since")) / 3600 ))
  if [ "$open" -gt 0 ] && [ "$waited_h" -lt "$MAX_WAIT_H" ]; then
    log "${new:0:7} is ready; waiting: $open open connection(s) (waited ${waited_h}h of ${MAX_WAIT_H}h)"
    return 0
  fi
  if [ "$open" -gt 0 ]; then log "waited ${waited_h}h for players to leave; updating anyway"; fi
  deploy "$cur" "$new"
}

install_timer() {
  tee /etc/systemd/system/gamenest-update.service >/dev/null <<EOF
[Unit]
Description=Update GameNest to the latest $BRANCH (tested, only when nobody is playing)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $APP_DIR/deploy/oracle/auto-update.sh
TimeoutStartSec=20min
EOF
  tee /etc/systemd/system/gamenest-update.timer >/dev/null <<EOF
[Unit]
Description=Check for GameNest updates every 3 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=3min
RandomizedDelaySec=20s

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now gamenest-update.timer
  log "timer installed: $(systemctl list-timers gamenest-update.timer --no-pager --no-legend | awk '{print "next run", $1, $2, $3}')"
}

# Everything runs from main() so bash has parsed the whole file before an update replaces it on disk
main() {
  if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi
  case "${1:-}" in
    --install) install_timer ;;
    "") check_once ;;
    *) echo "usage: sudo bash auto-update.sh [--install]" >&2; exit 1 ;;
  esac
}
main "$@"
exit $?
