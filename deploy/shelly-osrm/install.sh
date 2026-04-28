#!/usr/bin/env bash
# Bootstrap installer for shelly: OSRM-foot service for Finland.
# Run via:  ssh shelly 'bash -s' < deploy/shelly-osrm/install.sh
# Idempotent: safe to rerun. Pass --update-data to force a fresh extract.
set -euo pipefail

UPDATE_DATA=0
for arg in "$@"; do
    case "$arg" in
        --update-data) UPDATE_DATA=1 ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_ROOT=/srv/osrm/finland
PBF_DIR=$DATA_ROOT/pbf
PROCESSED_DIR=$DATA_ROOT/processed
GEOFABRIK_URL="https://download.geofabrik.de/europe/finland-latest.osm.pbf"
TAILSCALE_IP=100.69.160.113

log() { echo "[install] $*"; }

# 1. Install osrm-backend (AUR), wget, curl.
if ! command -v osrm-extract >/dev/null 2>&1; then
    log "installing osrm-backend from AUR via yay"
    yay -S --needed --noconfirm osrm-backend
else
    log "osrm-backend already installed"
fi
sudo pacman -S --needed --noconfirm wget curl >/dev/null

# 2. Locate the foot profile (the AUR package may install under different paths).
FOOT_PROFILE=""
for candidate in \
    /usr/share/osrm/profiles/foot.lua \
    /usr/share/osrm-backend/profiles/foot.lua \
    /opt/osrm-backend/profiles/foot.lua; do
    if [[ -f "$candidate" ]]; then FOOT_PROFILE="$candidate"; break; fi
done
if [[ -z "$FOOT_PROFILE" ]]; then
    log "ERROR: foot.lua profile not found in common locations" >&2
    exit 1
fi
log "using profile: $FOOT_PROFILE"

# 3. Verify osrm-routed flag spelling. Recent builds use --ip, older use --host.
if osrm-routed --help 2>&1 | grep -qE '^\s*--ip\b|-i \['; then
    log "osrm-routed supports --ip (expected)"
else
    log "WARNING: osrm-routed does not advertise --ip; check unit's ExecStart manually" >&2
fi

# 4. Create system user.
if ! id -u osrm >/dev/null 2>&1; then
    log "creating system user osrm"
    sudo useradd --system --no-create-home --shell /usr/sbin/nologin osrm
else
    log "user osrm already exists"
fi

# 5. Directory tree.
sudo mkdir -p "$PBF_DIR" "$PROCESSED_DIR"
sudo chown -R osrm:osrm "$DATA_ROOT"

# 6. Download Geofabrik extract (skip if already present and not --update-data).
PBF_FILE=$PBF_DIR/finland-latest.osm.pbf
if [[ ! -f $PBF_FILE || $UPDATE_DATA -eq 1 ]]; then
    log "downloading $GEOFABRIK_URL"
    sudo -u osrm wget -O "$PBF_FILE" "$GEOFABRIK_URL"
else
    log "pbf already present; reuse (pass --update-data to refresh)"
fi

# 7. Preprocess into a fresh timestamped dir if no current symlink yet,
#    or if --update-data was passed.
CURRENT_LINK=$PROCESSED_DIR/current
if [[ ! -L $CURRENT_LINK || $UPDATE_DATA -eq 1 ]]; then
    STAMP=$(date -u +%Y%m%dT%H%M%SZ)
    STAGING=$PROCESSED_DIR/$STAMP
    log "preprocessing into $STAGING"
    sudo -u osrm mkdir -p "$STAGING"
    sudo -u osrm cp "$PBF_FILE" "$STAGING/finland-latest.osm.pbf"
    (
        cd "$STAGING"
        sudo -u osrm osrm-extract -p "$FOOT_PROFILE" finland-latest.osm.pbf
        sudo -u osrm osrm-partition finland-latest.osrm
        sudo -u osrm osrm-customize finland-latest.osrm
    )
    sudo -u osrm ln -sfn "$STAMP" "$CURRENT_LINK"
    log "current → $STAMP"
else
    log "processed/current symlink already present; skipping preprocessing"
fi

# 8. Install systemd units (osrm-foot only here; refresh trio installed by Task 2).
log "installing systemd unit osrm-foot.service"
sudo cp "$REPO_DIR/osrm-foot.service" /etc/systemd/system/osrm-foot.service
if [[ -f $REPO_DIR/osrm-refresh.service ]]; then
    sudo cp "$REPO_DIR/osrm-refresh.service" /etc/systemd/system/osrm-refresh.service
    sudo cp "$REPO_DIR/osrm-refresh.timer"   /etc/systemd/system/osrm-refresh.timer
    sudo install -m 0755 "$REPO_DIR/osrm-refresh.sh" /usr/local/bin/osrm-refresh
fi
sudo systemctl daemon-reload
sudo systemctl enable --now osrm-foot.service
if [[ -f /etc/systemd/system/osrm-refresh.timer ]]; then
    sudo systemctl enable --now osrm-refresh.timer
fi

# 9. Smoke test.
log "smoke-testing OSRM endpoint"
sleep 2
if curl -fsS "http://$TAILSCALE_IP:5000/route/v1/foot/24.9384,60.1699;24.9405,60.1717?overview=full" \
     | grep -q '"code":"Ok"'; then
    log "OK — OSRM-foot is serving routes on $TAILSCALE_IP:5000"
else
    log "ERROR — smoke test failed; check 'journalctl -u osrm-foot.service'" >&2
    exit 1
fi
