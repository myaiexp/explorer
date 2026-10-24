#!/usr/bin/env bash
# Weekly OSRM-foot data refresh: build a fresh Finland set with the pinned
# osrm-backend image, prove that image loads it, stamp it, swap it in, restart,
# smoke-test (rolling back on failure), GC old sets. Runs as root from
# osrm-refresh.service; drops to the osrm user for data work.
#
#   osrm-refresh            refresh now
#   osrm-refresh --check    exit 0 if `current` was built by the pinned image,
#                           3 if not (install.sh uses this to decide a rebuild)
#
# osrm-routed loads only a set built by its own major.minor
# (FingerPrint::IsDataCompatible). So the image is pinned HERE and nowhere
# else: each set records the digest that built it in osrm.env, and
# osrm-foot.service runs whatever image `current`'s stamp names. Bumping IMAGE
# is the whole upgrade — the next refresh builds with it, and image and data
# swap together. See deploy/shelly-osrm/README.md.
set -euo pipefail

# Only -debian variants are published for 26.x on ghcr.
IMAGE=ghcr.io/project-osrm/osrm-backend:v26.10.0-debian

DATA_ROOT=${OSRM_DATA_ROOT:-/srv/osrm/finland}
PBF_DIR=$DATA_ROOT/pbf
PROCESSED_DIR=$DATA_ROOT/processed
CURRENT_LINK=$PROCESSED_DIR/current
# Written as the LAST step of a build. A set without it never finished, or
# predates the stamp; it is never served and never counts toward KEEP.
STAMP_FILE=osrm.env
GEOFABRIK_URL="https://download.geofabrik.de/europe/finland-latest.osm.pbf"
KEEP=2  # finished sets to keep, current included — the other is the rollback
SMOKE_URL="http://100.69.160.113:5000/route/v1/foot/24.9384,60.1699;24.9405,60.1717?overview=false"
# osrm-routed takes a few seconds to load the ~4 GB set after a restart.
SMOKE_TRIES=${OSRM_SMOKE_TRIES:-60}
SMOKE_INTERVAL=${OSRM_SMOKE_INTERVAL:-2}

log() { echo "[refresh] $*"; }
as_osrm() { runuser -u osrm -- "$@"; }

# KEY's value in a set's stamp; empty when the set or the key is absent.
stamp_value() {
    local file=$PROCESSED_DIR/$1/$STAMP_FILE
    [[ -f $file ]] || return 0
    sed -n "s/^$2=//p" "$file" | head -n 1
}
current_set() { readlink "$CURRENT_LINK" 2>/dev/null || true; }

# Atomic: rename(2) over the old link, so a start racing the swap reads either
# the old set or the new one, never a missing `current`.
point_current_at() {
    as_osrm ln -sfn "$1" "$CURRENT_LINK.next"
    as_osrm mv -T "$CURRENT_LINK.next" "$CURRENT_LINK"
}

smoke() {
    local i
    for ((i = 1; i <= SMOKE_TRIES; i++)); do
        if curl -fsS --max-time 5 "$SMOKE_URL" 2>/dev/null | grep -q '"code":"Ok"'; then
            return 0
        fi
        sleep "$SMOKE_INTERVAL"
    done
    return 1
}

case "${1:-}" in
    "") ;;
    --check)
        built_by=$(stamp_value "$(current_set)" OSRM_IMAGE_PIN)
        if [[ -n $(current_set) && $built_by == "$IMAGE" ]]; then
            log "current set was built by $IMAGE"
            exit 0
        fi
        log "current set was built by ${built_by:-an unrecorded binary}; pinned image is $IMAGE"
        exit 3
        ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
esac

# The unit serialises timer and installer runs, but GC deletes every unstamped
# set, so a hand-run alongside one would delete its staging set mid-build.
exec 9>"$DATA_ROOT/.refresh.lock"
if ! flock -n 9; then
    log "ERROR: another refresh is running"
    exit 75
fi

log "pulling $IMAGE"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    # ghcr blob fetches from shelly fail transiently; docker keeps finished layers.
    for attempt in $(seq 1 20); do
        docker pull -q "$IMAGE" >/dev/null && break
        [[ $attempt -lt 20 ]] || { log "ERROR: could not pull $IMAGE"; exit 1; }
        log "pull attempt $attempt failed; retrying"
        sleep 5
    done
