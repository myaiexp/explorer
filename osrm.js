// OSRM transport — self-hosted OSRM-foot route / nearest / table wrappers, the
// self-hosted-down latch and the paced public fallback, and road snapping.
// No DOM. Loaded after net.js (for fetchWithTimeout) and geo-utils.js
// (haversineKm), before route-dispatch.js and app.js.

// Self-hosted OSRM-foot for Finland.
const OSRM_FI_BASE    = 'https://mase.fi/api/osrm-fi/route/v1/foot';
const OSRM_FI_NEAREST = 'https://mase.fi/api/osrm-fi/nearest/v1/foot';
const OSRM_FI_TABLE   = 'https://mase.fi/api/osrm-fi/table/v1/foot';

// Public fallback while shelly (self-hosted) is down. FOSSGIS's routing.openstreetmap.de
// is a free community service under a ~1 req/sec fair-use cap — every request
// here MUST go through throttlePublic below so the pacing can't be bypassed.
const OSRM_PUBLIC_BASE    = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';
const OSRM_PUBLIC_NEAREST = 'https://routing.openstreetmap.de/routed-foot/nearest/v1/foot';
const OSRM_PUBLIC_TABLE   = 'https://routing.openstreetmap.de/routed-foot/table/v1/foot';

// How long a self-hosted failure keeps us off shelly before we probe it again.
const SELF_HOSTED_RETRY_MS = 5 * 60 * 1000;
// Minimum spacing between consecutive requests to the public fallback.
const PUBLIC_MIN_GAP_MS = 1100;

// A tiny local sleep backs the public-fallback throttle. NOT named `sleep`:
// these are classic scripts sharing one global scope, so a bare `sleep` here
// would silently redefine any other file's.
// tests/global-collisions.test.js is the enforcement.
function throttleSleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ── Self-hosted-down latch + public-fallback throttle ──────────────────────
//
// Module-scoped mutable state. This is safe because withLoading (loading.js)
// is a one-build-at-a-time mutex: the entry points that can trigger a route
// build (Enter, Ctrl+Enter, surprise, pick-on-map, the spread slider) all go
// through it, so at most one build — and therefore at most one chain of OSRM
// calls — is ever in flight. There is no concurrent build to race this state
// against.
let selfHostedDownUntil = 0;   // Date.now() ms; 0 means "not latched"
let publicQueue = Promise.resolve(); // serializes every public request
let lastPublicRequestAt = 0;

// True while we're skipping self-hosted OSRM entirely and going straight to
// the public fallback.
function isSelfHostedDown() {
    return Date.now() < selfHostedDownUntil;
}

// Latch self-hosted as down for SELF_HOSTED_RETRY_MS. A timeout, a network
// error, or an HTTP failure that is not an OSRM answer (5xx, or a 4xx whose
// body is not an OSRM code). A business code — NoRoute, NoTable, NoSegment,
// including the HTTP 400 osrm-routed actually returns — is the engine
// answering about this destination and must not latch.
function markSelfHostedDown() {
    selfHostedDownUntil = Date.now() + SELF_HOSTED_RETRY_MS;
}

// Test seam: clears the latch and the throttle queue so tests don't leak
// module state into each other (osrm.js is loaded once per test file).
function resetOsrmFallbackState() {
    selfHostedDownUntil = 0;
    publicQueue = Promise.resolve();
    lastPublicRequestAt = 0;
}

// Run `fn` (a public-fallback fetch) after waiting for both (a) every
// previously-queued public request to finish and (b) at least
// PUBLIC_MIN_GAP_MS since the last one actually started. This is the only
// path any caller has to OSRM_PUBLIC_* — composing those URLs and fetching
// them directly instead would bypass the fair-use pacing.
function throttlePublic(fn) {
    const run = publicQueue.then(async () => {
        const wait = lastPublicRequestAt + PUBLIC_MIN_GAP_MS - Date.now();
        if (wait > 0) await throttleSleep(wait);
        lastPublicRequestAt = Date.now();
        return fn();
    });
    // Keep the queue alive even if this attempt rejects, so a later request
    // still waits its turn instead of the queue wedging on a rejected promise.
    publicQueue = run.then(() => {}, () => {});
    return run;
}

