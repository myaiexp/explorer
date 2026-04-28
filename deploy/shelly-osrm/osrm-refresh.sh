#!/usr/bin/env bash
# Weekly OSRM-foot data refresh: download fresh Finland extract, preprocess,
# atomically swap symlink, restart service, GC old sets. Runs as root from
# osrm-refresh.service; drops to the osrm user via runuser for data work.
set -euo pipefail

DATA_ROOT=/srv/osrm/finland
PBF_DIR=$DATA_ROOT/pbf
PROCESSED_DIR=$DATA_ROOT/processed
GEOFABRIK_URL="https://download.geofabrik.de/europe/finland-latest.osm.pbf"
KEEP=2  # keep this many timestamped processed sets (incl. the new one)

log() { echo "[refresh] $*"; }

# Locate foot.lua at runtime — same probe order as install.sh.
FOOT_PROFILE=""
for candidate in \
    /usr/share/osrm/profiles/foot.lua \
    /usr/share/osrm-backend/profiles/foot.lua \
    /opt/osrm-backend/profiles/foot.lua; do
    if [[ -f "$candidate" ]]; then FOOT_PROFILE="$candidate"; break; fi
done
[[ -n "$FOOT_PROFILE" ]] || { log "ERROR: foot.lua not found"; exit 1; }

# Run as root, drop to osrm for data work.
as_osrm() { runuser -u osrm -- "$@"; }

STAGING_PBF=$PBF_DIR/staging.osm.pbf
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGING=$PROCESSED_DIR/$STAMP

cleanup_failure() {
    log "preprocessing failed; cleaning $STAGING and $STAGING_PBF"
    rm -rf "$STAGING" "$STAGING_PBF" 2>/dev/null || true
}

log "downloading $GEOFABRIK_URL"
as_osrm wget -q -O "$STAGING_PBF" "$GEOFABRIK_URL" || { cleanup_failure; exit 1; }

log "preprocessing into $STAGING"
as_osrm mkdir -p "$STAGING"
as_osrm cp "$STAGING_PBF" "$STAGING/finland-latest.osm.pbf"
trap cleanup_failure ERR
(
    cd "$STAGING"
    as_osrm osrm-extract   -p "$FOOT_PROFILE" finland-latest.osm.pbf
    as_osrm osrm-partition finland-latest.osrm
    as_osrm osrm-customize finland-latest.osrm
)
trap - ERR

log "promoting staging pbf"
as_osrm mv "$STAGING_PBF" "$PBF_DIR/finland-latest.osm.pbf"

log "swapping current → $STAMP"
as_osrm ln -sfn "$STAMP" "$PROCESSED_DIR/current"

log "restarting osrm-foot.service"
systemctl restart osrm-foot.service

log "garbage-collecting old processed sets (keep newest $KEEP)"
mapfile -t old < <(
    find "$PROCESSED_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
        | sort -r | tail -n +$((KEEP + 1))
)
for d in "${old[@]:-}"; do
    [[ -n "$d" ]] || continue
    log "  removing $PROCESSED_DIR/$d"
    rm -rf "$PROCESSED_DIR/$d"
done

log "done."
