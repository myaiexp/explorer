// Visit-row shape rules — what a usable visit looks like, owned in one place.

// Two consumers, one rule set: importVisits (visits-io.js) gates an untrusted
// backup file through normalizeVisit before anything is persisted, and
// renderVisitedLayer (map-view.js) asks visitRenderParts what it can safely draw
// for a row that is ALREADY in storage. Sharing the rules is what guarantees a
// row that survives import can always be rendered — the two used to disagree
// (import accepted anything array-shaped, render dereferenced fields blind), and
// a single bad row aborted app.js's top-level init on every later page load.
// Pure: no DOM, no network, no storage — depends on nothing, so it only has to be
// loaded before its consumers (map-view.js, then visits-io.js).

// Mirrors the backup server's caps (server/src/lib/route-coords.ts and
// validate-fields.ts) so a normalized row is one the API will accept — an
// imported row that reaches the cloud outbox must not come back a silent 400.
const MAX_ROUTE_COORDS = 5000;
const MAX_LABEL_LEN = 500;   // startLabel, tripMode, poiCategory
const MAX_NAME_LEN = 2000;   // destName
const MAX_DATE_LEN = 40;

// Finite number, else null. Numeric strings are accepted: hand-portable backup
// files (and older exports) occasionally carry coords as strings, and dropping a
// whole walk over "62.1" would be data loss the user can't undo.
function finiteNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

// Coordinates must be in real range, not merely finite — Leaflet happily draws a
// marker at lat 500, so an out-of-range value would silently pollute the overlay
// (and the cloud backup) instead of being caught here.
function latOrNull(v) {
    const n = finiteNum(v);
    return n !== null && n >= -90 && n <= 90 ? n : null;
}

function lngOrNull(v) {
    const n = finiteNum(v);
    return n !== null && n >= -180 && n <= 180 ? n : null;
}

// An [lat, lng] pair list, else null. One malformed pair invalidates the whole
// polyline rather than being filtered out: a partially-dropped route draws a
// straight line through terrain the walk never crossed, which reads as real data
// and is worse than drawing nothing.
function coordPairsOrNull(v) {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_ROUTE_COORDS) return null;
    const pairs = [];
    for (const pair of v) {
        if (!Array.isArray(pair) || pair.length !== 2) return null;
        const lat = latOrNull(pair[0]);
        const lng = lngOrNull(pair[1]);
        if (lat === null || lng === null) return null;
        pairs.push([lat, lng]);
    }
    return pairs;
}

// Non-empty string truncated to the server's column cap, else null. Truncating
// beats rejecting: an over-long label is cosmetic, losing the walk is not.
function stringOrNull(v, max) {
    if (typeof v !== 'string' || v === '') return null;
    return v.length > max ? v.slice(0, max) : v;
}

// A usable row id, else null for the caller to back-fill with a fresh UUID.
//
// Ids we mint are crypto.randomUUID(); legacy exports carry numeric ids, which
// stringify. Anything else is rejected rather than repaired, because an id is not
// just a local key — it becomes a path segment in an authenticated cloud-backup
// write (sync-flush.js), and it is a primary-key column server-side. sync.js's
// apiPath percent-encodes it, so a stray '/' can no longer redirect the request,
// but dot-segments survive encoding intact ('..' encodes to '..') and would still
// be normalized away by the browser — so the charset check is what closes that,
// with the encoding as defence in depth.
//
// Dropping the id costs the file's own dedupe for that row (re-importing it mints
// a second UUID and so duplicates the walk); keeping the walk is worth that, and
// only a hand-edited file ever gets here.
const MAX_ID_LEN = 128;
const SAFE_ID = /^[A-Za-z0-9._~-]+$/;

function idOrNull(v) {
    let s = null;
    if (typeof v === 'string' && v !== '') s = v;
    else if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
    if (s === null || s.length > MAX_ID_LEN) return null;
    if (!SAFE_ID.test(s)) return null;
    if (/^\.+$/.test(s)) return null;   // '.', '..' — path segments, not ids
    return s;
}