// Pure: turns a parsed OSRM /route response into our route shape, or null if
// there's no usable route. Never throws — a malformed-but-parseable body
// (missing routes/geometry) is a business outcome, not a fetch failure.
function parseRouteResponse(data) {
    if (!data.routes || data.routes.length === 0) return null;
    const r = data.routes[0];
    const coords = r.geometry && r.geometry.coordinates;
    // Missing or empty geometry is a failed route, not a 0-length walk.
    if (!Array.isArray(coords) || coords.length === 0) return null;
    const steps = r.legs ? r.legs.flatMap(leg => leg.steps || []) : null;
    // UNITS: `distance` is METRES and `duration` seconds, straight off OSRM.
    // Every route object this module returns keeps those units; session.js is
    // the boundary that converts distance to km for the session/persisted
    // fields, and route-restore.js converts back.
    return {
        coords: coords.map(([lng, lat]) => [lat, lng]),
        duration: r.duration,
        distance: r.distance,
        steps: steps
    };
}

// json() on a non-JSON body (an HTML 400 from a proxy) is not an OSRM code.
async function readOsrmJson(res) {
    try { return await res.json(); } catch { return null; }
}

// An OSRM code other than Ok is the engine answering. 5xx is never that,
// even with a body, and a 4xx without a code string is a transport failure.
function osrmBusinessError(status, data) {
    if (!data || typeof data.code !== 'string' || data.code === 'Ok') return false;
    if (status >= 500) return false;
    if (status >= 400) return true;
    return status >= 200 && status < 300;
}

// One fetch against one base. A business code throws with osrmBusiness set so
// the fallback below can tell "the engine answered" from "the engine is down".
// `label` is part of the error text callers and tests already match.
async function fetchOsrm(base, suffix, parse, label) {
    const res = await fetchWithTimeout(`${base}/${suffix}`);
    const data = await readOsrmJson(res);
    if (osrmBusinessError(res.status, data)) {
        const err = new Error(`${label} ${data.code}`);
        err.osrmBusiness = true;
        throw err;
    }
    if (!res.ok) throw new Error(`${label} http ${res.status}`);
    return parse(data);
}

// Self-hosted first, public only when self-hosted is unreachable. `swallow`
// is true for route and nearest (a failed public attempt is null — there is
// nowhere further to fall back) and false for table (screening has to see
// a total outage as a throw). A business code never latches and never asks
// public: swallowing it returns null, otherwise it is rethrown as-is.
async function withOsrmFallback(selfBase, publicBase, suffix, parse, swallow, label) {
    const once = (base) => fetchOsrm(base, suffix, parse, label);
    const viaPublic = () => throttlePublic(() => once(publicBase).catch((err) => {
        if (swallow) return null;
        throw err;
    }));
    if (!isSelfHostedDown()) {
        try {
            return await once(selfBase);
        } catch (err) {
            if (err && err.osrmBusiness) {
                if (swallow) return null;
                throw err;
            }
            markSelfHostedDown();
            return viaPublic();
        }
    }
    return viaPublic();
}

// `suffix` is the path+query AFTER the /route/v1/foot/ base — this function
// (not the caller) decides which base to compose it onto. Returns the parsed
// route, or null.
function tryOsrm(suffix) {
    return withOsrmFallback(OSRM_FI_BASE, OSRM_PUBLIC_BASE, suffix, parseRouteResponse, true, 'osrm');
}

// Route through an ordered list of {lat,lng} waypoints. Returns {coords, duration, distance, steps} or null.
async function fetchRouteThrough(waypoints) {
    const coordStr = waypoints.map(p => `${p.lng},${p.lat}`).join(';');
    const query = `${coordStr}?overview=full&geometries=geojson&steps=true&continue_straight=true`;
    return tryOsrm(query);
}

