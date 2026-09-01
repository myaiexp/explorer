#!/usr/bin/env bash
# Bootstrap installer for shelly: wander-junctions systemd unit + dedicated user.
# Run from the wander checkout on shelly (after git pull), or:
#   ssh shelly 'bash -s' < deploy/install-wander-junctions.sh
# Idempotent: safe to rerun. Does not rebuild junctions-cache (the post-receive
# hook still owns pnpm install + build).
set -euo pipefail

CHECKOUT=/home/shelly/Projects/wander
UNIT_SRC="$CHECKOUT/deploy/wander-junctions.service"
CODE_DIR="$CHECKOUT/junctions-cache"
STATE_DIR=/var/lib/wander-junctions
OLD_CACHE=/home/shelly/.local/state/wander-junctions/cache.json
TAILSCALE_IP=100.69.160.113

log() { echo "[install-wander-junctions] $*"; }

if [[ ! -f $UNIT_SRC ]]; then
    # stdin-fed `bash -s` has no BASH_SOURCE path; require the checkout.
    log "ERROR: $UNIT_SRC not found — run after the shelly checkout is current" >&2
    exit 1
fi

# 1. Dedicated nologin user (finding #7755).
if ! id -u wander-junctions >/dev/null 2>&1; then
    log "creating system user wander-junctions"
    sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin wander-junctions
else
    log "user wander-junctions already exists"
fi

# 2. Persistent cache out of /home/shelly. Copy the old snapshot once so a
#    reinstall does not start cold.
sudo mkdir -p "$STATE_DIR"
if [[ -f $OLD_CACHE && ! -f $STATE_DIR/cache.json ]]; then
    log "migrating cache snapshot from $OLD_CACHE"
    sudo cp -a "$OLD_CACHE" "$STATE_DIR/cache.json"
fi
sudo chown -R wander-junctions:wander-junctions "$STATE_DIR"
sudo chmod 0750 "$STATE_DIR"

# 3. The sandbox bind-mounts the checkout; the files still need to be
#    readable by the service uid (ProtectHome does not rewrite modes).
if [[ -d $CODE_DIR ]]; then
    sudo chmod -R a+rX "$CODE_DIR"
else
    log "WARNING: $CODE_DIR missing — unit will fail until the hook checks it out" >&2
fi

# 4. Install + start the unit.
log "installing systemd unit wander-junctions.service"
sudo cp "$UNIT_SRC" /etc/systemd/system/wander-junctions.service
sudo systemctl daemon-reload
sudo systemctl enable --now wander-junctions.service
sudo systemctl restart wander-junctions.service

# 5. Smoke test.
log "smoke-testing junctions health endpoint"
sleep 2
if curl -fsS "http://$TAILSCALE_IP:5001/health" | grep -q '"ok":true'; then
    log "OK — wander-junctions is serving on $TAILSCALE_IP:5001"
else
    log "ERROR — smoke test failed; check 'journalctl -u wander-junctions.service'" >&2
    exit 1
fi