// An ISO-8601 timestamp the backup server's isIsoDate accepts, else null.
function isoDateOrNull(v) {
    if (typeof v !== 'string' || v.length > MAX_DATE_LEN) return null;
    if (!/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(Date.parse(v))) return null;
    return v;
}

// Normalize one untrusted visit row, or null when it is beyond repair.
//
// Required: a start and a destination inside real lat/lng range plus a
// non-negative finite distance — without those there is no walk to place on the
// map. Everything else is repaired instead of rejected (a missing or garbage date
// becomes `nowIso`, malformed geometry becomes null, over-long labels truncate),
// because legacy and hand-edited files are an expected input here.
//
// The emitted shape is exactly snapshotSession's (session.js) plus poiCategory —
// a fixed key set, so junk fields in the file never reach localStorage (quota is
// finite; see storage.js) or the cloud row.
//
// `id` is passed through when it has a usable shape (a numeric legacy id is
// stringified; see idOrNull) or left null for the caller to back-fill, keeping
// this free of crypto/uuid concerns.
function normalizeVisit(row, nowIso = new Date().toISOString()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;

    const startLat = latOrNull(row.startLat);
    const startLng = lngOrNull(row.startLng);
    const destLat = latOrNull(row.destLat);
    const destLng = lngOrNull(row.destLng);
    const distance = finiteNum(row.distance);
    if (startLat === null || startLng === null ||
        destLat === null || destLng === null ||
        distance === null || distance < 0) return null;

    return {
        id: idOrNull(row.id),
        date: isoDateOrNull(row.date) || nowIso,
        startLat,
        startLng,
        startLabel: stringOrNull(row.startLabel, MAX_LABEL_LEN),
        destLat,
        destLng,
        destName: stringOrNull(row.destName, MAX_NAME_LEN),
        tripMode: stringOrNull(row.tripMode, MAX_LABEL_LEN),
        distance,
        routeCoords: coordPairsOrNull(row.routeCoords),
        routeDistance: finiteNum(row.routeDistance),
        routeDuration: finiteNum(row.routeDuration),
        returnRouteCoords: coordPairsOrNull(row.returnRouteCoords),
        returnRouteDistance: finiteNum(row.returnRouteDistance),
        returnRouteDuration: finiteNum(row.returnRouteDuration),
        poiCategory: stringOrNull(row.poiCategory, MAX_LABEL_LEN),
    };
}

// What renderVisitedLayer can safely draw for a row already in storage — rows
// written before import validation existed, or merged down from an older cloud
// backup, are not normalized. Returns null when there is nothing to place (no
// usable start/dest), else the drawable pieces, each independently nullable so
// one bad field degrades that piece instead of throwing mid-overlay.
function visitRenderParts(visit) {
    if (!visit || typeof visit !== 'object') return null;

    const startLat = latOrNull(visit.startLat);
    const startLng = lngOrNull(visit.startLng);
    const destLat = latOrNull(visit.destLat);
    const destLng = lngOrNull(visit.destLng);
    if (startLat === null || startLng === null || destLat === null || destLng === null) return null;

    const distance = finiteNum(visit.distance);
    const date = isoDateOrNull(visit.date);
    return {
        start: [startLat, startLng],
        dest: [destLat, destLng],
        routeCoords: coordPairsOrNull(visit.routeCoords),
        returnRouteCoords: coordPairsOrNull(visit.returnRouteCoords),
        // Popup text: empty string, never undefined — the popups concatenate these.
        startLabel: typeof visit.startLabel === 'string' ? visit.startLabel : '',
        distanceText: distance === null ? '' : `${distance.toFixed(1)} km`,
        dateText: date === null ? '' : new Date(date).toLocaleDateString(),
    };
}

globalThis.normalizeVisit = normalizeVisit;
globalThis.visitRenderParts = visitRenderParts;