// Pure: turns a parsed OSRM /nearest response into {lat,lng}, or null.
function parseNearestResponse(data) {
    if (!data.waypoints || !data.waypoints.length) return null;
    return { lat: data.waypoints[0].location[1], lng: data.waypoints[0].location[0] };
}

// OSRM /nearest. `suffix` is the path+query after /nearest/v1/foot/.
// Returns {lat, lng} or null on any failure.
function tryNearest(suffix) {
    return withOsrmFallback(
        OSRM_FI_NEAREST, OSRM_PUBLIC_NEAREST, suffix, parseNearestResponse, true, 'osrm nearest',
    );
}

// Snap a geometric via to the nearest road point within snapRadius km.
// Returns the snapped point, or the original if snapping fails or is too far.
async function snapToRoad(via, snapRadius = 0.5) {
    const snapped = await tryNearest(`${via.lng},${via.lat}?number=1`);
    if (!snapped) return via;
    const dist = haversineKm(via.lat, via.lng, snapped.lat, snapped.lng);
    return dist <= snapRadius ? snapped : via;
}

// Adapter for screenCandidates' tableFn contract: one OSRM /table call
// returns snap distance + route distance for every candidate at once,
// replacing N parallel /nearest + N parallel /route calls.
//
// `destinations[i].distance` is OSRM's snap distance for input coord i;
// `distances[0][i]` is the route distance from source[0] to coord i.
// Both arrays include source[0] at index 0, so candidate i lives at i+1.
//
// Same self-hosted → public fallback as tryOsrm/tryNearest, but this one
// keeps throwing if the public attempt also fails: screenCandidates
// (screening.js) has no try/catch around its tableFn call — the catch lives
// one level up, in destination-resolve.js — so swallowing to null here would
// hide a total OSRM outage as "no candidates survived screening".
async function screeningTableFn(start, candidates) {
    if (candidates.length === 0) return [];
    const coords = [
        `${start.lng},${start.lat}`,
        ...candidates.map(c => `${c.lng},${c.lat}`)
    ].join(';');
    const suffix = `${coords}?sources=0&annotations=distance`;
    return withOsrmFallback(OSRM_FI_TABLE, OSRM_PUBLIC_TABLE, suffix, (data) => {
        if (!data || data.code !== 'Ok') throw new Error(`osrm table ${data && data.code}`);
        const dests = data.destinations;
        const dists = data.distances && data.distances[0];
        if (!Array.isArray(dests) || !Array.isArray(dists)) {
            throw new Error('osrm table malformed');
        }
        return candidates.map((_, i) => {
            const d = dests[i + 1];
            const r = dists[i + 1];
            const snapM = d && typeof d.distance === 'number' ? d.distance : null;
            const routeM = typeof r === 'number' ? r : null;
            return { snapM, routeM };
        });
    }, false, 'osrm table');
}

// Explicit globalThis exports, resolved from the global scope at call time by
// loop-builders.js, destination-resolve.js (screeningTableFn) and route-view.js
// (isSelfHostedDown).
globalThis.OSRM_FI_BASE = OSRM_FI_BASE;
globalThis.OSRM_FI_NEAREST = OSRM_FI_NEAREST;
globalThis.OSRM_FI_TABLE = OSRM_FI_TABLE;
globalThis.OSRM_PUBLIC_BASE = OSRM_PUBLIC_BASE;
globalThis.OSRM_PUBLIC_NEAREST = OSRM_PUBLIC_NEAREST;
globalThis.OSRM_PUBLIC_TABLE = OSRM_PUBLIC_TABLE;
globalThis.SELF_HOSTED_RETRY_MS = SELF_HOSTED_RETRY_MS;
globalThis.PUBLIC_MIN_GAP_MS = PUBLIC_MIN_GAP_MS;
globalThis.isSelfHostedDown = isSelfHostedDown;
globalThis.resetOsrmFallbackState = resetOsrmFallbackState;
globalThis.tryOsrm = tryOsrm;
globalThis.fetchRouteThrough = fetchRouteThrough;
globalThis.tryNearest = tryNearest;
globalThis.snapToRoad = snapToRoad;
globalThis.screeningTableFn = screeningTableFn;
