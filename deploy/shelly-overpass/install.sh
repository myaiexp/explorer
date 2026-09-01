#!/usr/bin/env bash
# Bootstrap installer for shelly: self-hosted Overpass API over the Finland extract.
#
# Run via:
#   scp -r deploy/shelly-overpass shelly:/tmp/ && ssh shelly 'bash /tmp/shelly-overpass/install.sh'
#
# It needs wander-overpass.service sitting beside it, so it cannot be piped in
# over `bash -s` — stdin leaves BASH_SOURCE unset and the unit unreachable.
# Copying the directory keeps the unit single-sourced from the repo.
#
# Idempotent: safe to rerun.
#
# Returns as soon as the unit is up. The initial import (pbf download, osmium
# pbf→bz2 conversion, index build) runs for HOURS inside the container — this
# script deliberately does not block on it. junctions-cache's public-Overpass
# fallback covers that window, so there is no user-visible downtime.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [[ ! -f "$REPO_DIR/wander-overpass.service" ]]; then
    echo "[install] ERROR: wander-overpass.service not found next to this script." >&2
    echo "[install] Copy the whole directory over; do not pipe this script into bash." >&2
    exit 1
fi
IMAGE=wiktorn/overpass-api:v0.7.62.11
DB_DIR=/srv/overpass/db
PORT=5002

log() { echo "[install] $*"; }

# 1. Docker must be present and running; this unit is a container, not a binary.
if ! command -v docker >/dev/null 2>&1; then
    log "ERROR: docker is not installed" >&2
    exit 1
fi
if ! systemctl is-active --quiet docker; then
    log "starting docker"
    sudo systemctl enable --now docker
fi

# 2. Pre-pull the pinned image. shelly's registry path is intermittent (transient
#    CloudFront failures on blob fetches), and docker keeps completed layers, so
#    retry rather than letting the unit's first start be the thing that fails.
if sudo docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "image $IMAGE already present"
else
    log "pulling $IMAGE (retrying through transient registry failures)"
    pulled=0
    for attempt in $(seq 1 40); do
        if sudo docker pull "$IMAGE"; then pulled=1; break; fi
        log "pull attempt $attempt failed; retrying"
        sleep 5
    done
    if [[ $pulled -ne 1 ]]; then
        log "ERROR: could not pull $IMAGE after 40 attempts" >&2
        exit 1
    fi
fi

# 3. Data directory, alongside /srv/osrm.
sudo mkdir -p "$DB_DIR"

# 4. Install and start the unit.
log "installing systemd unit wander-overpass.service"
sudo cp "$REPO_DIR/wander-overpass.service" /etc/systemd/system/wander-overpass.service
sudo systemctl daemon-reload
sudo systemctl enable --now wander-overpass.service

# 5. Smoke test the unit, NOT the import. An interpreter query only answers once
#    the import completes, which is hours away on a first run.
sleep 3
if systemctl is-active --quiet wander-overpass.service; then
    log "OK — wander-overpass.service is active"
else
    log "ERROR — unit failed to start; check 'journalctl -u wander-overpass.service'" >&2
    exit 1
fi

log "import is running in the background. Watch it with:"
log "  journalctl -fu wander-overpass.service"
log "It is done when this answers with an osm3s timestamp:"
log "  curl -s 'http://127.0.0.1:$PORT/api/interpreter?data=[out:json];node(1);out;'"
