#!/usr/bin/env bash
# Bootstrap installer for shelly: OSRM-foot service for Finland.
#
# Run via:
#   scp -r deploy/shelly-osrm shelly:/tmp/ && ssh shelly 'bash /tmp/shelly-osrm/install.sh'
#
# It needs the units and osrm-refresh.sh sitting beside it, so it cannot be
# piped in over `bash -s` — stdin leaves BASH_SOURCE unset and they become
# unreachable. Copying the directory keeps them single-sourced from the repo.
#
# Idempotent: safe to rerun, and rerunning is how an image bump in
# osrm-refresh.sh lands. Whenever `current` was not built by the pinned image,
# it runs a refresh, which builds a set with that image, swaps image and data
# together, and smoke-tests. Pass --update-data to rebuild regardless.
set -euo pipefail

# Refuse before anything touches the box. Under `bash -s`, BASH_SOURCE is
# unset and ${BASH_SOURCE[0]} inside $(...) does not abort (set -e is ignored
# for that assignment), so REPO_DIR would be the login cwd.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
for f in osrm-foot.service osrm-refresh.service osrm-refresh.timer osrm-refresh.sh; do
    if [[ ! -f "$REPO_DIR/$f" ]]; then
        echo "[install] ERROR: $f not found next to this script." >&2
        echo "[install] Copy the whole directory over; do not pipe this script into bash." >&2
        exit 1
    fi
done

UPDATE_DATA=0
for arg in "$@"; do
    case "$arg" in
        --update-data) UPDATE_DATA=1 ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

DATA_ROOT=/srv/osrm/finland
TAILSCALE_IP=100.69.160.113

log() { echo "[install] $*"; }

# 1. Docker must be present and running; osrm-backend is a pinned image, not
#    a pacman package (see README.md for why).
if ! command -v docker >/dev/null 2>&1; then
    log "ERROR: docker is not installed" >&2
    exit 1
fi
if ! systemctl is-active --quiet docker; then
    log "starting docker"
    sudo systemctl enable --now docker
fi
sudo pacman -S --needed --noconfirm wget curl >/dev/null

# 2. System user that owns the data (and that the container runs as).
if ! id -u osrm >/dev/null 2>&1; then
    log "creating system user osrm"
    sudo useradd --system --no-create-home --shell /usr/sbin/nologin osrm
else
    log "user osrm already exists"
fi

# 3. Directory tree.
sudo mkdir -p "$DATA_ROOT/pbf" "$DATA_ROOT/processed"
sudo chown osrm:osrm "$DATA_ROOT" "$DATA_ROOT/pbf" "$DATA_ROOT/processed"

# 4. Units and the refresh script. osrm-foot is enabled but not started here:
#    with no stamped set yet it refuses to start, so until the first refresh
#    below succeeds, nothing can (re)start it — an already-running process
#    keeps serving, but a crash or reboot in that window means no OSRM until
#    the build lands. Wander falls back to public OSRM meanwhile.
log "installing osrm-refresh and the systemd units"
sudo install -m 0755 "$REPO_DIR/osrm-refresh.sh" /usr/local/bin/osrm-refresh
for unit in osrm-foot.service osrm-refresh.service osrm-refresh.timer; do
    sudo cp "$REPO_DIR/$unit" "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo systemctl enable osrm-foot.service
sudo systemctl enable --now osrm-refresh.timer

# 5. Build when `current` was not built by the pinned image. Through the unit,
#    not the script directly, so it cannot overlap a timer-started refresh;
#    `start` on a oneshot blocks until it finishes (a Finland build is ~20 min).
if [[ $UPDATE_DATA -eq 1 ]] || ! sudo /usr/local/bin/osrm-refresh --check; then
    log "building a set with the pinned image (follow: journalctl -fu osrm-refresh)"
    if ! sudo systemctl start osrm-refresh.service; then
        log "ERROR — refresh failed; check 'journalctl -u osrm-refresh.service'" >&2
        exit 1
    fi
else
    # Apply a changed osrm-foot.service; the set itself is already current.
    sudo systemctl restart osrm-foot.service
fi

# 6. Smoke test. The set takes a few seconds to load after a restart.
log "smoke-testing OSRM endpoint"
for _ in $(seq 1 30); do
    if curl -fsS "http://$TAILSCALE_IP:5000/route/v1/foot/24.9384,60.1699;24.9405,60.1717?overview=full" 2>/dev/null \
         | grep -q '"code":"Ok"'; then
        log "OK — OSRM-foot is serving routes on $TAILSCALE_IP:5000"
        exit 0
    fi
    sleep 2
done
log "ERROR — smoke test failed; check 'journalctl -u osrm-foot.service'" >&2
exit 1
