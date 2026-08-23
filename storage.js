// localStorage accessors — the array-backed collections (visits, saved
// locations, favorites, history), their storage keys, and a quota-aware writer.
// Writes funnel through safeSetItem: on a full-quota QuotaExceededError it frees
// space by trimming route geometry from old visits (the cloud still stores full
// rows; GET /:username returns them only for the newest GET_GEOMETRY_KEEP) and
// retries, surfacing a toast instead of silently dropping a walk.
// Otherwise DOM-free and network-free; the toast is a guarded globalThis lookup
// so unit tests (and pre-toast load order) simply skip it.

const VISITS_KEY = 'walk_visits';
const SAVED_LOCATIONS_KEY = 'walk_saved_locations';
const FAVORITES_KEY = 'walk_favorites';
const HISTORY_KEY = 'walk_history';

// Newest N visits keep their full outbound/return polylines; older ones are
// trimmed to metadata-only when localStorage runs out of room. Twin of server
// GET_GEOMETRY_KEEP: the cloud still STORES full rows (the archive), but GET
// /:username returns geometry only for the newest N so the init-path merge
// stays bounded (`?geometry=full` returns them under the server's 8 MiB
// snapshot cap, otherwise 413). 50 keeps recent routes drawable — the
// routeCoords/returnRouteCoords arrays are the only large fields.
// tests/geometry-keep-parity.test.js fails RED if these drift.
const VISIT_GEOMETRY_KEEP = 50;
const QUOTA_TRIMMED_MSG = 'Storage was full — trimmed old route details to make room. Turn on cloud backup to keep full history.';
const QUOTA_FULL_MSG = 'Storage is full. Export & delete old walks, or turn on cloud backup.';

// Parse a JSON array from localStorage, returning [] on missing/corrupt data.
// Shared by every array-backed accessor so the parse-or-default contract lives
// in exactly one place.
function readStoredArray(key) {
    try {
        return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
        return [];
    }
}

// Serialize an array back to localStorage — the write-side counterpart to
// readStoredArray, so the JSON.stringify/setItem pairing lives in one place.
// The cloud-mirror half (ExplorerSync.mutate) stays in syncedPut/
// syncedDelete, which wrap this — storage.js itself does no network. Returns
// true on a durable write, false when quota was exhausted and couldn't be
// reclaimed (hard failure is also toasted). Callers that also mirror to the
// cloud outbox (syncedPut/syncedDelete, applyImportedVisits) MUST gate the
// mirror on this return — a false must not become a mutate.
function writeStoredArray(key, arr) {
    return safeSetItem(key, JSON.stringify(arr));
}

// A DOMException whose name/legacy code signals the localStorage quota is full.
// Match by name and legacy code (Firefox/Safari differ) rather than instanceof,
// so a test double with the right name is recognized too.
function isQuotaError(e) {
    return !!e && (
        e.name === 'QuotaExceededError' ||
        e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        e.code === 22 || e.code === 1014
    );
}

// Strip routeCoords/returnRouteCoords from every visit except the newest
// VISIT_GEOMETRY_KEEP (by ISO date, which sorts lexicographically). Mutates the
// array in place; returns true if it actually cleared any geometry. Sorting by
// date rather than array position matters because a cloud sync-merge rebuilds the
// array in unspecified order, so "recent" can't be read off position.
function stripOldVisitGeometry(visits) {
    if (!Array.isArray(visits) || visits.length <= VISIT_GEOMETRY_KEEP) return false;
    const newestIds = new Set(
        [...visits]
            .sort((a, b) => String((b && b.date) || '').localeCompare(String((a && a.date) || '')))
            .slice(0, VISIT_GEOMETRY_KEEP)
            .map(v => v && v.id)
    );
    let changed = false;
    for (const v of visits) {
        if (v && !newestIds.has(v.id) && (v.routeCoords || v.returnRouteCoords)) {
            v.routeCoords = null;
            v.returnRouteCoords = null;
            changed = true;
        }
    }
    return changed;
}

// Compact a stringified visits array before re-writing it — used when the write
// that overflowed quota IS the visits collection. Returns the slimmed JSON, or
// null if there was nothing to trim (or it wouldn't parse).
function compactVisitsBlob(value) {
    let visits;
    try { visits = JSON.parse(value); } catch { return null; }
    if (!stripOldVisitGeometry(visits)) return null;
    return JSON.stringify(visits);
}

// Free quota for an unrelated write (e.g. the sync outbox) by shrinking the
// separately-persisted visits collection. Writes the slimmed array back directly
// — NOT via the synced path — so the local trim never propagates to the cloud
// backup, which stores full geometry (GET /:username returns it only for the
// newest GET_GEOMETRY_KEEP). Returns true if it freed anything.
function reclaimVisitGeometry() {
    const visits = readStoredArray(VISITS_KEY);
    if (!stripOldVisitGeometry(visits)) return false;
    try {
        localStorage.setItem(VISITS_KEY, JSON.stringify(visits));
        return true;
    } catch {
        return false;
    }
}

// Guarded toast — storage.js owns no DOM and toast.js may not be loaded (unit
// tests, or before the deferred toast.js script runs), so resolve the helper off
// globalThis at call time and no-op if it isn't there.
function notifyStorage(level, message) {
    const fn = level === 'error' ? globalThis.showError : globalThis.showWarning;
    if (typeof fn === 'function') fn(message);
}

// Write to localStorage, recovering from a full quota instead of throwing an
// uncaught QuotaExceededError (which used to silently drop new walks). On quota,
// free space by trimming old visit geometry — compacting the value itself when
// the write is the visits array, else shrinking the persisted visits — and retry
// once. A hard failure surfaces a toast and returns false rather than losing the
// write silently. Non-quota errors propagate.
function safeSetItem(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        if (!isQuotaError(e)) throw e;

        let retryValue = value;
        let reclaimed;
        if (key === VISITS_KEY) {
            const compacted = compactVisitsBlob(value);
            reclaimed = compacted !== null;
            if (reclaimed) retryValue = compacted;
        } else {
            reclaimed = reclaimVisitGeometry();
        }

        if (reclaimed) {
            try {
                localStorage.setItem(key, retryValue);
                notifyStorage('warning', QUOTA_TRIMMED_MSG);
                return true;
            } catch (e2) {
                if (!isQuotaError(e2)) throw e2;
            }
        }
        notifyStorage('error', QUOTA_FULL_MSG);
        return false;
    }
}

function getVisits() {
    return readStoredArray(VISITS_KEY);
}

function getSavedLocations() {
    return readStoredArray(SAVED_LOCATIONS_KEY);
}

function getFavorites() {
    return readStoredArray(FAVORITES_KEY);
}

function getHistory() {
    return readStoredArray(HISTORY_KEY);
}

globalThis.VISITS_KEY = VISITS_KEY;
globalThis.SAVED_LOCATIONS_KEY = SAVED_LOCATIONS_KEY;
globalThis.FAVORITES_KEY = FAVORITES_KEY;
globalThis.HISTORY_KEY = HISTORY_KEY;
globalThis.readStoredArray = readStoredArray;
globalThis.writeStoredArray = writeStoredArray;
globalThis.getVisits = getVisits;
globalThis.getSavedLocations = getSavedLocations;
globalThis.getFavorites = getFavorites;
globalThis.getHistory = getHistory;