fi
# Build, trial-load and stamp by digest, so a tag re-pushed upstream can never
# put a different binary in front of this set.
IMAGE_REF=$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE")
[[ $IMAGE_REF == "${IMAGE%:*}@sha256:"* ]] || { log "ERROR: no digest for $IMAGE ($IMAGE_REF)"; exit 1; }

OSRM_IDS="$(id -u osrm):$(id -g osrm)"
STAGING_PBF=$PBF_DIR/staging.osm.pbf
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGING=$PROCESSED_DIR/$STAMP
osrm_run() {
    docker run --rm --network none --user "$OSRM_IDS" \
        -v "$STAGING:/data" -w /data "$IMAGE_REF" "$@"
}

# Whatever happens, never delete the set `current` points at: with no finished
# set to roll back to, a set that failed its smoke test is still the only one
# the unit can start.
cleanup() {
    rm -f "$STAGING_PBF"
    if [[ $(current_set) != "$STAMP" ]]; then rm -rf "$STAGING"; fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT

log "downloading $GEOFABRIK_URL"
as_osrm wget -q -O "$STAGING_PBF" "$GEOFABRIK_URL"

log "building $STAGING with $IMAGE_REF"
as_osrm mkdir -p "$STAGING"
as_osrm cp "$STAGING_PBF" "$STAGING/finland-latest.osm.pbf"
osrm_run osrm-extract -p /opt/foot.lua finland-latest.osm.pbf
osrm_run osrm-partition finland-latest.osrm
osrm_run osrm-customize finland-latest.osrm

# Same flags osrm-foot.service starts it with, so a set the unit could not
# serve fails here instead of in production. A graph from another major.minor
# fails this load (26.10 on a 26.8 set: exit 8, osrm_fingerprint.meta).
# `--trial=1`, not `--trial`: the bare flag takes an optional value and
# swallows the next word.
log "trial-loading the set with the image that built it"
docker run --rm --network none --user "$OSRM_IDS" \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    -v "$STAGING:/data:ro" "$IMAGE_REF" \
    osrm-routed --algorithm mld --trial=1 /data/finland-latest.osrm

# OSRM_USER: osrm-extract writes .fileIndex 0700, so the set is served as
# its owner — no world-readable fallback user exists.
printf 'OSRM_IMAGE=%s\nOSRM_IMAGE_PIN=%s\nOSRM_SET=%s\nOSRM_USER=%s\n' \
    "$IMAGE_REF" "$IMAGE" "$STAMP" "$OSRM_IDS" \
    | as_osrm tee "$STAGING/$STAMP_FILE.tmp" >/dev/null
as_osrm mv "$STAGING/$STAMP_FILE.tmp" "$STAGING/$STAMP_FILE"

log "promoting staging pbf"
as_osrm mv "$STAGING_PBF" "$PBF_DIR/finland-latest.osm.pbf"

PREVIOUS=$(current_set)
log "swapping current → $STAMP"
point_current_at "$STAMP"

if ! { systemctl restart osrm-foot.service && smoke; }; then
    if [[ -n $PREVIOUS && -n $(stamp_value "$PREVIOUS" OSRM_IMAGE) ]]; then
        log "ERROR: osrm-foot did not answer on $STAMP; rolling back to $PREVIOUS"
        point_current_at "$PREVIOUS"
        systemctl restart osrm-foot.service
    else
        log "ERROR: osrm-foot did not answer on $STAMP, and no finished set to roll back to"
    fi
    exit 1
fi

log "garbage-collecting processed sets (keep $KEEP finished, current included)"
CURRENT=$(current_set)
kept=0
while IFS= read -r d; do
    if [[ $d == "$CURRENT" ]] || { [[ -f $PROCESSED_DIR/$d/$STAMP_FILE ]] && ((kept < KEEP - 1)); }; then
        [[ $d == "$CURRENT" ]] || kept=$((kept + 1))
        continue
    fi
    log "  removing $PROCESSED_DIR/$d"
    rm -rf "${PROCESSED_DIR:?}/$d"
done < <(find "$PROCESSED_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)

log "done."
